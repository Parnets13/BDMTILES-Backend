import LeadActivity from '../models/LeadActivity.js';

export const appendLeadActivity = async ({ branch, lead, type, summary, actor, visit, fromStatus, toStatus, data = {} }) => {
  const actorId = actor?._id || actor || null;
  return LeadActivity.create({
    branch,
    lead: lead?._id || lead,
    type,
    summary,
    actor: actorId,
    actorName: actor?.name || '',
    visit: visit?._id || visit || null,
    fromStatus,
    toStatus,
    data,
  });
};

export default appendLeadActivity;
