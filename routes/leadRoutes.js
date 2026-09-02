import mongoose from 'mongoose';
import { Router } from 'express';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import LeadActivity from '../models/LeadActivity.js';
import LeadVisit from '../models/LeadVisit.js';
import LeadExecutiveAvailability from '../models/LeadExecutiveAvailability.js';
import LeadOperationsSetting from '../models/LeadOperationsSetting.js';
import { protect, requirePermission, userHasPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { getLeadCreateScope, getLeadRecordPredicate } from '../services/leadAccessService.js';
import { addLeadEventClient, publishLeadEvent } from '../services/leadEventService.js';
import { appendLeadActivity } from '../services/leadActivityService.js';
import {
  assignLeadAtomically,
  expireAssignments,
  getLeadOperationsSetting,
  respondToAssignment,
} from '../services/leadAssignmentService.js';
import { markLeadWon } from '../services/leadConversionService.js';
import { createNotificationEvent } from '../services/notificationService.js';

const router = Router();
const TERMINAL_STATUSES = ['won', 'lost'];
const VISIT_TRANSITIONS = {
  scheduled: ['travelling', 'cancelled', 'no_show'],
  travelling: ['arrived', 'cancelled'],
  arrived: ['attending', 'cancelled', 'no_show'],
  attending: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};
const CREATE_FIELDS = [
  'name', 'phone', 'alternatePhone', 'email', 'businessName', 'city', 'state', 'address', 'pinCode',
  'customerType', 'leadSource', 'leadChannel', 'leadType', 'campaign', 'referredBy', 'interestedIn',
  'interestedProducts', 'estimatedArea', 'estimatedValue', 'projectType', 'priority', 'nextFollowupDate',
  'remarks', 'tags',
];
const UPDATE_FIELDS = CREATE_FIELDS.filter((field) => !['name', 'phone'].includes(field)).concat(['name', 'phone']);
const CHANNEL_BY_LEGACY_TYPE = {
  walk_in: 'store_visit', phone_enquiry: 'phone', whatsapp: 'whatsapp', online_enquiry: 'online',
  google_ads: 'online', facebook: 'social', instagram: 'social', referral: 'referral',
  architect_referral: 'referral', dealer_referral: 'referral', exhibition: 'exhibition', other: 'other',
};

router.use(protect);
router.use(requireBranch);

const pick = (source, fields) => fields.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(source || {}, field)) result[field] = source[field];
  return result;
}, {});
const asyncRoute = (handler) => async (req, res) => {
  try { await handler(req, res); }
  catch (error) { res.status(error.status || (error?.code === 11000 ? 409 : 500)).json({ success: false, message: error.message }); }
};
const requireAnyPermission = (...permissions) => (req, res, next) => (
  permissions.some((permission) => userHasPermission(req.user, permission))
    ? next()
    : res.status(403).json({ success: false, message: `Permission required: ${permissions.join(' or ')}` })
);
const emitNotification = async (payload) => {
  try { await createNotificationEvent(payload); }
  catch (error) { console.error('Lead notification error:', error.message); }
};
const emitChange = ({ req, lead, action, recipients = [] }) => {
  publishLeadEvent({ branchId: req.branchId, event: 'lead.changed', data: { action } });
  if (recipients.length) publishLeadEvent({ branchId: req.branchId, userIds: recipients, event: `lead.${action}`, data: { leadId: lead._id, action } });
};
const validateId = (id, label = 'identifier') => {
  if (!mongoose.isValidObjectId(id)) throw Object.assign(new Error(`Invalid ${label}.`), { status: 422 });
};
const leadOr404 = async (req, resourceKey = '*') => {
  validateId(req.params.id, 'lead identifier');
  const scope = await getLeadRecordPredicate(req, resourceKey);
  const lead = await Lead.findOne({ _id: req.params.id, ...scope });
  if (!lead) throw Object.assign(new Error('Lead not found.'), { status: 404 });
  return { lead, scope };
};

router.get('/events', requireAnyPermission('lead.view', 'lead.app'), (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const cleanup = addLeadEventClient({ branchId: req.branchId, userId: req.user._id, role: req.user.role, response: res });
  req.on('close', cleanup);
});

router.get('/settings', requirePermission('lead.assign'), asyncRoute(async (req, res) => {
  res.json({ success: true, data: await getLeadOperationsSetting(req.branchId) });
}));

