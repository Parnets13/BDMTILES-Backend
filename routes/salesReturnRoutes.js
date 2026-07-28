import { Router } from 'express';
import SalesReturn from '../models/SalesReturn.js';
import SalesOrder from '../models/SalesOrder.js';
import Stock from '../models/Stock.js';
import Dealer from '../models/Dealer.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/sales-returns — list
router.get('/', requirePermission('credit.note'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealer } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ returnNumber: r }, { dealerName: r }, { orderNumber: r }];
    }
    if (status) filter.status = status;
    if (dealer) filter.dealer = dealer;

    const [returns, total] = await Promise.all([
      SalesReturn.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('salesOrder', 'orderNumber grandTotal')
        .lean(),
      SalesReturn.countDocuments(filter),
    ]);
    res.json({ success: true, data: returns, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/sales-returns/stats
router.get('/stats', requirePermission('credit.note'), async (req, res) => {
  try {
    const [total, draft, approved, creditIssued, cancelled] = await Promise.all([
      SalesReturn.countDocuments(),
      SalesReturn.countDocuments({ status: 'draft' }),
      SalesReturn.countDocuments({ status: 'approved' }),
      SalesReturn.countDocuments({ status: 'credit_issued' }),
      SalesReturn.countDocuments({ status: 'cancelled' }),
    ]);
    const totalValue = await SalesReturn.aggregate([
      { $match: { status: { $nin: ['cancelled', 'draft'] } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]);
    res.json({ success: true, data: { total, draft, approved, creditIssued, cancelled, totalReturnValue: totalValue[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/sales-returns/:id
router.get('/:id', requirePermission('credit.note'), async (req, res) => {
  try {
    const sr = await SalesReturn.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode mobile city')
      .populate('salesOrder', 'orderNumber orderDate grandTotal items')
      .populate('items.product', 'productCode itemName tileSize')
      .populate('items.warehouse', 'name')
      .lean();
    if (!sr) return res.status(404).json({ success: false, message: 'Sales Return not found.' });
    res.json({ success: true, data: sr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/sales-returns — create
router.post('/', requirePermission('credit.note'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };

    // Auto-generate return number
    const count = await SalesReturn.countDocuments();
    data.returnNumber = `SR-${String(count + 1).padStart(5, '0')}`;

    // Fetch dealer info
    if (data.dealer) {
      const dealer = await Dealer.findById(data.dealer).lean();
      if (dealer) {
        data.dealerName = dealer.businessName;
        data.dealerCode = dealer.dealerCode;
      }
    }

    // Fetch SO info
    if (data.salesOrder) {
      const so = await SalesOrder.findById(data.salesOrder).lean();
      if (so) data.orderNumber = so.orderNumber;
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

    // Auto-generate credit note number
    data.creditNoteNumber = `CN-${String(count + 1).padStart(5, '0')}`;
    data.creditNoteDate = new Date();
    data.tallySyncStatus = 'not_synced';

    const sr = await SalesReturn.create(data);
    res.status(201).json({ success: true, message: 'Sales Return created.', data: sr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/sales-returns/:id/approve — approve & update stock
router.patch('/:id/approve', requirePermission('credit.note'), async (req, res) => {
  try {
    const sr = await SalesReturn.findById(req.params.id);
    if (!sr) return res.status(404).json({ success: false, message: 'Not found.' });
    if (sr.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft returns can be approved.' });

    sr.status = 'approved';
    sr.approvedBy = req.user._id;
    sr.approvalDate = new Date();
    sr.approvalRemarks = req.body.remarks || '';
    await sr.save();

    // Update stock — add back resaleable items
    for (const item of sr.items) {
      if (item.condition === 'resaleable' && item.returnQty > 0) {
        await Stock.findOneAndUpdate(
          { product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '' },
          { $inc: { totalQty: item.returnQty, availableQty: item.returnQty } },
          { upsert: true, new: true }
        );
      } else if (item.condition === 'damaged' && item.returnQty > 0) {
        await Stock.findOneAndUpdate(
          { product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '' },
          { $inc: { totalQty: item.returnQty, damagedQty: item.returnQty } },
          { upsert: true, new: true }
        );
      }
    }

    sr.status = 'stock_updated';
    await sr.save();

    // Update dealer outstanding (reduce)
    if (sr.dealer && sr.adjustmentType === 'credit_note') {
      await Dealer.findByIdAndUpdate(sr.dealer, { $inc: { currentOutstanding: -sr.grandTotal } });
    }

    sr.status = 'credit_issued';
    await sr.save();

    res.json({ success: true, message: 'Sales Return approved. Stock updated. Credit note issued.', data: sr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/sales-returns/:id/cancel
router.patch('/:id/cancel', requirePermission('credit.note'), async (req, res) => {
  try {
    const sr = await SalesReturn.findByIdAndUpdate(req.params.id, { status: 'cancelled' }, { new: true });
    res.json({ success: true, message: 'Sales Return cancelled.', data: sr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/sales-returns/orders-for-dealer/:dealerId — get SO list for returns
router.get('/orders-for-dealer/:dealerId', requirePermission('credit.note'), async (req, res) => {
  try {
    const orders = await SalesOrder.find({
      dealer: req.params.dealerId,
      status: { $in: ['confirmed', 'processing', 'dispatched', 'delivered'] },
    }).select('orderNumber orderDate grandTotal items status').sort({ orderDate: -1 }).limit(50).lean();
    res.json({ success: true, data: orders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
