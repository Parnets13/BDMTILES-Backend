import { Router } from 'express';
import Complaint from '../models/Complaint.js';
import Dealer from '../models/Dealer.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/complaints
router.get('/', requirePermission('complaint.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority, category } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ complaintNumber: r }, { dealerName: r }, { orderNumber: r }]; }
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;
    const [data, total] = await Promise.all([
      Complaint.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('assignedTo', 'name').lean(),
      Complaint.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/complaints/stats
router.get('/stats', requirePermission('complaint.management'), async (req, res) => {
  try {
    const [total, open, inProgress, resolved, closed, critical] = await Promise.all([
      Complaint.countDocuments(),
      Complaint.countDocuments({ status: 'open' }),
      Complaint.countDocuments({ status: 'in_progress' }),
      Complaint.countDocuments({ status: 'resolved' }),
      Complaint.countDocuments({ status: 'closed' }),
      Complaint.countDocuments({ priority: 'critical', status: { $nin: ['resolved', 'closed', 'rejected'] } }),
    ]);
    res.json({ success: true, data: { total, open, inProgress, resolved, closed, critical } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/complaints/:id
router.get('/:id', requirePermission('complaint.management'), async (req, res) => {
  try {
    const c = await Complaint.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode mobile')
      .populate('assignedTo', 'name')
      .populate('resolutionHistory.resolvedBy', 'name').lean();
    if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/complaints — create
router.post('/', requirePermission('complaint.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Complaint.countDocuments();
    data.complaintNumber = `CMP-${String(count + 1).padStart(5, '0')}`;
    if (data.dealer) {
      const d = await Dealer.findById(data.dealer).lean();
      if (d) data.dealerName = d.businessName;
    }
    const complaint = await Complaint.create(data);
    res.status(201).json({ success: true, message: `Complaint ${complaint.complaintNumber} raised.`, data: complaint });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/complaints/:id/resolve — add resolution step
router.patch('/:id/resolve', requirePermission('complaint.management'), async (req, res) => {
  try {
    const c = await Complaint.findById(req.params.id);
    if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
    c.resolutionHistory.push({ ...req.body, resolvedBy: req.user._id });
    c.status = req.body.closeComplaint ? 'closed' : 'resolved';
    c.resolutionNotes = req.body.notes;
    if (c.status === 'resolved' || c.status === 'closed') c.resolvedAt = new Date();
    if (req.body.creditNoteAmount) {
      c.creditNoteIssued = true;
      c.creditNoteAmount = req.body.creditNoteAmount;
    }
    await c.save();
    res.json({ success: true, message: 'Resolution recorded.', data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/complaints/:id/status
router.patch('/:id/status', requirePermission('complaint.management'), async (req, res) => {
  try {
    const c = await Complaint.findByIdAndUpdate(req.params.id,
      { status: req.body.status, assignedTo: req.body.assignedTo || undefined },
      { new: true }
    );
    res.json({ success: true, message: `Status → ${req.body.status}`, data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
