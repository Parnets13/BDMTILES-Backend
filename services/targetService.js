import mongoose from 'mongoose';
import Incentive from '../models/Incentive.js';
import SalesOrder from '../models/SalesOrder.js';
import DealerVisit from '../models/DealerVisit.js';
import Payment from '../models/Payment.js';
import User from '../models/User.js';

/**
 * targetService — single source of truth for Sales Executive targets (SOW 18.7).
 *
 * Targets are not a separate collection. They are `Incentive` documents with
 * `incentiveType: 'target'` and `applicableTo: 'sales_executive'`, which is what
 * the Sales Executive app already reads through
 * GET /sales-executive/me/target-progress.
 *
 * Both the admin authoring API (/api/v1/targets) and the app's progress endpoint
 * go through this module, so the number an admin sets is the number the executive
 * sees, computed the same way on both sides.
 */

export const TARGET_METRICS = ['sales', 'orders', 'visits', 'collections'];

export const METRIC_META = {
  sales: { label: 'Sales Value', unit: 'currency', triggerEvent: 'monthly_sales' },
  orders: { label: 'Order Count', unit: 'count', triggerEvent: 'order_created' },
  visits: { label: 'Dealer Visits', unit: 'count', triggerEvent: 'target_achieved' },
  collections: { label: 'Collections', unit: 'currency', triggerEvent: 'collection_target' },
};

// Sales targets keep the historical trigger events so rules created before
// `targetMetric` existed keep working and stay editable.
const SALES_TRIGGER_BY_PERIOD = {
  monthly: 'monthly_sales',
  quarterly: 'quarterly_sales',
  half_yearly: 'annual_sales',
  annual: 'annual_sales',
  one_time: 'monthly_sales',
  per_event: 'monthly_sales',
};

const LEGACY_SALES_TRIGGERS = ['monthly_sales', 'quarterly_sales', 'annual_sales'];

/** Base query that identifies an SE target rule, whatever its metric. */
export const TARGET_RULE_MATCH = {
  applicableTo: 'sales_executive',
  incentiveType: 'target',
};

const round2 = (value) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

const objectId = (value) => (value instanceof mongoose.Types.ObjectId
  ? value
  : new mongoose.Types.ObjectId(String(value)));

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A target window is a business-day range, so `2026-09-01` must mean local
 * midnight and `2026-09-30` must mean local 23:59:59.999. `new Date('2026-09-01')`
 * parses as *UTC* midnight, which in IST is 05:30 the same morning — orders taken
 * before breakfast on the first day would fall outside the window. Both ends are
 * therefore built from local components so the range is symmetric.
 */
function parseBoundary(value, edge) {
  const raw = String(value ?? '');
  const parts = DATE_ONLY.exec(raw);
  if (parts) {
    const [, year, month, day] = parts.map(Number);
    return edge === 'end'
      ? new Date(year, month - 1, day, 23, 59, 59, 999)
      : new Date(year, month - 1, day, 0, 0, 0, 0);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw fail(422, `A valid ${edge} date is required.`, edge === 'end' ? 'INVALID_END_DATE' : 'INVALID_START_DATE');
  }
  return parsed;
}

/** Rules written before `targetMetric` existed are sales-value targets. */
export function metricOf(rule) {
  const metric = rule?.targetMetric;
  if (TARGET_METRICS.includes(metric)) return metric;
  if (LEGACY_SALES_TRIGGERS.includes(rule?.triggerEvent)) return 'sales';
  return 'sales';
}

export function triggerEventFor(metric, period) {
  if (metric === 'sales') return SALES_TRIGGER_BY_PERIOD[period] || 'monthly_sales';
  return METRIC_META[metric]?.triggerEvent || 'target_achieved';
}

export function unitOf(metric) {
  return METRIC_META[metric]?.unit || 'currency';
}

/**
 * How much of the target the executive has actually done, in the window the
 * rule is valid for. Sales/collections are rupee sums; orders/visits are counts.
 */
