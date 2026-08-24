import { Router } from 'express';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import { protect, requirePermission, getDataAccessFilter } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ═══════════════════════════════════════
// GET /api/v1/leads — list leads (with data access control)
// ═══════════════════════════════════════
router.get('/', requirePermission('lead.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, customerType, assignedTo, assignmentStatus, priority, sortBy = 'queue' } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    // Apply data access restriction (non-admin may only see recent data)
    const accessFilter = await getDataAccessFilter(req.user, 'lead');

    let filter = { ...accessFilter };
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ leadNumber: r }, { name: r }, { phone: r }, { businessName: r }, { city: r }];
    }
    if (status) filter.status = status;
    if (customerType) filter.customerType = customerType;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (assignmentStatus) filter.assignmentStatus = assignmentStatus;
    if (priority) filter.priority = priority;

    // If SE user, only show their assigned leads
    if (req.user.role === 'sales_executive') {
      filter.assignedTo = req.user._id;
    }

    // Sort: queue mode shows unassigned first, then by priority
    let sort;
    if (sortBy === 'queue') {
      sort = { assignmentStatus: 1, priority: -1, createdAt: -1 }; // unassigned first
    } else {
      sort = { createdAt: -1 };
    }

    const [data, total] = await Promise.all([
      Lead.find(filter).sort(sort).skip((p - 1) * l).limit(l)
        .populate('assignedTo', 'name phone role')
        .populate('createdBy', 'name')
        .lean(),
      Lead.countDocuments(filter),
    ]);

    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// GET /api/v1/leads/stats