router.patch('/settings', requirePermission('lead.assign'), asyncRoute(async (req, res) => {
  const acceptanceDeadlineMinutes = Number(req.body.acceptanceDeadlineMinutes);
  const maxActiveLeads = Number(req.body.maxActiveLeads);
  if (!Number.isInteger(acceptanceDeadlineMinutes) || acceptanceDeadlineMinutes < 5 || acceptanceDeadlineMinutes > 1440) {
    return res.status(422).json({ success: false, message: 'Acceptance deadline must be 5–1440 minutes.' });
  }
  if (!Number.isInteger(maxActiveLeads) || maxActiveLeads < 1 || maxActiveLeads > 500) {
    return res.status(422).json({ success: false, message: 'Workload limit must be 1–500.' });
  }
  const settings = await LeadOperationsSetting.findOneAndUpdate(
    { branch: req.branchId },
    { $set: { acceptanceDeadlineMinutes, maxActiveLeads, updatedBy: req.user._id }, $setOnInsert: { branch: req.branchId } },
    { upsert: true, new: true, runValidators: true }
  );
  res.json({ success: true, message: 'Lead operation settings saved.', data: settings });
}));

router.post('/assignments/process-timeouts', requirePermission('lead.assign'), asyncRoute(async (req, res) => {
  const expired = await expireAssignments({ branchId: req.branchId, actor: req.user });
  res.json({ success: true, message: `${expired.length} assignment(s) expired.`, data: { expired } });
}));

router.get('/availability/me', requireAnyPermission('lead.app', 'lead.respond'), asyncRoute(async (req, res) => {
  const availability = await LeadExecutiveAvailability.findOne({ branch: req.branchId, user: req.user._id }).lean();
  res.json({ success: true, data: availability || { user: req.user._id, branch: req.branchId, status: 'offline', reason: '' } });
}));

router.patch('/availability/me', requireAnyPermission('lead.app', 'lead.respond'), asyncRoute(async (req, res) => {
  const allowed = ['available', 'busy', 'attending', 'travelling', 'on_break', 'offline'];
  if (!allowed.includes(req.body.status)) return res.status(422).json({ success: false, message: 'Invalid availability status.' });
  const data = pick(req.body, ['status', 'reason']);
  const now = new Date();
  const availability = await LeadExecutiveAvailability.findOneAndUpdate(
    { branch: req.branchId, user: req.user._id },
    { $set: { ...data, updatedBy: req.user._id, statusUpdatedAt: now, lastSeenAt: now }, $setOnInsert: { branch: req.branchId, user: req.user._id } },
    { upsert: true, new: true, runValidators: true }
  );
  publishLeadEvent({ branchId: req.branchId, event: 'availability.changed', data: { userId: req.user._id, status: availability.status } });
  res.json({ success: true, message: 'Availability updated.', data: availability });
}));

router.patch('/availability/:userId', requirePermission('lead.assign'), asyncRoute(async (req, res) => {
  validateId(req.params.userId, 'user identifier');
  const executive = await User.findOne({ _id: req.params.userId, role: 'sales_executive', status: 'Active', assignedBranches: req.branchId }).select('_id');
  if (!executive) return res.status(404).json({ success: false, message: 'Sales Executive not found in this branch.' });
  const allowed = ['available', 'busy', 'attending', 'travelling', 'on_break', 'offline'];
  if (!allowed.includes(req.body.status) || !String(req.body.reason || '').trim()) {
    return res.status(422).json({ success: false, message: 'A valid status and manager override reason are required.' });
  }
  const now = new Date();
  const availability = await LeadExecutiveAvailability.findOneAndUpdate(
    { branch: req.branchId, user: executive._id },
    { $set: { status: req.body.status, reason: req.body.reason.trim(), updatedBy: req.user._id, statusUpdatedAt: now, lastSeenAt: now }, $setOnInsert: { branch: req.branchId, user: executive._id } },
    { upsert: true, new: true, runValidators: true }
  );
  publishLeadEvent({ branchId: req.branchId, userIds: [executive._id], event: 'availability.changed', data: { userId: executive._id, status: availability.status } });
  res.json({ success: true, message: 'Executive availability overridden.', data: availability });
}));