export async function computeAchievement({ branchId, executiveId, metric, from, to }) {
  const branch = objectId(branchId);
  const executive = objectId(executiveId);
  const window = { $gte: new Date(from), $lte: new Date(to) };

  switch (metric) {
    case 'orders':
      return SalesOrder.countDocuments({
        branch,
        salesExecutive: executive,
        orderDate: window,
        status: { $nin: ['draft', 'cancelled'] },
      });

    case 'visits':
      return DealerVisit.countDocuments({
        branch,
        salesExecutive: executive,
        status: 'completed',
        checkInAt: window,
      });

    case 'collections': {
      const [row] = await Payment.aggregate([
        {
          $match: {
            branch,
            collectedBy: executive,
            paymentType: 'dealer_receipt',
            status: 'confirmed',
            paymentDate: window,
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      return round2(row?.total || 0);
    }

    case 'sales':
    default: {
      const [row] = await SalesOrder.aggregate([
        {
          $match: {
            branch,
            salesExecutive: executive,
            orderDate: window,
            status: { $nin: ['draft', 'cancelled'] },
          },
        },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } },
      ]);
      return round2(row?.total || 0);
    }
  }
}

/**
 * The status the UI should show. `Incentive.status` only tracks the rule's own
 * lifecycle, so achievement and the validity window are folded in here.
 */
export function deriveStatus(rule, isAchieved, now = new Date()) {
  if (rule.status === 'paused') return 'paused';
  if (rule.status === 'closed') return 'closed';
  if (isAchieved) return 'completed';
  if (new Date(rule.validTo) < now) return 'expired';
  if (new Date(rule.validFrom) > now) return 'scheduled';
  return 'active';
}

function progressOf(targetValue, achievedValue) {
  const target = round2(targetValue);
  const achieved = round2(achievedValue);
  return {
    targetValue: target,
    achievedValue: achieved,
    remainingValue: round2(Math.max(0, target - achieved)),
    progressPercent: target > 0 ? round2((achieved / target) * 100) : 0,
    isAchieved: target > 0 && achieved >= target,
  };
}

/**
 * Turn one rule into one row per executive it applies to. A rule with an empty
 * `specificUsers` applies to every sales executive in the branch, so it is
 * expanded the same way — a target is always a per-person number, never a pooled
 * one, and pooling them would overstate progress.
 */
export async function expandRule({ rule, branchId, executiveDirectory, now = new Date() }) {
  const metric = metricOf(rule);
  const explicit = (rule.specificUsers || []).map(String).filter(Boolean);
  const shared = explicit.length !== 1;
  const executiveIds = explicit.length ? explicit : [...executiveDirectory.keys()];

  return Promise.all(executiveIds.map(async (executiveId) => {
    const achievedValue = await computeAchievement({
      branchId,
      executiveId,
      metric,
      from: rule.validFrom,
      to: rule.validTo,
    });
    const progress = progressOf(rule.targetValue, achievedValue);
    const executive = executiveDirectory.get(String(executiveId)) || null;
    return {
      // Row identity: a shared rule produces several rows off one rule id.
      rowKey: `${rule._id}:${executiveId}`,
      _id: rule._id,
      incentiveCode: rule.incentiveCode,
      title: rule.incentiveName,
      salesExecutive: executive,
      targetMetric: metric,
      metricLabel: METRIC_META[metric]?.label || metric,
      unit: unitOf(metric),
      period: rule.period,
      startDate: rule.validFrom,
      endDate: rule.validTo,
      bonusOnTarget: round2(rule.bonusOnTarget),
      notes: rule.remarks || '',
      ruleStatus: rule.status,
      // A shared rule covers every executive, so editing it from a single row
      // would silently change everyone else's target. The UI locks these.
      shared,
      ...progress,
      // Legacy aliases so existing table columns keep rendering.
      targetAmount: progress.targetValue,
      achievedAmount: progress.achievedValue,
      status: deriveStatus(rule, progress.isAchieved, now),
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }));
}

/** Name/email lookup for every sales executive, used to fill rows. */
export async function loadExecutiveDirectory(extraIds = []) {
  const filter = {
    $or: [
      { role: 'sales_executive', status: 'Active' },
      ...(extraIds.length ? [{ _id: { $in: extraIds.map(objectId) } }] : []),
    ],
  };
  const users = await User.find(filter).select('name email phone role status').lean();
  return new Map(users.map((user) => [String(user._id), {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
  }]));
}

/** Every target row in a branch, newest window first. */
export async function listTargetRows({ branchId, filter = {}, now = new Date() }) {
  const rules = await Incentive.find({ branch: objectId(branchId), ...TARGET_RULE_MATCH, ...filter })
    .sort({ validTo: -1, createdAt: -1 })
    .lean();
  const referenced = rules.flatMap((rule) => (rule.specificUsers || []));
  const executiveDirectory = await loadExecutiveDirectory(referenced);
  const rows = await Promise.all(
    rules.map((rule) => expandRule({ rule, branchId, executiveDirectory, now })),
  );
  return rows.flat();
}

/**
 * Progress for one executive — the app's view. Same rules, same math as the
 * admin list, filtered to rules that currently apply to this executive.
 */
export async function listMyTargetProgress({ branchId, executiveId, now = new Date() }) {
  const rules = await Incentive.find({
    branch: objectId(branchId),
    ...TARGET_RULE_MATCH,
    status: 'active',
    targetValue: { $gt: 0 },
    validFrom: { $lte: now },
    validTo: { $gte: now },
    $or: [
      { specificUsers: objectId(executiveId) },
      { specificUsers: { $size: 0 } },
      { specificUsers: { $exists: false } },
    ],
  }).sort({ validTo: 1, createdAt: -1 }).lean();

  return Promise.all(rules.map(async (rule) => {
    const metric = metricOf(rule);
    const achievedValue = await computeAchievement({
      branchId,
      executiveId,
      metric,
      from: rule.validFrom,
      to: rule.validTo,
    });
    const progress = progressOf(rule.targetValue, achievedValue);
    return {
      incentiveId: rule._id,
      incentiveName: rule.incentiveName,
      targetMetric: metric,
      metricLabel: METRIC_META[metric]?.label || metric,
      unit: unitOf(metric),
      triggerEvent: rule.triggerEvent,
      period: rule.period,
      periodStart: rule.validFrom,
      periodEnd: rule.validTo,
      bonusOnTarget: round2(rule.bonusOnTarget),
      ...progress,
      // Legacy aliases the app already reads.
      targetAmount: progress.targetValue,
      achievedAmount: progress.achievedValue,
      remainingAmount: progress.remainingValue,
    };
  }));
}

/**
 * Validate and normalise an admin target payload into Incentive fields.
 * `partial` is used on update so untouched fields are left alone.
 */
export async function buildRulePayload(body, { partial = false } = {}) {
  const payload = {};
  const has = (field) => body[field] !== undefined;

  if (has('targetMetric') || !partial) {
    const metric = body.targetMetric || body.targetType || 'sales';
    if (!TARGET_METRICS.includes(metric)) {
      throw fail(422, `targetMetric must be one of: ${TARGET_METRICS.join(', ')}.`, 'INVALID_TARGET_METRIC');
    }
    payload.targetMetric = metric;
  }

  if (has('salesExecutive') || has('specificUsers') || !partial) {
    const raw = has('specificUsers') ? body.specificUsers : [body.salesExecutive];
    const ids = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(String);
    if (ids.length !== 1) {
      throw fail(422, 'A target must be assigned to exactly one sales executive.', 'TARGET_NEEDS_ONE_EXECUTIVE');
    }
    if (!mongoose.isValidObjectId(ids[0])) {
      throw fail(422, 'Invalid sales executive id.', 'INVALID_EXECUTIVE');
    }
    const executive = await User.findById(ids[0]).select('name role status').lean();
    if (!executive) throw fail(404, 'Sales executive not found.', 'EXECUTIVE_NOT_FOUND');
    if (executive.role !== 'sales_executive') {
      throw fail(422, `${executive.name} is not a sales executive.`, 'NOT_A_SALES_EXECUTIVE');
    }
    if (executive.status !== 'Active') {
      throw fail(422, `${executive.name} is deactivated and cannot be given a target.`, 'EXECUTIVE_INACTIVE');
    }
    payload.specificUsers = [objectId(ids[0])];
  }

  if (has('title') || has('incentiveName') || !partial) {
    const title = String(body.title ?? body.incentiveName ?? '').trim();
    if (!title) throw fail(422, 'Target title is required.', 'TITLE_REQUIRED');
    payload.incentiveName = title;
  }

  if (has('targetValue') || has('targetAmount') || !partial) {
    const value = Number(body.targetValue ?? body.targetAmount);
    if (!Number.isFinite(value) || value <= 0) {
      throw fail(422, 'Target value must be a number greater than zero.', 'INVALID_TARGET_VALUE');
    }
    payload.targetValue = round2(value);
  }

  if (has('bonusOnTarget')) {
    const bonus = Number(body.bonusOnTarget);
    if (!Number.isFinite(bonus) || bonus < 0) {
      throw fail(422, 'Bonus on target cannot be negative.', 'INVALID_BONUS');
    }
    payload.bonusOnTarget = round2(bonus);
  }

  if (has('period')) {
    const allowed = ['monthly', 'quarterly', 'half_yearly', 'annual', 'one_time'];
    if (!allowed.includes(body.period)) {
      throw fail(422, `period must be one of: ${allowed.join(', ')}.`, 'INVALID_PERIOD');
    }
    payload.period = body.period;
  }

  if (has('startDate') || has('validFrom') || !partial) {
    payload.validFrom = parseBoundary(body.startDate ?? body.validFrom, 'start');
  }
  if (has('endDate') || has('validTo') || !partial) {
    payload.validTo = parseBoundary(body.endDate ?? body.validTo, 'end');
  }

  if (has('notes') || has('remarks')) {
    payload.remarks = String(body.notes ?? body.remarks ?? '').trim();
  }

  return payload;
}

/** Cross-field checks that need the merged (existing + incoming) document. */
export function assertRuleCoherent(rule) {
  if (new Date(rule.validTo) <= new Date(rule.validFrom)) {
    throw fail(422, 'Target end date must be after the start date.', 'INVALID_DATE_RANGE');
  }
}

export { fail as targetError, round2 as roundTarget };
