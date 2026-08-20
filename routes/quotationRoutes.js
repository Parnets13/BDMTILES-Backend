import { Router } from 'express';
import Quotation from '../models/Quotation.js';
import SalesOrder from '../models/SalesOrder.js';
import Dealer from '../models/Dealer.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ─── helpers ───────────────────────────────────────────────
function calcItems(items) {
  let subtotal = 0, totalDiscount = 0, totalTax = 0;
  const processed = items.map(item => {
    const qty = item.quantity || 0;
    const rate = item.rate || 0;
    const base = qty * rate;
    const discAmt = item.discountType === 'percentage'
      ? (base * (item.discount || 0)) / 100
      : (item.discount || 0) * qty;
    const taxable = base - discAmt;
    const gst = (taxable * (item.gstPercentage || 18)) / 100;
    subtotal += taxable;
    totalDiscount += discAmt;
    totalTax += gst;
    return {
      ...item,
      taxableAmount: +taxable.toFixed(2),
      gstAmount: +gst.toFixed(2),
      totalAmount: +(taxable + gst).toFixed(2),
    };
  });
  return { items: processed, subtotal, totalDiscount, totalTax };
}

// GET /api/v1/quotations — list
router.get('/', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealer } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ quotationNumber: r }, { dealerName: r }, { customerName: r }];
    }
    if (status) filter.status = status;
    if (dealer) filter.dealer = dealer;

    const [data, total] = await Promise.all([
      Quotation.find(filter)
        .sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode mobile')
        .lean(),
      Quotation.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/quotations/stats
router.get('/stats', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const [total, draft, sent, accepted, converted, expired, cancelled] = await Promise.all([
      Quotation.countDocuments(),
      Quotation.countDocuments({ status: 'draft' }),
      Quotation.countDocuments({ status: 'sent' }),
      Quotation.countDocuments({ status: 'accepted' }),
      Quotation.countDocuments({ status: 'converted' }),
      Quotation.countDocuments({ status: 'expired' }),
      Quotation.countDocuments({ status: 'cancelled' }),
    ]);
    const totalValue = await Quotation.aggregate([
      { $match: { status: { $nin: ['cancelled'] } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]);
    res.json({ success: true, data: { total, draft, sent, accepted, converted, expired, cancelled, totalValue: totalValue[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/quotations/:id
router.get('/:id', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const q = await Quotation.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode mobile city gstin')
      .populate('items.product', 'productCode itemName tileSize finish')
      .lean();
    if (!q) return res.status(404).json({ success: false, message: 'Quotation not found.' });
    res.json({ success: true, data: q });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/quotations — create
router.post('/', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const body = { ...req.body, createdBy: req.user._id };
    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    body.quotationNumber = await generateUniqueCode(Quotation, 'quotationNumber', 'QT-', 5);

    if (body.dealer) {
      const d = await Dealer.findById(body.dealer).lean();
      if (d) { body.dealerName = d.businessName; body.dealerCode = d.dealerCode; }
    }

    if (body.items?.length) {
      const { items, subtotal, totalDiscount, totalTax } = calcItems(body.items);
      body.items = items;
      body.subtotal = subtotal;
      body.totalDiscount = totalDiscount;
      body.totalTax = totalTax;
      body.grandTotal = Math.round(subtotal + totalTax + (body.freightCharges || 0) + (body.loadingCharges || 0) + (body.installationCharges || 0) + (body.otherCharges || 0));
    }

    // Default validity: 30 days from today
    if (!body.validUntil) {
      const v = new Date(); v.setDate(v.getDate() + 30);
      body.validUntil = v;
    }

    const q = await Quotation.create(body);
    res.status(201).json({ success: true, message: `Quotation ${q.quotationNumber} created.`, data: q });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/quotations/:id/status — update status (sent / accepted / cancelled)
router.patch('/:id/status', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { status } = req.body;
    const q = await Quotation.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!q) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: `Quotation marked as ${status}.`, data: q });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/quotations/:id/convert — convert quotation to Sales Order
router.post('/:id/convert', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const q = await Quotation.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode creditLimit currentOutstanding')
      .lean();
    if (!q) return res.status(404).json({ success: false, message: 'Not found.' });
    if (q.status === 'converted') return res.status(400).json({ success: false, message: 'Already converted.' });
    if (q.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot convert cancelled quotation.' });

    // Generate unique SO number (safe against recycle bin conflicts)
    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    const soNumber = await generateUniqueCode(SalesOrder, 'orderNumber', 'SO-', 5);

    // Credit limit check
    let creditLimitExceeded = false;
    let approvalStatus = 'not_required';
    if (q.dealer?.creditLimit > 0) {
      const outstanding = (q.dealer.currentOutstanding || 0) + (q.grandTotal || 0);
      if (outstanding > q.dealer.creditLimit) {
        creditLimitExceeded = true;
        approvalStatus = 'pending';
      }
    }

    // Map customer type to SO orderType
    const typeMap = { dealer: 'dealer', wholesaler: 'wholesaler', retail: 'retail', distributor: 'distributor', builder: 'builder' };
    const orderType = typeMap[q.customerType] || 'dealer';

    const so = await SalesOrder.create({
      orderNumber: soNumber,
      orderDate: new Date(),
      orderType,
      dealer: q.dealer?._id || undefined,
      dealerName: q.dealerName || q.customerName || '',
      dealerCode: q.dealerCode || '',
      customerName: q.customerName || '',
      customerPhone: q.customerPhone || '',
      items: q.items,
      subtotal: q.subtotal,
      totalDiscount: q.totalDiscount,
      totalTax: q.totalTax,
      freightCharges: q.freightCharges || 0,
      loadingCharges: q.loadingCharges || 0,
      installationCharges: q.installationCharges || 0,
      otherCharges: q.otherCharges || 0,
      grandTotal: q.grandTotal,
      balanceAmount: q.grandTotal,
      status: 'confirmed',
      remarks: `Converted from ${q.quotationNumber}. ${q.remarks || ''}`.trim(),
      tallySyncStatus: 'not_synced',
      creditLimitExceeded,
      approvalStatus,
      createdBy: req.user._id,
    });

    // Mark quotation as converted
    await Quotation.findByIdAndUpdate(q._id, {
      status: 'converted',
      convertedToSO: so._id,
      convertedAt: new Date(),
    });

    res.json({ success: true, message: `Converted to ${soNumber}.`, data: { quotation: q, salesOrder: so } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/v1/quotations/:id — draft/cancelled only
router.delete('/:id', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Quotation, req.params.id, {
      user: req.user,
      module: 'quotation',
      titleField: 'dealerName',
      codeField: 'quotationNumber',
    });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