router.get('/se-status', requirePermission('lead.assign'), asyncRoute(async (req, res) => {
  await expireAssignments({ branchId: req.branchId });
  const [executives, counts, availability, settings] = await Promise.all([
    User.find({ role: 'sales_executive', status: 'Active', assignedBranches: req.branchId }).select('name phone assignedRegions').lean(),
    Lead.aggregate([
      { $match: { branch: req.branchId, assignmentStatus: { $in: ['pending', 'accepted'] }, status: { $nin: TERMINAL_STATUSES } } },
      { $group: { _id: '$assignedTo', activeLeads: { $sum: 1 }, pendingResponse: { $sum: { $cond: [{ $eq: ['$assignmentStatus', 'pending'] }, 1, 0] } } } },
    ]),
    LeadExecutiveAvailability.find({ branch: req.branchId }).lean(),
    getLeadOperationsSetting(req.branchId),
  ]);
  const countMap = new Map(counts.map((row) => [String(row._id), row]));
  const availabilityMap = new Map(availability.map((row) => [String(row.user), row]));
  const data = executives.map((executive) => {
    const workload = countMap.get(String(executive._id)) || {};
    const state = availabilityMap.get(String(executive._id));
    const status = state?.status || 'offline';
    const activeLeads = workload.activeLeads || 0;
    return {
      ...executive,
      activeLeads,
      pendingResponse: workload.pendingResponse || 0,
      availability: status,
      statusReason: state?.reason || '',
      currentLead: state?.currentLead || null,
      currentVisit: state?.currentVisit || null,
      lastSeenAt: state?.lastSeenAt || null,
      statusUpdatedAt: state?.statusUpdatedAt || null,
      workloadLimit: settings.maxActiveLeads,
      isBusy: activeLeads >= settings.maxActiveLeads,
      canAssign: status === 'available' && activeLeads < settings.maxActiveLeads,
    };
  });
  res.json({ success: true, data });
}));

router.get('/stats', requirePermission('lead.view'), asyncRoute(async (req, res) => {
  await expireAssignments({ branchId: req.branchId });
  const scope = await getLeadRecordPredicate(req, 'stats');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const accessCutoff = scope.createdAt?.$gte;
  const todayCutoff = accessCutoff && accessCutoff > today ? accessCutoff : today;
  const todayCreatedAt = { ...(scope.createdAt || {}), $gte: todayCutoff };
  const [total, unassigned, pending, accepted, contacted, won, lost, hotLeads, todayLeads] = await Promise.all([
    Lead.countDocuments(scope),
    Lead.countDocuments({ ...scope, assignmentStatus: 'unassigned' }),
    Lead.countDocuments({ ...scope, assignmentStatus: 'pending' }),
    Lead.countDocuments({ ...scope, assignmentStatus: 'accepted' }),
    Lead.countDocuments({ ...scope, status: 'contacted' }),
    Lead.countDocuments({ ...scope, status: 'won' }),
    Lead.countDocuments({ ...scope, status: 'lost' }),
    Lead.countDocuments({ ...scope, priority: 'hot' }),
    Lead.countDocuments({ ...scope, createdAt: todayCreatedAt }),
  ]);
  res.json({ success: true, data: { total, unassigned, pending, accepted, contacted, won, lost, hotLeads, todayLeads } });
}));

router.get('/my-leads', requirePermission('lead.app'), asyncRoute(async (req, res) => {
  await expireAssignments({ branchId: req.branchId });
  const scope = await getLeadRecordPredicate(req, 'app');
  const leads = await Lead.aggregate([
    { $match: { ...scope, status: { $nin: TERMINAL_STATUSES } } },
    { $set: {
      _assignmentRank: { $switch: { branches: [{ case: { $eq: ['$assignmentStatus', 'pending'] }, then: 0 }, { case: { $eq: ['$assignmentStatus', 'accepted'] }, then: 1 }], default: 2 } },
      _priorityRank: { $switch: { branches: [{ case: { $eq: ['$priority', 'hot'] }, then: 0 }, { case: { $eq: ['$priority', 'high'] }, then: 1 }, { case: { $eq: ['$priority', 'medium'] }, then: 2 }], default: 3 } },
    } },
    { $sort: { _assignmentRank: 1, _priorityRank: 1, nextFollowupDate: 1, createdAt: -1 } },
    { $project: { _assignmentRank: 0, _priorityRank: 0, assignmentHistory: 0, followups: 0 } },
  ]);
  res.json({
    success: true,
    data: {
      pendingAcceptance: leads.filter((lead) => lead.assignmentStatus === 'pending'),
      active: leads.filter((lead) => lead.assignmentStatus === 'accepted'),
      total: leads.length,
    },
  });
}));