// ═══════════════════════════════════════
router.get('/stats', requirePermission('lead.management'), async (req, res) => {
  try {
    const accessFilter = await getDataAccessFilter(req.user, 'lead');
    const baseFilter = req.user.role === 'sales_executive' ? { ...accessFilter, assignedTo: req.user._id } : accessFilter;

    const [total, unassigned, pending, accepted, contacted, won, lost, hotLeads] = await Promise.all([
      Lead.countDocuments(baseFilter),
      Lead.countDocuments({ ...baseFilter, assignmentStatus: 'unassigned' }),
      Lead.countDocuments({ ...baseFilter, assignmentStatus: 'pending' }),
      Lead.countDocuments({ ...baseFilter, assignmentStatus: 'accepted' }),
      Lead.countDocuments({ ...baseFilter, status: 'contacted' }),
      Lead.countDocuments({ ...baseFilter, status: 'won' }),
      Lead.countDocuments({ ...baseFilter, status: 'lost' }),
      Lead.countDocuments({ ...baseFilter, priority: 'hot' }),
    ]);

    // Today's new leads
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayLeads = await Lead.countDocuments({ ...baseFilter, createdAt: { $gte: today } });

    res.json({ success: true, data: { total, unassigned, pending, accepted, contacted, won, lost, hotLeads, todayLeads } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// GET /api/v1/leads/se-status — get all SEs with their current availability
// ═══════════════════════════════════════
router.get('/se-status', requirePermission('lead.management'), async (req, res) => {
  try {
    // Get all sales executives
    const ses = await User.find({ role: 'sales_executive', status: 'Active' })
      .select('name phone assignedRegions').lean();

    // Get current lead load per SE
    const leadCounts = await Lead.aggregate([
      { $match: { assignmentStatus: { $in: ['pending', 'accepted'] }, status: { $nin: ['won', 'lost'] } } },
      { $group: { _id: '$assignedTo', activeLeads: { $sum: 1 }, pendingResponse: { $sum: { $cond: [{ $eq: ['$assignmentStatus', 'pending'] }, 1, 0] } } } },
    ]);
    const countMap = {};
    leadCounts.forEach(c => { countMap[String(c._id)] = c; });

    const enriched = ses.map(se => ({
      ...se,
      activeLeads: countMap[String(se._id)]?.activeLeads || 0,
      pendingResponse: countMap[String(se._id)]?.pendingResponse || 0,
      isBusy: (countMap[String(se._id)]?.activeLeads || 0) >= 10, // busy if 10+ active leads
    }));

    res.json({ success: true, data: enriched });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// GET /api/v1/leads/my-leads — SE's own leads (for mobile app)
// Must be BEFORE /:id to avoid route conflict
// ═══════════════════════════════════════
router.get('/my-leads', async (req, res) => {
  try {
    const leads = await Lead.find({
      assignedTo: req.user._id,
      status: { $nin: ['won', 'lost'] },
    }).sort({ assignmentStatus: 1, priority: -1, nextFollowupDate: 1 })
      .select('leadNumber name phone customerType priority status assignmentStatus nextFollowupDate city estimatedValue')
      .lean();

    const pendingAcceptance = leads.filter(l => l.assignmentStatus === 'pending');
    const active = leads.filter(l => l.assignmentStatus === 'accepted');

    res.json({ success: true, data: { pendingAcceptance, active, total: leads.length } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// GET /api/v1/leads/:id
// ═══════════════════════════════════════
router.get('/:id', requirePermission('lead.management'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate('assignedTo', 'name phone role')
      .populate('createdBy', 'name')
      .populate('followups.doneBy', 'name')
      .populate('assignmentHistory.assignedTo', 'name')
      .populate('assignmentHistory.assignedBy', 'name')
      .lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
    res.json({ success: true, data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// POST /api/v1/leads — create lead
// ═══════════════════════════════════════
router.post('/', requirePermission('lead.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id, createdByName: req.user.name };
    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    data.leadNumber = await generateUniqueCode(Lead, 'leadNumber', 'LD-', 5);

    const lead = await Lead.create(data);
    res.status(201).json({ success: true, message: `Lead ${lead.leadNumber} created.`, data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PUT /api/v1/leads/:id — update lead
// ═══════════════════════════════════════
router.put('/:id', requirePermission('lead.management'), async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('assignedTo', 'name phone');
    if (!lead) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Lead updated.', data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PATCH /api/v1/leads/:id/assign — assign lead to SE
// ═══════════════════════════════════════
router.patch('/:id/assign', requirePermission('lead.management'), async (req, res) => {
  try {
    const { assignedTo } = req.body;
    if (!assignedTo) return res.status(400).json({ success: false, message: 'Sales Executive ID required.' });

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    const se = await User.findById(assignedTo).select('name phone role').lean();
    if (!se) return res.status(404).json({ success: false, message: 'Sales Executive not found.' });

    // Add to assignment history
    lead.assignmentHistory.push({
      assignedTo,
      assignedToName: se.name,
      assignedBy: req.user._id,
      assignedByName: req.user.name,
      assignedAt: new Date(),
      response: 'pending',
    });

    // Update current assignment
    lead.assignedTo = assignedTo;
    lead.assignedToName = se.name;
    lead.assignmentStatus = 'pending';
    lead.assignedAt = new Date();
    lead.status = lead.status === 'new' ? 'assigned' : lead.status;

    await lead.save();

    // TODO: Send push notification to SE via FCM
    // TODO: Send WhatsApp notification to SE

    res.json({ success: true, message: `Lead assigned to ${se.name}. Awaiting acceptance.`, data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PATCH /api/v1/leads/:id/accept — SE accepts the lead
// ═══════════════════════════════════════
router.patch('/:id/accept', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    // Verify this SE is the assigned one
    if (String(lead.assignedTo) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'This lead is not assigned to you.' });
    }
    if (lead.assignmentStatus !== 'pending') {
      return res.status(400).json({ success: false, message: `Lead already ${lead.assignmentStatus}.` });
    }

    lead.assignmentStatus = 'accepted';
    lead.acceptedAt = new Date();
    lead.status = 'contacted';

    // Update history
    const lastAssignment = lead.assignmentHistory[lead.assignmentHistory.length - 1];
    if (lastAssignment) {
      lastAssignment.response = 'accepted';
      lastAssignment.respondedAt = new Date();
    }

    await lead.save();
    res.json({ success: true, message: 'Lead accepted. You can now follow up.', data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PATCH /api/v1/leads/:id/decline — SE declines the lead
// ═══════════════════════════════════════
router.patch('/:id/decline', async (req, res) => {
  try {
    const { reason } = req.body;
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    if (String(lead.assignedTo) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'This lead is not assigned to you.' });
    }
    if (lead.assignmentStatus !== 'pending') {
      return res.status(400).json({ success: false, message: `Lead already ${lead.assignmentStatus}.` });
    }

    lead.assignmentStatus = 'declined';
    lead.declinedAt = new Date();
    lead.declineReason = reason || '';
    lead.assignedTo = null;
    lead.assignedToName = '';

    // Update history
    const lastAssignment = lead.assignmentHistory[lead.assignmentHistory.length - 1];
    if (lastAssignment) {
      lastAssignment.response = 'declined';
      lastAssignment.respondedAt = new Date();
      lastAssignment.declineReason = reason || '';
    }

    // Reset to unassigned for re-assignment
    lead.assignmentStatus = 'unassigned';
    lead.status = 'new';

    await lead.save();

    // TODO: Notify admin/manager that SE declined

    res.json({ success: true, message: 'Lead declined. It will be reassigned.', data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PATCH /api/v1/leads/:id/followup — add follow-up entry
// ═══════════════════════════════════════
router.patch('/:id/followup', async (req, res) => {
  try {
    const { notes, outcome, nextFollowupDate } = req.body;
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Not found.' });

    lead.followups.push({
      notes,
      outcome: outcome || 'callback',
      nextFollowupDate,
      doneBy: req.user._id,
      doneByName: req.user.name,
    });
    lead.nextFollowupDate = nextFollowupDate || null;
    lead.lastContactDate = new Date();
    lead.totalFollowups = (lead.totalFollowups || 0) + 1;

    // Auto-update status based on outcome
    if (outcome === 'converted') lead.status = 'won';
    else if (outcome === 'not_interested') lead.status = 'lost';
    else if (outcome === 'interested' && lead.status === 'contacted') lead.status = 'qualified';

    await lead.save();
    res.json({ success: true, message: 'Follow-up recorded.', data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PATCH /api/v1/leads/:id/status — update lead status
// ═══════════════════════════════════════
router.patch('/:id/status', requirePermission('lead.management'), async (req, res) => {
  try {
    const { status, lostReason } = req.body;
    const update = { status };
    if (status === 'lost' && lostReason) update.lostReason = lostReason;
    if (status === 'won') update.convertedAt = new Date();
    const lead = await Lead.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!lead) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: `Status → ${status}`, data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PATCH /api/v1/leads/:id/convert — convert to dealer/customer
// ═══════════════════════════════════════
router.patch('/:id/convert', requirePermission('lead.management'), async (req, res) => {
  try {
    const { convertTo, conversionValue } = req.body; // convertTo: 'dealer' or 'customer'
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Not found.' });

    lead.status = 'won';
    lead.convertedAt = new Date();
    lead.conversionValue = conversionValue || lead.estimatedValue || 0;

    // Calculate incentive (e.g., 1% of conversion value)
    if (lead.assignedTo && lead.conversionValue > 0) {
      lead.incentiveEligible = true;
      lead.incentiveAmount = Math.round(lead.conversionValue * 0.01); // 1% default
    }

    await lead.save();
    res.json({ success: true, message: 'Lead converted! Incentive calculated.', data: lead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// DELETE
// ═══════════════════════════════════════
router.delete('/:id', requirePermission('lead.management'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Lead, req.params.id, { user: req.user, module: 'lead', titleField: 'name', codeField: 'leadNumber', skipDependencyCheck: true });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
