import { Router } from 'express';
import Invoice from '../models/Invoice.js';
import SalesOrder from '../models/SalesOrder.js';
import Dealer from '../models/Dealer.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// Number to words (Indian format)
function numberToWords(num) {
  if (num === 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const convert = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convert(n % 100) : '');
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '');
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '');
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '');
  };
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  let result = convert(rupees) + ' Rupees';
  if (paise > 0) result += ' and ' + convert(paise) + ' Paise';
  return result + ' Only';
}

// GET /api/v1/invoices — list invoices
router.get('/', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, invoiceType, dealer, dateFrom, dateTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ invoiceNumber: regex }, { buyerName: regex }, { buyerCode: regex }, { orderNumber: regex }];
    }
    if (status) filter.status = status;
    if (invoiceType) filter.invoiceType = invoiceType;
    if (dealer) filter.dealer = dealer;
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo);
    }

    const [invoices, total] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('createdBy', 'name')
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    res.json({ success: true, data: invoices, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/invoices/stats
router.get('/stats', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const [total, generated, sent, cancelled, totalValue] = await Promise.all([
      Invoice.countDocuments(),
      Invoice.countDocuments({ status: 'generated' }),
      Invoice.countDocuments({ status: 'sent' }),
      Invoice.countDocuments({ status: 'cancelled' }),
      Invoice.aggregate([{ $match: { status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
    ]);
    res.json({ success: true, data: { total, generated, sent, cancelled, totalValue: totalValue[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/invoices/generate-from-so/:soId — generate invoice from Sales Order
router.post('/generate-from-so/:soId', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const so = await SalesOrder.findById(req.params.soId)
      .populate('dealer', 'businessName dealerCode gstin pan address city state mobile')
      .populate('items.product', 'productCode itemName hsnCode images piecesPerBox sqftPerBox')
      .lean();

    if (!so) return res.status(404).json({ success: false, message: 'Sales Order not found.' });
    if (!['confirmed', 'processing', 'dispatched', 'delivered'].includes(so.status)) {
      return res.status(400).json({ success: false, message: `Cannot generate invoice for "${so.status}" order.` });
    }

    // Check if invoice already exists for this SO
    const existing = await Invoice.findOne({ salesOrder: so._id, status: { $ne: 'cancelled' } }).lean();
    if (existing) {
      return res.status(400).json({ success: false, message: `Invoice ${existing.invoiceNumber} already exists for this order.` });
    }

    // Generate invoice number (checks recycle bin too)
    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    const invoiceNumber = await generateUniqueCode(Invoice, 'invoiceNumber', 'INV-', 6);

    // Build invoice items with full details
    const items = so.items.map(item => {
      const prod = item.product || {};
      const qty = item.quantity || 0;
      const rate = item.rate || 0;
      const baseAmount = qty * rate;

      let discountAmt = 0;
      if (item.discountType === 'percentage') {
        discountAmt = (baseAmount * (item.discount || 0)) / 100;
      } else {
        discountAmt = (item.discount || 0) * qty;
      }

      const taxable = baseAmount - discountAmt - (item.schemeDiscount || 0);
      const gstPct = item.gstPercentage || 18;
      const gstAmt = (taxable * gstPct) / 100;

      // Determine CGST/SGST vs IGST based on inter-state flag (set later)
      // For now calculate both — we'll choose which to use based on state comparison
      const halfGst = gstAmt / 2;

      return {
        product: prod._id || item.product,
        productCode: item.productCode || prod.productCode || '',
        productName: item.productName || prod.itemName || '',
        productImage: item.productImage || prod.images?.[0] || '',
        hsnCode: prod.hsnCode || '',
        shade: item.shade || '',
        batch: item.batch || '',
        quantity: qty,
        unit: item.unit || 'Box',
        boxes: item.boxes || qty,
        pieces: item.pieces || (qty * (prod.piecesPerBox || 0)),
        sqft: item.sqft || (qty * (prod.sqftPerBox || 0)),
        rate,
        discount: item.discount || 0,
        discountType: item.discountType || 'flat',
        discountAmount: Math.round(discountAmt * 100) / 100,
        schemeDiscount: item.schemeDiscount || 0,
        taxableAmount: Math.round(taxable * 100) / 100,
        gstPercentage: gstPct,
        cgst: Math.round(halfGst * 100) / 100,
        sgst: Math.round(halfGst * 100) / 100,
        igst: 0, // Will be set if inter-state
        gstAmount: Math.round(gstAmt * 100) / 100,
        totalAmount: Math.round((taxable + gstAmt) * 100) / 100,
      };
    });

    // Determine if inter-state (buyer state different from seller state)
    const sellerState = 'Karnataka'; // TODO: Load from company settings
    const buyerState = so.dealer?.state || '';
    const isInterState = buyerState && buyerState.toLowerCase() !== sellerState.toLowerCase();

    // If inter-state, convert CGST+SGST to IGST
    if (isInterState) {
      items.forEach(item => {
        item.igst = item.gstAmount;
        item.cgst = 0;
        item.sgst = 0;
      });
    }

    const taxableTotal = items.reduce((s, i) => s + i.taxableAmount, 0);
    const totalCgst = items.reduce((s, i) => s + i.cgst, 0);
    const totalSgst = items.reduce((s, i) => s + i.sgst, 0);
    const totalIgst = items.reduce((s, i) => s + i.igst, 0);
    const totalTax = totalCgst + totalSgst + totalIgst;
    const totalDiscount = items.reduce((s, i) => s + i.discountAmount, 0);
    const totalSchemeDiscount = items.reduce((s, i) => s + i.schemeDiscount, 0);

    const chargesTotal = (so.freightCharges || 0) + (so.loadingCharges || 0) + (so.installationCharges || 0) + (so.otherCharges || 0);
    const rawGrand = taxableTotal + totalTax + chargesTotal;
    const grandTotal = Math.round(rawGrand);
    const roundOff = grandTotal - rawGrand;

    const invoice = await Invoice.create({
      invoiceNumber,
      invoiceDate: new Date(),
      invoiceType: 'tax_invoice',
      gstType: 'output', // Sales invoice = Output GST
      isInterState,
      salesOrder: so._id,
      orderNumber: so.orderNumber,

      // Buyer
      buyerType: so.orderType || 'dealer',
      dealer: so.dealer?._id,
      buyerName: so.dealerName || so.customerName || '',
      buyerCode: so.dealerCode || '',
      buyerGstin: so.dealer?.gstin || '',
      buyerPan: so.dealer?.pan || '',
      buyerAddress: so.dealer?.address || '',
      buyerCity: so.dealer?.city || '',
      buyerState: so.dealer?.state || '',
      buyerPhone: so.dealer?.mobile || so.customerPhone || '',
      deliveryAddress: so.deliveryAddress || '',

      // Items
      items,

      // Totals
      subtotal: Math.round(items.reduce((s, i) => s + (i.quantity * i.rate), 0) * 100) / 100,
      totalDiscount: Math.round(totalDiscount * 100) / 100,
      totalSchemeDiscount: Math.round(totalSchemeDiscount * 100) / 100,
      taxableTotal: Math.round(taxableTotal * 100) / 100,
      totalCgst: Math.round(totalCgst * 100) / 100,
      totalSgst: Math.round(totalSgst * 100) / 100,
      totalIgst: Math.round(totalIgst * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      freightCharges: so.freightCharges || 0,
      loadingCharges: so.loadingCharges || 0,
      installationCharges: so.installationCharges || 0,
      otherCharges: so.otherCharges || 0,
      roundOff: Math.round(roundOff * 100) / 100,
      grandTotal,
      amountInWords: numberToWords(grandTotal),

      // Payment
      balanceAmount: grandTotal,
      paymentStatus: 'pending',

      // Status
      status: 'generated',
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, message: `Invoice ${invoiceNumber} generated.`, data: invoice });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/invoices/:id — get single invoice (full detail for PDF)
router.get('/:id', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode gstin address city state mobile')
      .populate('salesOrder', 'orderNumber orderDate')
      .populate('createdBy', 'name')
      .lean();
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    res.json({ success: true, data: invoice });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/invoices/:id/status — mark as sent/cancelled
router.patch('/:id/status', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const { status, cancelReason } = req.body;
    const update = { status };
    if (status === 'cancelled' && cancelReason) update.cancelReason = cancelReason;
    const invoice = await Invoice.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!invoice) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: `Invoice ${status}.`, data: invoice });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE — not allowed for generated invoices, only draft
router.delete('/:id', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Not found.' });
    if (invoice.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only draft invoices can be deleted. Cancel generated invoices instead.' });
    }
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Invoice, req.params.id, { user: req.user, module: 'invoice', titleField: 'buyerName', codeField: 'invoiceNumber' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