router.get('/', requirePermission('lead.view'), asyncRoute(async (req, res) => {
  await expireAssignments({ branchId: req.branchId });
  const { page = 1, limit = 20, search, status, customerType, assignedTo, assignmentStatus, priority, sortBy = 'queue' } = req.query;
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const l = Math.min(100, Number.parseInt(limit, 10) || 20);
  const filter = await getLeadRecordPredicate(req, 'list');
  if (search) {
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filter.$or = [{ leadNumber: regex }, { name: regex }, { phone: regex }, { businessName: regex }, { city: regex }];
  }
  if (status) filter.status = status;
  if (customerType) filter.customerType = customerType;
  if (assignedTo && req.user.role !== 'sales_executive') filter.assignedTo = new mongoose.Types.ObjectId(assignedTo);
  if (assignmentStatus) filter.assignmentStatus = assignmentStatus;
  if (priority) filter.priority = priority;

  const rankStages = sortBy === 'queue' ? [
    { $set: {
      _queueRank: { $switch: { branches: [
        { case: { $in: ['$status', TERMINAL_STATUSES] }, then: 3 },
        { case: { $eq: ['$assignmentStatus', 'unassigned'] }, then: 0 },
        { case: { $eq: ['$assignmentStatus', 'pending'] }, then: 1 },
        { case: { $eq: ['$assignmentStatus', 'accepted'] }, then: 2 },
      ], default: 3 } },
      _priorityRank: { $switch: { branches: [
        { case: { $eq: ['$priority', 'hot'] }, then: 0 },
        { case: { $eq: ['$priority', 'high'] }, then: 1 },
        { case: { $eq: ['$priority', 'medium'] }, then: 2 },
      ], default: 3 } },
    } },
    { $sort: { _queueRank: 1, _priorityRank: 1, createdAt: -1 } },
  ] : [{ $sort: { createdAt: -1 } }];
  const [data, totalRows] = await Promise.all([
    Lead.aggregate([{ $match: filter }, ...rankStages, { $skip: (p - 1) * l }, { $limit: l }, { $project: { _queueRank: 0, _priorityRank: 0 } }]),
    Lead.aggregate([{ $match: filter }, { $count: 'total' }]),
  ]);
  const total = totalRows[0]?.total || 0;
  res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
}));

router.post('/', requirePermission('lead.create'), asyncRoute(async (req, res) => {
  if (req.body.assignedTo || req.body.assignmentStatus || req.body.assignmentHistory) {
    return res.status(422).json({ success: false, message: 'Create-time assignment is not supported. Create the lead, then use the validated assignment action.' });
  }
  const data = { ...pick(req.body, CREATE_FIELDS), ...getLeadCreateScope(req) };
  data.leadChannel = data.leadChannel || CHANNEL_BY_LEGACY_TYPE[data.customerType] || 'other';
  data.leadSource = data.leadSource || data.customerType || '';
  const { generateUniqueCode } = await import('../utils/codeGenerator.js');
  data.leadNumber = await generateUniqueCode(Lead, 'leadNumber', 'LD-', 5);
  const lead = await Lead.create(data);
  await appendLeadActivity({ branch: req.branchId, lead, type: 'created', summary: `Lead ${lead.leadNumber} created`, actor: req.user });
  await emitNotification({
    branch: req.branchId, module: 'lead', event: 'lead_created', eventKey: `lead:${lead._id}:created`,
    title: `Lead ${lead.leadNumber} created`, body: `${lead.name} was added as a new lead.`,
    deepLink: `/crm/lead-management?lead=${lead._id}`, data: { leadId: lead._id, leadNumber: lead.leadNumber }, actor: req.user._id,
  });
  emitChange({ req, lead, action: 'created' });
  res.status(201).json({ success: true, message: `Lead ${lead.leadNumber} created.`, data: lead });
}));

router.get('/:id/visits', requireAnyPermission('lead.view', 'lead.app'), asyncRoute(async (req, res) => {
  const { lead } = await leadOr404(req, 'visits');
  const visits = await LeadVisit.find({ branch: req.branchId, lead: lead._id })
    .sort({ scheduledAt: -1 }).populate('assignedTo', 'name phone').lean();
  res.json({ success: true, data: visits });
}));

