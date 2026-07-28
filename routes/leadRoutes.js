import { Router } from 'express';
import Lead from '../models/Lead.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/leads — list
router.get('/', requirePermission('lead.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority, assignedTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ name: r }, { phone: r }, { businessName: r }, { leadNumber: r }]; }
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (assignedTo) filter.assignedTo = assignedTo;
    const [data, total] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('assignedTo', 'name').lean(),
      Lead.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/leads/stats
router.get('/stats', requirePermission('lead.management'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const [total, newLeads, contacted, won, lost, hot, overdueFollowups] = await Promise.all([
      Lead.countDocuments(),
      Lead.countDocuments({ status: 'new' }),
      Lead.countDocuments({ status: 'contacted' }),
      Lead.countDocuments({ status: 'won' }),
      Lead.countDocuments({ status: 'lost' }),
      Lead.countDocuments({ priority: 'hot', status: { $nin: ['won', 'lost'] } }),
      Lead.countDocuments({ nextFollowupDate: { $lt: today }, status: { $nin: ['won', 'lost'] } }),
    ]);
    const totalValue = await Lead.aggregate([
      { $match: { status: { $nin: ['lost'] } } },
      { $group: { _id: null, total: { $sum: '$estimatedValue' } } },
    ]);
    res.json({ success: true, data: { total, newLeads, contacted, won, lost, hot, overdueFollowups, totalPipelineValue: totalValue[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/leads/due-today — followups due today
router.get('/due-today', requirePermission('lead.management'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const leads = await Lead.find({
      nextFollowupDate: { $gte: today, $lt: tomorrow },
      status: { $nin: ['won', 'lost'] },
    }).populate('assignedTo', 'name').sort({ priority: -1 }).lean();
    res.json({ success: true, data: leads });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/leads/:id
router.get('/:id', requirePermission('lead.management'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate('assignedTo', 'name phone')
      .populate('followups.doneBy', 'name').lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/leads — create
router.post('/', requirePermission('lead.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Lead.countDocuments();
    data.leadNumber = `LD-${String(count + 1).padStart(5, '0')}`;
    const lead = await Lead.create(data);
    res.status(201).json({ success: true, message: `Lead ${lead.leadNumber} created.`, data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/v1/leads/:id — update
router.put('/:id', requirePermission('lead.management'), async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!lead) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Lead updated.', data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/leads/:id/followup — add followup
router.post('/:id/followup', requirePermission('lead.management'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Not found.' });
    lead.followups.push({ ...req.body, doneBy: req.user._id });
    if (req.body.nextFollowupDate) lead.nextFollowupDate = req.body.nextFollowupDate;
    if (req.body.outcome === 'converted') { lead.status = 'won'; lead.convertedAt = new Date(); }
    else if (req.body.outcome === 'not_interested') lead.status = 'lost';
    await lead.save();
    res.json({ success: true, message: 'Follow-up recorded.', data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/leads/:id/status
router.patch('/:id/status', requirePermission('lead.management'), async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, { status: req.body.status, lostReason: req.body.lostReason }, { new: true });
    res.json({ success: true, message: `Status → ${req.body.status}`, data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
