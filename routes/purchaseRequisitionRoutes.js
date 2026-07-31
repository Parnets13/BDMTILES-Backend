import { Router } from 'express';
import PurchaseRequisition from '../models/PurchaseRequisition.js';
import Warehouse from '../models/Warehouse.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET list
router.get('/', requirePermission('po.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search)   { const r = new RegExp(search, 'i'); filter.$or = [{ prNumber: r }, { requestedByName: r }, { department: r }]; }
    if (status)   filter.status = status;
    if (priority) filter.priority = priority;
    const [data, total] = await Promise.all([
      PurchaseRequisition.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('warehouse', 'name').lean(),
      PurchaseRequisition.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET stats
router.get('/stats', requirePermission('po.management'), async (req, res) => {
  try {
    const [total, submitted, approved, rejected] = await Promise.all([
      PurchaseRequisition.countDocuments(),
      PurchaseRequisition.countDocuments({ status: 'submitted' }),
      PurchaseRequisition.countDocuments({ status: 'approved' }),
      PurchaseRequisition.countDocuments({ status: 'rejected' }),
    ]);
    res.json({ success: true, data: { total, submitted, approved, rejected } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET single
router.get('/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findById(req.params.id).populate('warehouse', 'name').lean();
    if (!pr) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST create
router.post('/', requirePermission('po.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id, requestedBy: req.user._id, requestedByName: req.user.name };
    const count = await PurchaseRequisition.countDocuments();
    data.prNumber = `PR-${String(count + 1).padStart(5, '0')}`;
    if (data.warehouse) {
      const wh = await Warehouse.findById(data.warehouse).lean();
      if (wh) data.warehouseName = wh.name;
    }
    const pr = await PurchaseRequisition.create(data);
    res.status(201).json({ success: true, message: `PR ${pr.prNumber} created.`, data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH approve
router.patch('/:id/approve', requirePermission('po.management'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findByIdAndUpdate(req.params.id, {
      status: 'approved', approvedBy: req.user._id,
      approvalNotes: req.body.notes || '', approvalDate: new Date(),
    }, { new: true });
    res.json({ success: true, message: 'PR approved.', data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH reject
router.patch('/:id/reject', requirePermission('po.management'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findByIdAndUpdate(req.params.id, {
      status: 'rejected', approvalNotes: req.body.notes || '', approvalDate: new Date(),
    }, { new: true });
    res.json({ success: true, message: 'PR rejected.', data: pr });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
