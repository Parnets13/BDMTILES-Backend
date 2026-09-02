import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import LeadExecutiveAvailability from '../models/LeadExecutiveAvailability.js';
import LeadOperationsSetting from '../models/LeadOperationsSetting.js';
import { createNotificationEvent } from './notificationService.js';
import { appendLeadActivity } from './leadActivityService.js';
import { publishLeadEvent } from './leadEventService.js';

const TERMINAL_STATUSES = ['won', 'lost'];
const objectId = (value) => new mongoose.Types.ObjectId(String(value));
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const invalid = (message, status = 422) => Object.assign(new Error(message), { status });

export const getLeadOperationsSetting = async (branchId) => (
  await LeadOperationsSetting.findOne({ branch: branchId }).lean()
  || { acceptanceDeadlineMinutes: 30, maxActiveLeads: 10 }
);

const notify = async (payload) => {
  try { await createNotificationEvent(payload); }
  catch (error) { console.error('Lead notification error:', error.message); }
};

export const assignLeadAtomically = async ({
  leadId,
  scope,
  branchId,
  assignedTo,
  actor,
  expectedVersion,
  expectedCurrentAssignedTo,
  overrideAvailability = false,
  overrideReason = '',
}) => {
  if (!mongoose.isValidObjectId(leadId) || !mongoose.isValidObjectId(assignedTo)) throw invalid('Invalid lead or executive identifier.');
  if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) < 0) throw invalid('expectedVersion is required for assignment.');

  const [executive, availability, settings, activeLeads, snapshot] = await Promise.all([
    User.findOne({ _id: assignedTo, role: 'sales_executive', status: 'Active', assignedBranches: branchId }).select('name phone role').lean(),
    LeadExecutiveAvailability.findOne({ branch: branchId, user: assignedTo }).lean(),
    getLeadOperationsSetting(branchId),
    Lead.countDocuments({
      branch: branchId,
      assignedTo,
      assignmentStatus: { $in: ['pending', 'accepted'] },
      status: { $nin: TERMINAL_STATUSES },
    }),
    Lead.findOne({ _id: leadId, ...scope }).select('assignedTo assignmentStatus assignmentVersion assignmentHistory status').lean(),
  ]);
  if (!executive) throw invalid('Sales Executive must be active and assigned to the selected branch.');
  if (!snapshot) throw Object.assign(new Error('Lead not found.'), { status: 404 });
  if (TERMINAL_STATUSES.includes(snapshot.status)) throw conflict('Closed leads cannot be assigned.');
  if (Number(snapshot.assignmentVersion || 0) !== Number(expectedVersion)
      || String(snapshot.assignedTo || '') !== String(expectedCurrentAssignedTo || '')) {
    throw conflict('Assignment conflict: the lead or current assignment changed. Refresh and retry.');
  }
  if (String(snapshot.assignedTo || '') === String(assignedTo)) {
    throw conflict('This lead is already assigned to that executive.');
  }

  const unavailable = availability?.status !== 'available';
  const overloaded = activeLeads >= settings.maxActiveLeads;
  if ((unavailable || overloaded) && !overrideAvailability) {
    throw invalid(unavailable
      ? `Sales Executive is ${availability?.status || 'offline'} and cannot receive assignments.`
      : `Sales Executive has reached the workload limit of ${settings.maxActiveLeads}.`);
  }
  if ((unavailable || overloaded) && !String(overrideReason || '').trim()) {
    throw invalid('An override reason is required for an unavailable or overloaded executive.');
  }

  const now = new Date();
  const deadline = new Date(now.getTime() + (settings.acceptanceDeadlineMinutes * 60000));
  const targetId = objectId(assignedTo);
  const actorId = objectId(actor._id);
  const reservationFilter = overrideAvailability
    ? { branch: branchId, user: targetId }
    : {
      branch: branchId,
      user: targetId,
      status: 'available',
      $expr: { $lt: [{ $max: [{ $ifNull: ['$assignmentLoad', 0] }, activeLeads] }, settings.maxActiveLeads] },
    };
  const reservation = await LeadExecutiveAvailability.findOneAndUpdate(
    reservationFilter,
    [{ $set: {
      branch: branchId,
      user: targetId,
      status: { $ifNull: ['$status', 'offline'] },
      reason: { $ifNull: ['$reason', 'Created by assignment override'] },
      statusUpdatedAt: { $ifNull: ['$statusUpdatedAt', now] },
      assignmentLoad: { $add: [{ $max: [{ $ifNull: ['$assignmentLoad', 0] }, activeLeads] }, 1] },
      updatedBy: actorId,
      lastSeenAt: now,
    } }],
    { new: true, upsert: overrideAvailability }
  );
  if (!reservation) throw conflict('Executive availability or workload changed. Refresh and retry.');

  const filter = {
    _id: objectId(leadId),
    ...scope,
    status: { $nin: TERMINAL_STATUSES },
    $nor: [{ assignedTo: targetId }],
    $expr: { $eq: [{ $ifNull: ['$assignmentVersion', 0] }, Number(expectedVersion)] },
  };
  if (expectedCurrentAssignedTo) filter.assignedTo = objectId(expectedCurrentAssignedTo);
  else filter.$and = [{ $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] }];

  const previousHistoryId = snapshot.assignmentHistory?.[snapshot.assignmentHistory.length - 1]?._id || null;
  const historyEntry = {
    assignedTo: targetId,
    assignedToName: executive.name,
    assignedBy: actorId,
    assignedByName: actor.name,
    assignedAt: now,
    response: 'pending',
    seStatus: availability?.status || 'offline',
    declineReason: overrideAvailability ? `Override: ${String(overrideReason).trim()}` : '',
  };
  const lead = await Lead.findOneAndUpdate(filter, [
    {
      $set: {
        assignmentHistory: {
          $concatArrays: [
            {
              $map: {
                input: { $ifNull: ['$assignmentHistory', []] },
                as: 'history',
                in: {
                  $cond: [
                    previousHistoryId ? { $eq: ['$$history._id', previousHistoryId] } : false,
                    { $mergeObjects: ['$$history', { response: 'reassigned', respondedAt: now, endedAt: now, endReason: 'reassigned', declineReason: String(overrideReason || 'Reassigned') }] },
                    '$$history',
                  ],
                },
              },
            },
            [historyEntry],
          ],
        },
        assignedTo: targetId,
        assignedToName: executive.name,
        assignmentStatus: 'pending',
        assignedAt: now,
        acceptanceDeadlineAt: deadline,
        acceptedAt: null,
        declinedAt: null,
        declineReason: '',
        assignmentVersion: { $add: [{ $ifNull: ['$assignmentVersion', 0] }, 1] },
        status: { $cond: [{ $eq: ['$status', 'new'] }, 'assigned', '$status'] },
      },
    },
  ], { new: true });

  if (!lead) {
    await LeadExecutiveAvailability.updateOne(
      { branch: branchId, user: targetId, assignmentLoad: { $gt: 0 } },
      { $inc: { assignmentLoad: -1 } }
    );
    throw conflict('Assignment conflict: the lead changed, is closed, or the current assignment no longer matches. Refresh and retry.');
  }
  if (snapshot.assignedTo) {
    await LeadExecutiveAvailability.updateOne(
      { branch: branchId, user: snapshot.assignedTo, assignmentLoad: { $gt: 0 } },
      { $inc: { assignmentLoad: -1 } }
    );
  }

  await appendLeadActivity({ branch: branchId, lead, type: 'assigned', summary: `Assigned to ${executive.name}`, actor, data: { assignmentVersion: lead.assignmentVersion, deadline, overrideReason: overrideReason || '' } });
  await notify({
    branch: branchId,
    module: 'lead',
    event: 'lead_assigned',
    eventKey: `lead:${lead._id}:assigned:${lead.assignmentVersion}`,
    title: `Lead ${lead.leadNumber} assigned`,
    body: `${lead.name} has been assigned to ${executive.name}.`,
    deepLink: `/se-app/leads?lead=${lead._id}`,
    data: { leadId: lead._id, leadNumber: lead.leadNumber },
    actor: actor._id,
    recipientUserIds: [assignedTo],
  });
  publishLeadEvent({ branchId, userIds: [assignedTo], event: 'lead.assigned', data: { leadId: lead._id, assignmentVersion: lead.assignmentVersion } });
  if (snapshot.assignedTo) {
    publishLeadEvent({ branchId, userIds: [snapshot.assignedTo], event: 'lead.unassigned', data: { leadId: lead._id, action: 'reassigned' } });
  }
  publishLeadEvent({ branchId, event: 'lead.changed', data: { action: 'assigned' } });
  return lead;
};