router.post('/:id/visits', requirePermission('lead.followup'), asyncRoute(async (req, res) => {
  const { lead } = await leadOr404(req, 'visits');
  const assignedTo = req.body.assignedTo || lead.assignedTo;
  if (!assignedTo || (req.user.role === 'sales_executive' && String(assignedTo) !== String(req.user._id))) {
    return res.status(422).json({ success: false, message: 'Visit owner must be the currently assigned executive.' });
  }
  const executive = await User.findOne({ _id: assignedTo, role: 'sales_executive', status: 'Active', assignedBranches: req.branchId }).select('_id');
  if (!executive) return res.status(422).json({ success: false, message: 'Visit executive is unavailable in this branch.' });
  const visit = await LeadVisit.create({
    branch: req.branchId,
    lead: lead._id,
    assignedTo,
    scheduledAt: req.body.scheduledAt,
    location: req.body.location || {},
    remarks: req.body.remarks || '',
    attachments: req.body.attachments || [],
    outcome: req.body.outcome || '',
    nextAction: req.body.nextAction || '',
    createdBy: req.user._id,
    transitions: [{ to: 'scheduled', by: req.user._id, byName: req.user.name, remarks: req.body.remarks || '' }],
  });
  await appendLeadActivity({ branch: req.branchId, lead, visit, type: 'visit_created', summary: 'Visit scheduled', actor: req.user, data: { scheduledAt: visit.scheduledAt } });
  emitChange({ req, lead, action: 'visit_created', recipients: [assignedTo] });
  res.status(201).json({ success: true, message: 'Visit scheduled.', data: visit });
}));

router.patch('/:id/visits/:visitId/status', requirePermission('lead.followup'), asyncRoute(async (req, res) => {
  const { lead } = await leadOr404(req, 'visits');
  validateId(req.params.visitId, 'visit identifier');
  const filter = { _id: req.params.visitId, branch: req.branchId, lead: lead._id };
  if (req.user.role === 'sales_executive') filter.assignedTo = req.user._id;
  const visit = await LeadVisit.findOne(filter);
  if (!visit) return res.status(404).json({ success: false, message: 'Visit not found.' });
  const next = req.body.status;
  if (!VISIT_TRANSITIONS[visit.status]?.includes(next)) {
    return res.status(409).json({ success: false, message: `Visit cannot move from ${visit.status} to ${next}.` });
  }
  const previous = visit.status;
  const now = new Date();
  const timestampField = {
    travelling: 'startedTravellingAt', arrived: 'arrivedAt', attending: 'attendingAt', completed: 'completedAt', cancelled: 'cancelledAt', no_show: 'noShowAt',
  }[next];
  const set = { status: next };
  if (timestampField) set[timestampField] = now;
  ['remarks', 'outcome', 'nextAction'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) set[field] = req.body[field];
  });
  const push = { transitions: { from: previous, to: next, by: req.user._id, byName: req.user.name, remarks: req.body.remarks || '' } };
  if (Array.isArray(req.body.attachments) && req.body.attachments.length) push.attachments = { $each: req.body.attachments };
  const transitionedVisit = await LeadVisit.findOneAndUpdate(
    { ...filter, status: previous },
    { $set: set, $push: push },
    { new: true, runValidators: true }
  );
  if (!transitionedVisit) return res.status(409).json({ success: false, message: 'Visit changed before this transition. Refresh and retry.' });
  if (['travelling', 'attending'].includes(next)) {
    await LeadExecutiveAvailability.findOneAndUpdate(
      { branch: req.branchId, user: transitionedVisit.assignedTo },
      { $set: { status: next, currentLead: lead._id, currentVisit: transitionedVisit._id, updatedBy: req.user._id, statusUpdatedAt: now, lastSeenAt: now }, $setOnInsert: { branch: req.branchId, user: transitionedVisit.assignedTo } },
      { upsert: true, runValidators: true }
    );
  } else if (['completed', 'cancelled', 'no_show'].includes(next)) {
    await LeadExecutiveAvailability.updateOne(
      { branch: req.branchId, user: transitionedVisit.assignedTo, currentVisit: transitionedVisit._id },
      { $set: { status: 'available', currentLead: null, currentVisit: null, updatedBy: req.user._id, statusUpdatedAt: now, lastSeenAt: now } }
    );
  }
  await appendLeadActivity({ branch: req.branchId, lead, visit: transitionedVisit, type: 'visit_transition', summary: `Visit ${previous} → ${next}`, actor: req.user, fromStatus: previous, toStatus: next, data: { outcome: transitionedVisit.outcome, nextAction: transitionedVisit.nextAction } });
  emitChange({ req, lead, action: 'visit_transition', recipients: [transitionedVisit.assignedTo] });
  res.json({ success: true, message: `Visit marked ${next}.`, data: transitionedVisit });
}));

