import { Router } from 'express';
import SupplierScheme from '../models/SupplierScheme.js';
import DealerScheme from '../models/DealerScheme.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ══════════════════════════════
// SUPPLIER SCHEMES
// ══════════════════════════════
router.get('/supplier', requirePermission('scheme.entry'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page)), l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ schemeNumber: r }, { schemeName: r }, { supplierName: r }]; }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const [data, total] = await Promise.all([
      SupplierScheme.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('supplier', 'companyName supplierCode').lean(),
      SupplierScheme.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/supplier/stats', requirePermission('scheme.entry'), async (req, res) => {
  try {
    const [total, active, claimed] = await Promise.all([
      SupplierScheme.countDocuments(),
      SupplierScheme.countDocuments({ status: 'active' }),
      SupplierScheme.countDocuments({ status: 'claimed' }),
    ]);
    const totalEarned = await SupplierScheme.aggregate([{ $group: { _id: null, total: { $sum: '$totalIncentiveEarned' } } }]);
    res.json({ success: true, data: { total, active, claimed, totalEarned: totalEarned[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/supplier', requirePermission('scheme.entry'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await SupplierScheme.countDocuments();
    data.schemeNumber = `SS-${String(count + 1).padStart(5, '0')}`;
    if (data.supplier) {
      const s = await Supplier.findById(data.supplier).lean();
      if (s) data.supplierName = s.companyName;
    }
    const scheme = await SupplierScheme.create(data);
    res.status(201).json({ success: true, message: `Scheme ${scheme.schemeNumber} created.`, data: scheme });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/supplier/:id/claim', requirePermission('claim.submission'), async (req, res) => {
  try {
    const s = await SupplierScheme.findByIdAndUpdate(req.params.id, {
      status: 'claimed', claimSubmittedDate: new Date(),
      totalClaimAmount: req.body.claimAmount || 0,
    }, { new: true });
    res.json({ success: true, message: 'Claim submitted.', data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/supplier/:id/settle', requirePermission('scheme.entry'), async (req, res) => {
  try {
    const s = await SupplierScheme.findByIdAndUpdate(req.params.id, {
      status: 'closed', claimSettledDate: new Date(),
      claimSettledAmount: req.body.settledAmount || 0,
    }, { new: true });
    res.json({ success: true, message: 'Scheme settled.', data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════
// DEALER SCHEMES
// ══════════════════════════════
router.get('/dealer', requirePermission('scheme.analysis'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const p = Math.max(1, parseInt(page)), l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (status) filter.status = status;
    const [data, total] = await Promise.all([
      DealerScheme.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).lean(),
      DealerScheme.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/dealer', requirePermission('scheme.analysis'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await DealerScheme.countDocuments();
    data.schemeNumber = `DS-${String(count + 1).padStart(5, '0')}`;
    const scheme = await DealerScheme.create(data);
    res.status(201).json({ success: true, message: `Dealer Scheme ${scheme.schemeNumber} created.`, data: scheme });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/dealer/:id/status', requirePermission('scheme.analysis'), async (req, res) => {
  try {
    const s = await DealerScheme.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    res.json({ success: true, message: `Status → ${req.body.status}`, data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