export const respondToAssignment = async ({ leadId, scope, branchId, actor, action, reason = '', expectedVersion }) => {
  if (!['accepted', 'declined'].includes(action)) throw invalid('Unsupported assignment response.');
  if (!Number.isInteger(Number(expectedVersion))) throw invalid('expectedVersion is required.');
  if (action === 'declined' && !String(reason).trim()) throw invalid('A decline reason is required.');

  const now = new Date();
  const accepted = action === 'accepted';
  const update = {
    assignmentStatus: accepted ? 'accepted' : 'unassigned',
    acceptedAt: accepted ? now : null,
    declinedAt: accepted ? null : now,
    declineReason: accepted ? '' : String(reason).trim(),
    acceptanceDeadlineAt: null,
    status: accepted
      ? { $cond: [{ $in: ['$status', ['new', 'assigned']] }, 'contacted', '$status'] }
      : { $cond: [{ $eq: ['$status', 'assigned'] }, 'new', '$status'] },
    assignmentVersion: { $add: [{ $ifNull: ['$assignmentVersion', 0] }, 1] },
    assignmentHistory: {
      $map: {
        input: { $ifNull: ['$assignmentHistory', []] },
        as: 'history',
        in: {
          $cond: [
            { $eq: ['$$history.response', 'pending'] },
            { $mergeObjects: ['$$history', {
              response: action,
              respondedAt: now,
              declineReason: accepted ? '' : String(reason).trim(),
              ...(accepted ? {} : { endedAt: now, endReason: 'declined' }),
            }] },
            '$$history',
          ],
        },
      },
    },
  };
  if (!accepted) {
    update.assignedTo = null;
    update.assignedToName = '';
  }

  const lead = await Lead.findOneAndUpdate({
    _id: leadId,
    ...scope,
    assignedTo: actor._id,
    assignmentStatus: 'pending',
    acceptanceDeadlineAt: { $gt: now },
    $expr: { $eq: [{ $ifNull: ['$assignmentVersion', 0] }, Number(expectedVersion)] },
  }, [{ $set: update }], { new: true });
  if (!lead) throw conflict('Response conflict: this assignment changed or expired. Refresh and retry.');
  if (!accepted) {
    await LeadExecutiveAvailability.updateOne(
      { branch: branchId, user: actor._id, assignmentLoad: { $gt: 0 } },
      { $inc: { assignmentLoad: -1 } }
    );
  }

  await appendLeadActivity({ branch: branchId, lead, type: accepted ? 'accepted' : 'declined', summary: accepted ? 'Assignment accepted' : `Assignment declined: ${reason}`, actor });
  await notify({
    branch: branchId,
    module: 'lead',
    event: accepted ? 'lead_accepted' : 'lead_declined',
    eventKey: `lead:${lead._id}:${action}:${lead.assignmentVersion}`,
    title: `Lead ${lead.leadNumber} ${action}`,
    body: `${actor.name} ${action} ${lead.name}${reason ? `: ${reason}` : '.'}`,
    deepLink: `/crm/lead-management?lead=${lead._id}`,
    data: { leadId: lead._id, leadNumber: lead.leadNumber },
    actor: actor._id,
  });
  publishLeadEvent({ branchId, userIds: [actor._id], event: `lead.${action}`, data: { leadId: lead._id, action } });
  publishLeadEvent({ branchId, event: 'lead.changed', data: { action } });
  return lead;
};