router.get('/:id', requireAnyPermission('lead.view', 'lead.app'), asyncRoute(async (req, res) => {
  await expireAssignments({ branchId: req.branchId });
  const { lead } = await leadOr404(req, 'detail');
  await lead.populate([
    { path: 'assignedTo', select: 'name phone role' },
    { path: 'createdBy', select: 'name' },
    { path: 'followups.doneBy', select: 'name' },
    { path: 'assignmentHistory.assignedTo', select: 'name' },
    { path: 'assignmentHistory.assignedBy', select: 'name' },
    { path: 'incentiveEarning' },
  ]);
  const [visits, activities] = await Promise.all([
    LeadVisit.find({ branch: req.branchId, lead: lead._id }).sort({ scheduledAt: -1 }).populate('assignedTo', 'name phone').lean(),
    LeadActivity.find({ branch: req.branchId, lead: lead._id }).sort({ createdAt: -1 }).populate('actor', 'name role').lean(),
  ]);
  res.json({ success: true, data: { ...lead.toObject(), visits, activities } });
}));

router.put('/:id', requirePermission('lead.update'), asyncRoute(async (req, res) => {
  const { lead } = await leadOr404(req, 'update');
  Object.assign(lead, pick(req.body, UPDATE_FIELDS));
  await lead.save();
  await appendLeadActivity({ branch: req.branchId, lead, type: 'updated', summary: 'Lead details updated', actor: req.user });
  emitChange({ req, lead, action: 'updated', recipients: lead.assignedTo ? [lead.assignedTo] : [] });
  res.json({ success: true, message: 'Lead updated.', data: lead });
}));

router.patch('/:id/assign', requirePermission('lead.assign'), asyncRoute(async (req, res) => {
  const scope = await getLeadRecordPredicate(req, 'assign');
  const lead = await assignLeadAtomically({
    leadId: req.params.id,
    scope,
    branchId: req.branchId,
    assignedTo: req.body.assignedTo,
    actor: req.user,
    expectedVersion: Number(req.body.expectedVersion),
    expectedCurrentAssignedTo: req.body.expectedCurrentAssignedTo || null,
    overrideAvailability: req.body.overrideAvailability === true,
    overrideReason: req.body.overrideReason || '',
  });
  res.json({ success: true, message: `Lead assigned to ${lead.assignedToName}. Awaiting acceptance.`, data: lead });
}));

router.patch('/:id/accept', requirePermission('lead.respond'), asyncRoute(async (req, res) => {
  const scope = await getLeadRecordPredicate(req, 'respond');
  const lead = await respondToAssignment({ leadId: req.params.id, scope, branchId: req.branchId, actor: req.user, action: 'accepted', expectedVersion: Number(req.body.expectedVersion) });
  res.json({ success: true, message: 'Lead accepted.', data: lead });
}));

router.patch('/:id/decline', requirePermission('lead.respond'), asyncRoute(async (req, res) => {
  const scope = await getLeadRecordPredicate(req, 'respond');
  const lead = await respondToAssignment({ leadId: req.params.id, scope, branchId: req.branchId, actor: req.user, action: 'declined', reason: req.body.reason, expectedVersion: Number(req.body.expectedVersion) });
  res.json({ success: true, message: 'Lead declined for reassignment.', data: lead });
}));

