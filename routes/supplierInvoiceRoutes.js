import { Router } from 'express';
import mongoose from 'mongoose';
import Supplier from '../models/Supplier.js';
import GRN from '../models/GRN.js';
import { protect, requirePermission } from '../middleware/auth.js';

// Inline schema — no separate file needed for MVP
const supplierInvoiceSchema = new mongoose.Schema(
  {
    invoiceRefNumber: { type: String, unique: true },   // Our internal ref e.g. SINV-00001
    invoiceNumber: { type: String, required: true },     // Supplier's invoice number
    invoiceDate: { type: Date, default: Date.now },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: String,
    linkedGRNs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GRN' }],
    invoiceAmount: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    freightAmount: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    paymentTerms: { type: String, default: '' },
    dueDate: Date,
    status: { type: String, enum: ['draft', 'pending_verification', 'verified', 'paid', 'cancelled'], default: 'draft' },
    remarks: { type: String, default: '' },
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
supplierInvoiceSchema.index({ supplier: 1, invoiceDate: -1 });
supplierInvoiceSchema.index({ status: 1 });

const SupplierInvoice = mongoose.models.SupplierInvoice || mongoose.model('SupplierInvoice', supplierInvoiceSchema);

const router = Router();
router.use(protect);

// GET /api/v1/supplier-invoices
router.get('/', requirePermission('invoice'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ invoiceRefNumber: r }, { invoiceNumber: r }, { supplierName: r }]; }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;

    const [invoices, total] = await Promise.all([
      SupplierInvoice.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('supplier', 'companyName supplierCode').lean(),
      SupplierInvoice.countDocuments(filter),
    ]);
    res.json({ success: true, data: invoices, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/supplier-invoices/stats
router.get('/stats', requirePermission('invoice'), async (req, res) => {
  try {
    const [total, draft, pendingVerification, verified, paid, totalValue] = await Promise.all([
      SupplierInvoice.countDocuments(),
      SupplierInvoice.countDocuments({ status: 'draft' }),
      SupplierInvoice.countDocuments({ status: 'pending_verification' }),
      SupplierInvoice.countDocuments({ status: 'verified' }),
      SupplierInvoice.countDocuments({ status: 'paid' }),
      SupplierInvoice.aggregate([{ $match: { status: { $nin: ['cancelled'] } } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
    ]);
    res.json({ success: true, data: { total, draft, pendingVerification, verified, paid, totalValue: totalValue[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/supplier-invoices/available-grns?supplier=id
router.get('/available-grns', requirePermission('invoice'), async (req, res) => {
  try {
    const grns = await GRN.find({ supplier: req.query.supplier, status: { $in: ['approved', 'posted'] } })
      .select('grnNumber grnDate grandTotal').lean();
    res.json({ success: true, data: grns });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/supplier-invoices/:id
router.get('/:id', requirePermission('invoice'), async (req, res) => {
  try {
    const inv = await SupplierInvoice.findById(req.params.id)
      .populate('supplier', 'companyName supplierCode mobile')
      .populate('linkedGRNs', 'grnNumber grnDate')
      .lean();
    if (!inv) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: inv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/supplier-invoices
router.post('/', requirePermission('invoice'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await SupplierInvoice.countDocuments();
    data.invoiceRefNumber = `SINV-${String(count + 1).padStart(5, '0')}`;
    data.grandTotal = (data.invoiceAmount || 0) + (data.taxAmount || 0) + (data.freightAmount || 0) + (data.otherCharges || 0);
    if (data.supplier) {
      const sup = await Supplier.findById(data.supplier).lean();
      if (sup) data.supplierName = sup.companyName;
    }
    data.status = 'pending_verification';
    const inv = await SupplierInvoice.create(data);
    res.status(201).json({ success: true, message: 'Supplier invoice created.', data: inv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/supplier-invoices/:id/verify
router.patch('/:id/verify', requirePermission('invoice'), async (req, res) => {
  try {
    const inv = await SupplierInvoice.findByIdAndUpdate(req.params.id, { status: 'verified' }, { new: true });
    if (!inv) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Invoice verified.', data: inv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