export const expireAssignments = async ({ branchId, actor = null, limit = 100 }) => {
  const now = new Date();
  const expired = await Lead.find({
    branch: branchId,
    assignmentStatus: 'pending',
    acceptanceDeadlineAt: { $lte: now },
  }).select('_id assignedTo assignmentVersion').limit(limit).lean();
  const results = [];

  for (const candidate of expired) {
    const lead = await Lead.findOneAndUpdate({
      _id: candidate._id,
      branch: branchId,
      assignedTo: candidate.assignedTo,
      assignmentStatus: 'pending',
      assignmentVersion: candidate.assignmentVersion,
      acceptanceDeadlineAt: { $lte: now },
    }, [{ $set: {
      assignedTo: null,
      assignedToName: '',
      assignmentStatus: 'unassigned',
      acceptanceDeadlineAt: null,
      status: { $cond: [{ $eq: ['$status', 'assigned'] }, 'new', '$status'] },
      assignmentVersion: { $add: [{ $ifNull: ['$assignmentVersion', 0] }, 1] },
      assignmentHistory: {
        $map: {
          input: { $ifNull: ['$assignmentHistory', []] },
          as: 'history',
          in: { $cond: [
            { $eq: ['$$history.response', 'pending'] },
            { $mergeObjects: ['$$history', { response: 'timeout', respondedAt: now, endedAt: now, endReason: 'timeout', declineReason: 'Acceptance deadline expired' }] },
            '$$history',
          ] },
        },
      },
    } }], { new: true });
    if (!lead) continue;
    results.push(lead._id);
    await LeadExecutiveAvailability.updateOne(
      { branch: branchId, user: candidate.assignedTo, assignmentLoad: { $gt: 0 } },
      { $inc: { assignmentLoad: -1 } }
    );
    await appendLeadActivity({ branch: branchId, lead, type: 'assignment_timeout', summary: 'Assignment acceptance timed out', actor: actor || { _id: null, name: 'System' } });
    publishLeadEvent({ branchId, userIds: [candidate.assignedTo], event: 'lead.assignment_timeout', data: { leadId: lead._id, action: 'assignment_timeout' } });
    publishLeadEvent({ branchId, event: 'lead.changed', data: { action: 'assignment_timeout' } });
    await notify({
      branch: branchId,
      module: 'lead',
      event: 'lead_declined',
      eventKey: `lead:${lead._id}:timeout:${lead.assignmentVersion}`,
      title: `Lead ${lead.leadNumber} assignment expired`,
      body: `The acceptance deadline for ${lead.name} expired.`,
      deepLink: `/se-app/leads?lead=${lead._id}`,
      data: { leadId: lead._id, leadNumber: lead.leadNumber, reason: 'timeout' },
      actor: actor?._id || null,
      recipientUserIds: [candidate.assignedTo],
    });
  }
  return results;
};