router.patch('/:id/followup', requirePermission('lead.followup'), asyncRoute(async (req, res) => {
  if (req.body.outcome === 'converted' && !userHasPermission(req.user, 'lead.convert')) {
    return res.status(403).json({ success: false, message: 'Permission required: lead.convert' });
  }
  const { lead } = await leadOr404(req, 'followup');
  const previous = lead.status;
  lead.followups.push({
    notes: req.body.notes,
    outcome: req.body.outcome || 'callback',
    nextFollowupDate: req.body.nextFollowupDate,
    doneBy: req.user._id,
    doneByName: req.user.name,
  });
  lead.nextFollowupDate = req.body.nextFollowupDate || null;
  lead.lastContactDate = new Date();
  lead.totalFollowups = (lead.totalFollowups || 0) + 1;
  if (req.body.outcome === 'not_interested') lead.status = 'lost';
  else if (req.body.outcome === 'interested' && lead.status === 'contacted') lead.status = 'qualified';

  if (req.body.outcome === 'converted') {
    const result = await markLeadWon({ lead, actor: req.user, branchId: req.branchId, conversionValue: req.body.conversionValue, source: 'followup' });
    await appendLeadActivity({ branch: req.branchId, lead: result.lead, type: 'followup', summary: 'Follow-up: converted', actor: req.user, fromStatus: previous, toStatus: 'won', data: { notes: req.body.notes || '', nextFollowupDate: result.lead.nextFollowupDate } });
    return res.json({ success: true, message: 'Follow-up recorded and lead converted.', data: result.lead, incentiveStatus: result.incentiveStatus });
  }
  await lead.save();
  await appendLeadActivity({ branch: req.branchId, lead, type: 'followup', summary: `Follow-up: ${req.body.outcome || 'callback'}`, actor: req.user, fromStatus: previous, toStatus: lead.status, data: { notes: req.body.notes || '', nextFollowupDate: lead.nextFollowupDate } });
  emitChange({ req, lead, action: 'followup', recipients: lead.assignedTo ? [lead.assignedTo] : [] });
  res.json({ success: true, message: 'Follow-up recorded.', data: lead });
}));

router.patch('/:id/status', requirePermission('lead.update'), asyncRoute(async (req, res) => {
  if (req.body.status === 'won' && !userHasPermission(req.user, 'lead.convert')) {
    return res.status(403).json({ success: false, message: 'Permission required: lead.convert' });
  }
  const { lead } = await leadOr404(req, 'status');
  if (req.body.status === 'won') {
    const result = await markLeadWon({
      lead, actor: req.user, branchId: req.branchId, conversionValue: req.body.conversionValue,
      convertedToDealer: req.body.convertedToDealer, convertedToCustomer: req.body.convertedToCustomer, source: 'status',
    });
    return res.json({ success: true, message: 'Lead marked won.', data: result.lead, incentiveStatus: result.incentiveStatus });
  }
  const previous = lead.status;
  lead.status = req.body.status;
  if (req.body.status === 'lost') lead.lostReason = req.body.lostReason || '';
  await lead.save();
  await appendLeadActivity({ branch: req.branchId, lead, type: 'status_changed', summary: `Status ${previous} → ${lead.status}`, actor: req.user, fromStatus: previous, toStatus: lead.status });
  emitChange({ req, lead, action: 'status_changed', recipients: lead.assignedTo ? [lead.assignedTo] : [] });
  res.json({ success: true, message: `Status → ${lead.status}`, data: lead });
}));

router.patch('/:id/convert', requirePermission('lead.convert'), asyncRoute(async (req, res) => {
  const { lead } = await leadOr404(req, 'convert');
  const result = await markLeadWon({
    lead, actor: req.user, branchId: req.branchId, conversionValue: req.body.conversionValue,
    convertedToDealer: req.body.convertedToDealer, convertedToCustomer: req.body.convertedToCustomer, source: 'convert',
  });
  res.json({
    success: true,
    message: result.incentiveStatus === 'earned' ? 'Lead converted and incentive earning linked.' : 'Lead converted; no active incentive rule was found.',
    data: result.lead,
    incentiveStatus: result.incentiveStatus,
  });
}));

router.delete('/:id', requirePermission('lead.delete'), asyncRoute(async (req, res) => {
  const { lead, scope } = await leadOr404(req, 'delete');
  const { safeDelete } = await import('../middleware/safeDelete.js');
  const result = await safeDelete(Lead, req.params.id, {
    user: req.user,
    module: 'lead',
    titleField: 'name',
    codeField: 'leadNumber',
    skipDependencyCheck: true,
    scope,
  });
  if (result.success) {
    await appendLeadActivity({ branch: req.branchId, lead, type: 'deleted', summary: `Lead ${lead.leadNumber} deleted`, actor: req.user });
    emitChange({ req, lead, action: 'deleted', recipients: lead.assignedTo ? [lead.assignedTo] : [] });
  }
  res.status(result.status || 200).json(result);
}));

export default router;
