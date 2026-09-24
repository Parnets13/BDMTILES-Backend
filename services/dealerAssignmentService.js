import mongoose from 'mongoose';
import Dealer from '../models/Dealer.js';
import User from '../models/User.js';

/**
 * Dealer -> Sales Executive assignment.
 *
 * The assignment is load-bearing: a dealer's branch is derived from their
 * executive, and order requests, chat, complaints and gift claims all refuse to
 * work without one. So it cannot be left pointing at somebody who has been
 * deactivated, and a change to it is worth recording.
 */

const error = (status, message, code, extra = {}) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}), ...extra });

const nameOf = user => user?.name || '';

/** The only users a dealer may be assigned to. */
export async function findAssignableExecutive(id, session = null) {
  if (!mongoose.isValidObjectId(id)) throw error(422, 'Select a valid Sales Executive.', 'SE_INVALID');
  let query = User.findOne({ _id: id, role: 'sales_executive', status: 'Active' }).select('_id name');
  if (session) query = query.session(session);
  const found = await query.lean();
  if (!found) throw error(422, 'The selected user is not an active Sales Executive.', 'SE_NOT_ASSIGNABLE');
  return found;
}

/**
 * The branch a dealer's activity belongs to, derived from their sales executive.
 *
 * A dealer has no branch of its own — the executive's default branch (falling
 * back to their first assigned branch) is what order requests, stock, schemes and
 * dealer-employee target rules are posted against. Returns null when the dealer
 * has no executive yet, which callers must treat as "not linked to a branch"
 * rather than defaulting to some other branch.
 *
 * Single source of truth: this used to live inline in routes/dealerAppRoutes.js,
 * and target rules need the same answer.
 */
export async function resolveDealerBranch(dealer) {
  const executiveId = dealer?.assignedSalesExecutive?._id || dealer?.assignedSalesExecutive;
  if (!executiveId) return null;
  const executive = await User.findById(executiveId).select('defaultBranch assignedBranches').lean();
  return executive?.defaultBranch || executive?.assignedBranches?.[0] || null;
}

/**
 * Applies one assignment change and records it. Returns null when nothing moved,
 * so callers can avoid writing a history entry for a no-op save.
 */
export async function buildAssignmentChange({ dealer, nextExecutiveId, actor, reason = '', session = null }) {
  const currentId = dealer.assignedSalesExecutive ? String(dealer.assignedSalesExecutive) : null;
  const targetId = nextExecutiveId ? String(nextExecutiveId) : null;
  if (currentId === targetId) return null;

  const [from, to] = await Promise.all([
    currentId ? User.findById(currentId).select('name').session(session).lean() : null,
    targetId ? findAssignableExecutive(targetId, session) : null,
  ]);

  return {
    assignedSalesExecutive: to ? to._id : null,
    historyEntry: {
      at: new Date(),
      from: from?._id || undefined,
      fromName: nameOf(from),
      to: to?._id || undefined,
      toName: nameOf(to),
      by: actor?._id,
      byName: nameOf(actor),
      reason: String(reason || '').slice(0, 500),
    },
  };
}

/** Dealers currently held by an executive. */
export async function dealersHeldBy(executiveId, session = null) {
  let query = Dealer.find({ assignedSalesExecutive: executiveId }).select('_id businessName dealerCode');
  if (session) query = query.session(session);
  return query.lean();
}

/**
 * Moves every dealer off one executive, either onto another or to unassigned.
 * Used when an executive is deactivated: leaving the dealers pointing at an
 * inactive user silently breaks their app, so the caller has to choose.
 */
export async function reassignAllDealers({ fromExecutiveId, toExecutiveId = null, actor, reason, session = null }) {
  const dealers = await dealersHeldBy(fromExecutiveId, session);
  if (!dealers.length) return { moved: 0, dealers: [] };

  const to = toExecutiveId ? await findAssignableExecutive(toExecutiveId, session) : null;
  if (to && String(to._id) === String(fromExecutiveId)) {
    throw error(422, 'Choose a different Sales Executive to receive the dealers.', 'SE_SAME_TARGET');
  }
  const from = await User.findById(fromExecutiveId).select('name').session(session).lean();

  const historyEntry = {
    at: new Date(),
    from: from?._id || undefined,
    fromName: nameOf(from),
    to: to?._id || undefined,
    toName: nameOf(to),
    by: actor?._id,
    byName: nameOf(actor),
    reason: String(reason || '').slice(0, 500),
  };

  const update = Dealer.updateMany(
    { assignedSalesExecutive: fromExecutiveId },
    { $set: { assignedSalesExecutive: to ? to._id : null }, $push: { assignmentHistory: historyEntry } },
  );
  if (session) update.session(session);
  const result = await update;

  return {
    moved: result.modifiedCount || 0,
    to: to || null,
    dealers: dealers.map(d => ({ _id: d._id, businessName: d.businessName, dealerCode: d.dealerCode || '' })),
  };
}

/**
 * Branch-wide assignment picture. Counted in the database rather than from a
 * page of dealers, so the totals stay right past the first page.
 */
export async function assignmentSummary() {
  const [total, unassigned, perExecutive, executives] = await Promise.all([
    Dealer.countDocuments({}),
    Dealer.countDocuments({ $or: [{ assignedSalesExecutive: null }, { assignedSalesExecutive: { $exists: false } }] }),
    Dealer.aggregate([
      { $match: { assignedSalesExecutive: { $ne: null } } },
      { $group: { _id: '$assignedSalesExecutive', count: { $sum: 1 } } },
    ]),
    User.find({ role: 'sales_executive' }).select('_id name status').lean(),
  ]);

  const countById = new Map(perExecutive.map(row => [String(row._id), row.count]));
  const byExecutive = executives.map(executive => ({
    _id: executive._id,
    name: executive.name,
    status: executive.status,
    dealerCount: countById.get(String(executive._id)) || 0,
  }));

  // Dealers still pointing at somebody who can no longer log in. These keep
  // working in reports but their chat and order requests go nowhere useful.
  const strandedOnInactive = byExecutive
    .filter(executive => executive.status !== 'Active' && executive.dealerCount > 0)
    .reduce((sum, executive) => sum + executive.dealerCount, 0);

  const knownIds = new Set(executives.map(executive => String(executive._id)));
  const orphaned = perExecutive
    .filter(row => !knownIds.has(String(row._id)))
    .reduce((sum, row) => sum + row.count, 0);

  return {
    total,
    unassigned,
    assigned: total - unassigned,
    activeExecutives: byExecutive.filter(executive => executive.status === 'Active').length,
    strandedOnInactive,
    orphaned,
    byExecutive: byExecutive.sort((left, right) => right.dealerCount - left.dealerCount),
  };
}
