import { Router } from 'express';
import PurchaseReturn from '../models/PurchaseReturn.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/purchase-returns — list
router.get('/', requirePermission('debit.note'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ debitNoteNumber: r }, { supplierName: r }, { poNumber: r }, { grnNumber: r }];
    }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;

    const [returns, total] = await Promise.all([
      PurchaseReturn.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('supplier', 'companyName supplierCode')
        .lean(),
      PurchaseReturn.countDocuments(filter),
    ]);
    res.json({ success: true, data: returns, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/purchase-returns/stats
router.get('/stats', requirePermission('debit.note'), async (req, res) => {
  try {
    const [total, draft, approved, debitIssued, cancelled] = await Promise.all([
      PurchaseReturn.countDocuments(),
      PurchaseReturn.countDocuments({ status: 'draft' }),
      PurchaseReturn.countDocuments({ status: 'approved' }),
      PurchaseReturn.countDocuments({ status: 'debit_issued' }),
      PurchaseReturn.countDocuments({ status: 'cancelled' }),
    ]);
    const totalValue = await PurchaseReturn.aggregate([
      { $match: { status: { $nin: ['cancelled', 'draft'] } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]);
    res.json({ success: true, data: { total, draft, approved, debitIssued, cancelled, totalDebitValue: totalValue[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/purchase-returns/:id
router.get('/:id', requirePermission('debit.note'), async (req, res) => {
  try {
    const pr = await PurchaseReturn.findById(req.params.id)
      .populate('supplier', 'companyName supplierCode mobile')
      .populate('purchaseOrder', 'poNumber poDate')
      .populate('grn', 'grnNumber grnDate')
      .populate('items.product', 'productCode itemName tileSize')
      .populate('items.warehouse', 'name')
      .lean();
    if (!pr) return res.status(404).json({ success: false, message: 'Purchase Return not found.' });
    res.json({ success: true, data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/purchase-returns/grns-for-supplier/:supplierId
router.get('/grns-for-supplier/:supplierId', requirePermission('debit.note'), async (req, res) => {
  try {
    const grns = await GRN.find({
      supplier: req.params.supplierId,
      status: { $in: ['approved', 'posted'] },
    }).select('grnNumber grnDate poNumber items supplierInvoiceNo').sort({ grnDate: -1 }).limit(50).lean();
    res.json({ success: true, data: grns });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/purchase-returns — create
router.post('/', requirePermission('debit.note'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };

    // Auto-generate debit note number
    const count = await PurchaseReturn.countDocuments();
    data.debitNoteNumber = `DN-${String(count + 1).padStart(5, '0')}`;

    // Fetch supplier info
    if (data.supplier) {
      const sup = await Supplier.findById(data.supplier).lean();
      if (sup) data.supplierName = sup.companyName;
    }

    // Fetch PO/GRN info
    if (data.purchaseOrder) {
      const po = await PurchaseOrder.findById(data.purchaseOrder).lean();
      if (po) data.poNumber = po.poNumber;
    }
    if (data.grn) {
      const grn = await GRN.findById(data.grn).lean();
      if (grn) data.grnNumber = grn.grnNumber;
    }

    // Calculate totals
    if (data.items?.length) {
      let subtotal = 0, totalTax = 0;
      data.items = data.items.map(item => {
        const taxable = item.returnQty * item.rate;
        const gst = (taxable * (item.gstPercentage || 18)) / 100;
        subtotal += taxable;
        totalTax += gst;
        return { ...item, taxableAmount: taxable, gstAmount: gst, totalAmount: taxable + gst };
      });
      data.subtotal = Math.round(subtotal * 100) / 100;
      data.totalTax = Math.round(totalTax * 100) / 100;
      data.grandTotal = Math.round(subtotal + totalTax);
    }

    data.tallySyncStatus = 'not_synced';
    const pr = await PurchaseReturn.create(data);
    res.status(201).json({ success: true, message: 'Purchase Return (Debit Note) created.', data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/purchase-returns/:id/approve — approve & deduct stock
router.patch('/:id/approve', requirePermission('debit.note'), async (req, res) => {
  try {
    const pr = await PurchaseReturn.findById(req.params.id);
    if (!pr) return res.status(404).json({ success: false, message: 'Not found.' });
    if (pr.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft returns can be approved.' });

    pr.status = 'approved';
    pr.approvedBy = req.user._id;
    pr.approvalDate = new Date();
    pr.approvalRemarks = req.body.remarks || '';
    await pr.save();

    // Deduct stock
    for (const item of pr.items) {
      if (item.returnQty > 0) {
        await Stock.findOneAndUpdate(
          { product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '' },
          { $inc: { totalQty: -item.returnQty, availableQty: -item.returnQty } }
        );
      }
    }

    pr.status = 'stock_deducted';
    await pr.save();

    // Mark as debit issued
    pr.status = 'debit_issued';
    await pr.save();

    res.json({ success: true, message: 'Purchase Return approved. Stock deducted. Debit note issued.', data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/purchase-returns/:id/cancel
router.patch('/:id/cancel', requirePermission('debit.note'), async (req, res) => {
  try {
    const pr = await PurchaseReturn.findByIdAndUpdate(req.params.id, { status: 'cancelled' }, { new: true });
    res.json({ success: true, message: 'Purchase Return cancelled.', data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
