import mongoose from 'mongoose';
import Incentive from '../models/Incentive.js';
import IncentiveEarning from '../models/IncentiveEarning.js';
import DealerEmployee from '../models/DealerEmployee.js';
import Dealer from '../models/Dealer.js';
import DealerOrderRequest from '../models/DealerOrderRequest.js';
import PaymentIntimation from '../models/PaymentIntimation.js';
import SalesOrder from '../models/SalesOrder.js';
import Product from '../models/Product.js';
import { parseBoundary } from './targetService.js';

/**
 * dealerTargetService — targets and incentives a DEALER sets for its OWN employees.
 *
 * Targets are not a separate collection. Like Sales Executive targets (see
 * services/targetService.js) they are `Incentive` documents, but with
 * `applicableTo: 'dealer_employee'` and a `dealer` owner. That distinction is the
 * security boundary: every query here filters by `dealer`, so one dealer can
 * never read or write another dealer's targets.
 *
 * HOW ACHIEVEMENT IS MEASURED — and why it differs from the SE version
 *
 * The SE service reads `SalesOrder.salesExecutive`, `DealerVisit.salesExecutive`
 * and `Payment.collectedBy` — all staff `User` references. A dealer employee is
 * not a User and appears in none of those fields. What a dealer employee actually
 * produces is:
 *
 *   order requests   DealerOrderRequest.createdByEmployee
 *   payments         PaymentIntimation.createdByEmployee
 *   resulting sales  SalesOrders reached through those requests' `outcomes`
 *
 * `DealerOrderRequest` carries NO prices — a request is a quantity ask that staff
 * price later when they raise the quotation. So:
 *
 *   - `sales` is measured from the SalesOrders the requests became, never from
 *     the requests themselves. A request that was never converted contributes
 *     nothing, which is correct: it earned the dealer nothing yet.
 *   - `product` / `category` targets are measured in BOXES, not rupees, because
 *     boxes are the only quantity a request reliably carries. See ITEM_UNIT below.
 *
 * There is no `visits` metric: nothing in the dealer app records a visit, and
 * inventing one from order activity would be a different number wearing the same
 * label.
 */

/** Metrics a dealer can set for an employee. */
export const DEALER_TARGET_METRICS = ['sales', 'orders', 'collections', 'product', 'category'];

/**
 * `scope` is 'product' or 'category' when the metric needs the dealer to pick
 * what it covers, and null otherwise.
 */
export const DEALER_METRIC_META = {
  sales: { label: 'Sales Value', unit: 'currency', scope: null },
  orders: { label: 'Order Requests', unit: 'count', scope: null },
  collections: { label: 'Collections', unit: 'currency', scope: null },
  product: { label: 'Product Quantity', unit: 'boxes', scope: 'product' },
  category: { label: 'Category Quantity', unit: 'boxes', scope: 'category' },
};

export const DEALER_TARGET_PERIODS = ['monthly', 'quarterly', 'half_yearly', 'annual', 'one_time'];

/** Quantity unit for product/category targets. See the header note. */
export const ITEM_UNIT = 'boxes';

/** Base query that identifies a dealer-employee target rule. */
export const DEALER_TARGET_RULE_MATCH = {
  applicableTo: 'dealer_employee',
  incentiveType: 'target',
};

/** Base query that identifies a dealer-employee incentive (payout) rule. */
export const DEALER_INCENTIVE_RULE_MATCH = {
  applicableTo: 'dealer_employee',
  incentiveType: { $ne: 'target' },
};

// Sales keeps the historical trigger events so a dealer rule reads the same way
// an SE rule does in reporting. The others map to the closest existing event.
const SALES_TRIGGER_BY_PERIOD = {
  monthly: 'monthly_sales',
  quarterly: 'quarterly_sales',
  half_yearly: 'annual_sales',
  annual: 'annual_sales',
  one_time: 'monthly_sales',
};

/** The `triggerEvent` an Incentive requires, derived from metric + period. */
export function triggerEventForDealer(metric, period) {
  if (metric === 'sales') return SALES_TRIGGER_BY_PERIOD[period] || 'monthly_sales';
  if (metric === 'orders') return 'order_created';
  if (metric === 'collections') return 'collection_target';
  return 'target_achieved';
}

const round2 = (value) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

const objectId = (value) => (value instanceof mongoose.Types.ObjectId
  ? value
  : new mongoose.Types.ObjectId(String(value)));

export function dealerTargetError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

const fail = dealerTargetError;

// ─────────────────────────────────────────────────────────────────────────────
// Achievement
// ─────────────────────────────────────────────────────────────────────────────

/** Sales orders a set of requests eventually produced. */
async function salesOrderIdsForRequests(dealerId, requestFilter) {
  const requests = await DealerOrderRequest.find({ dealer: dealerId, ...requestFilter })
    .select('outcomes sourceSalesOrder')
    .lean();

  return [...new Set(requests.flatMap((request) => [
    ...(request.outcomes || []).map((outcome) => outcome.salesOrder),
    request.sourceSalesOrder,
  ]).filter(Boolean).map(String))];
}

/** Product ids covered by a category scope, so item lines can be matched. */
async function productIdsForCategories(categoryIds = []) {
  if (!categoryIds.length) return [];
  const products = await Product.find({ category: { $in: categoryIds.map(objectId) } })
    .select('_id')
    .lean();
  return products.map((product) => product._id);
}

/** Sum item boxes across requests, optionally restricted to a product id set. */
async function sumItemBoxes(dealerId, employeeId, from, to, productIds) {
  const match = {
    dealer: objectId(dealerId),
    createdByEmployee: objectId(employeeId),
    submittedAt: { $gte: new Date(from), $lte: new Date(to) },
    status: { $ne: 'cancelled' },
  };

  const [row] = await DealerOrderRequest.aggregate([
    { $match: match },
    { $unwind: '$items' },
    ...(productIds
      ? [{ $match: { 'items.product': { $in: productIds.map(objectId) } } }]
      : []),
    { $group: { _id: null, total: { $sum: '$items.boxes' } } },
  ]);

  return round2(row?.total || 0);
}

/**
 * How much of a target the employee has actually done, inside the rule's window.
 *
 * @param {object} params
 * @param {string} params.dealerId
 * @param {string} params.employeeId
 * @param {string} params.metric
 * @param {string[]} [params.scopeProducts]
 * @param {string[]} [params.scopeCategories]
 * @param {Date} params.from
 * @param {Date} params.to
 */
export async function computeDealerAchievement({
  dealerId,
  employeeId,
  metric,
  scopeProducts = [],
  scopeCategories = [],
  from,
  to,
}) {
  const window = { $gte: new Date(from), $lte: new Date(to) };

  switch (metric) {
    // Requests raised by this employee, excluding ones the dealer cancelled.
    case 'orders':
      return DealerOrderRequest.countDocuments({
        dealer: objectId(dealerId),
        createdByEmployee: objectId(employeeId),
        submittedAt: window,
        status: { $ne: 'cancelled' },
      });

    // Intimations this employee submitted, excluding ones accounts rejected —
    // a rejected intimation is not money the employee collected.
    case 'collections': {
      const [row] = await PaymentIntimation.aggregate([
        {
          $match: {
            dealer: objectId(dealerId),
            createdByEmployee: objectId(employeeId),
            paymentDate: window,
            status: { $ne: 'rejected' },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      return round2(row?.total || 0);
    }

    case 'product':
      return sumItemBoxes(dealerId, employeeId, from, to, scopeProducts);

    case 'category': {
      const productIds = await productIdsForCategories(scopeCategories);
      // A category with no products yet can only achieve zero.
      if (!productIds.length) return 0;
      return sumItemBoxes(dealerId, employeeId, from, to, productIds);
    }

    // Value of the orders this employee's requests became. Read from the Sales
    // Orders rather than the requests, because requests carry no prices.
    case 'sales':
    default: {
      const orderIds = await salesOrderIdsForRequests(dealerId, {
        createdByEmployee: objectId(employeeId),
      });
      if (!orderIds.length) return 0;

      const [row] = await SalesOrder.aggregate([
        {
          $match: {
            _id: { $in: orderIds.map(objectId) },
            dealer: objectId(dealerId),
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

/** The status the UI should show, folding achievement and the window together. */
export function deriveDealerTargetStatus(rule, isAchieved, now = new Date()) {
  if (rule.status === 'paused') return 'paused';
  if (rule.status === 'closed') return 'closed';
  if (isAchieved) return 'completed';
  if (new Date(rule.validTo) < now) return 'expired';
  if (new Date(rule.validFrom) > now) return 'scheduled';
  return 'active';
}

// ─────────────────────────────────────────────────────────────────────────────
// Employee directory
// ─────────────────────────────────────────────────────────────────────────────

/** Name/designation lookup for a dealer's employees, used to fill rows. */
export async function loadEmployeeDirectory(dealerId) {
  const employees = await DealerEmployee.find({ dealer: dealerId })
    .select('name employeeCode designation role status')
    .lean();
  return new Map(employees.map((employee) => [String(employee._id), {
    _id: employee._id,
    name: employee.name,
    employeeCode: employee.employeeCode,
    designation: employee.designation,
    role: employee.role,
    status: employee.status,
  }]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Row building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn one rule into one row per employee it applies to.
 *
 * An empty `specificDealerEmployees` means "every employee of this dealer", and
 * is expanded the same way. A target is always a per-person number — pooling a
 * team target into one figure would overstate every individual's progress.
 */
export async function expandDealerRule({ rule, dealerId, employeeDirectory, now = new Date() }) {
  const metric = DEALER_TARGET_METRICS.includes(rule.targetMetric) ? rule.targetMetric : 'sales';
  const explicit = (rule.specificDealerEmployees || []).map(String).filter(Boolean);
  const shared = explicit.length !== 1;
  const employeeIds = explicit.length ? explicit : [...employeeDirectory.keys()];

  return Promise.all(employeeIds.map(async (employeeId) => {
    const achievedValue = await computeDealerAchievement({
      dealerId,
      employeeId,
      metric,
      scopeProducts: rule.scopeProducts || [],
      scopeCategories: rule.scopeCategories || [],
      from: rule.validFrom,
      to: rule.validTo,
    });
    const progress = progressOf(rule.targetValue, achievedValue);
    const employee = employeeDirectory.get(String(employeeId)) || null;
    return {
      // A shared rule produces several rows off one rule id.
      rowKey: `${rule._id}:${employeeId}`,
      _id: rule._id,
      // Carried on the row so staff-facing listings can group across dealers
      // without re-deriving it from the rule.
      dealerId: rule.dealer || null,
      incentiveCode: rule.incentiveCode,
      title: rule.incentiveName,
      employee,
      targetMetric: metric,
      metricLabel: DEALER_METRIC_META[metric]?.label || metric,
      unit: DEALER_METRIC_META[metric]?.unit || 'currency',
      period: rule.period,
      startDate: rule.validFrom,
      endDate: rule.validTo,
      // Scope ids travel with the row so the edit form can prefill its pickers
      // without a second round trip.
      scopeProducts: (rule.scopeProducts || []).map(String),
      scopeCategories: (rule.scopeCategories || []).map(String),
      bonusOnTarget: round2(rule.bonusOnTarget),
      notes: rule.remarks || '',
      ruleStatus: rule.status,
      // A shared rule covers every employee, so editing it from one row would
      // silently change everyone else's target. The UI locks these.
      shared,
      ...progress,
      status: deriveDealerTargetStatus(rule, progress.isAchieved, now),
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }));
}

/** Every target row for a dealer, newest window first. */
export async function listDealerTargetRows({ dealerId, now = new Date() }) {
  const rules = await Incentive.find({
    dealer: objectId(dealerId),
    ...DEALER_TARGET_RULE_MATCH,
  })
    .sort({ validTo: -1, createdAt: -1 })
    .lean();

  const employeeDirectory = await loadEmployeeDirectory(dealerId);
  const rows = await Promise.all(
    rules.map((rule) => expandDealerRule({ rule, dealerId, employeeDirectory, now })),
  );
  return rows.flat();
}

/**
 * One employee's own target progress — the app's "My Target" view.
 * Same rules, same math as the dealer's team list, filtered to them.
 */
export async function listMyTargetProgress({ dealerId, employeeId, now = new Date() }) {
  const rules = await Incentive.find({
    dealer: objectId(dealerId),
    ...DEALER_TARGET_RULE_MATCH,
    status: 'active',
    targetValue: { $gt: 0 },
    validFrom: { $lte: now },
    validTo: { $gte: now },
    $or: [
      { specificDealerEmployees: objectId(employeeId) },
      { specificDealerEmployees: { $size: 0 } },
      { specificDealerEmployees: { $exists: false } },
    ],
  }).sort({ validTo: 1, createdAt: -1 }).lean();

  return Promise.all(rules.map(async (rule) => {
    const metric = DEALER_TARGET_METRICS.includes(rule.targetMetric) ? rule.targetMetric : 'sales';
    const achievedValue = await computeDealerAchievement({
      dealerId,
      employeeId,
      metric,
      scopeProducts: rule.scopeProducts || [],
      scopeCategories: rule.scopeCategories || [],
      from: rule.validFrom,
      to: rule.validTo,
    });
    const progress = progressOf(rule.targetValue, achievedValue);
    return {
      targetId: rule._id,
      title: rule.incentiveName,
      targetMetric: metric,
      metricLabel: DEALER_METRIC_META[metric]?.label || metric,
      unit: DEALER_METRIC_META[metric]?.unit || 'currency',
      period: rule.period,
      periodStart: rule.validFrom,
      periodEnd: rule.validTo,
      bonusOnTarget: round2(rule.bonusOnTarget),
      ...progress,
      status: deriveDealerTargetStatus(rule, progress.isAchieved, now),
    };
  }));
}

/**
 * Incentive this employee is currently eligible for.
 *
 * Computed live from the dealer's incentive rules rather than read from stored
 * earnings: a rule the dealer just changed should change what the employee sees
 * immediately. Recorded, approved payouts come from `listMyEarnings` instead, so
 * "eligible" and "paid" are never conflated.
 */
export async function listMyEligibleIncentives({ dealerId, employeeId, now = new Date() }) {
  const rules = await Incentive.find({
    dealer: objectId(dealerId),
    ...DEALER_INCENTIVE_RULE_MATCH,
    status: 'active',
    validFrom: { $lte: now },
    validTo: { $gte: now },
    $or: [
      { specificDealerEmployees: objectId(employeeId) },
      { specificDealerEmployees: { $size: 0 } },
      { specificDealerEmployees: { $exists: false } },
    ],
  }).sort({ validTo: 1 }).lean();

  return Promise.all(rules.map(async (rule) => {
    const metric = DEALER_TARGET_METRICS.includes(rule.targetMetric) ? rule.targetMetric : 'sales';
    const achievedValue = await computeDealerAchievement({
      dealerId,
      employeeId,
      metric,
      scopeProducts: rule.scopeProducts || [],
      scopeCategories: rule.scopeCategories || [],
      from: rule.validFrom,
      to: rule.validTo,
    });

    // `Incentive.calculate(value, qty)` reads only the argument its type needs:
    // percentage / target / milestone use `value`, per_unit uses `qty`. Which
    // argument carries the achievement depends on the metric, so both are filled
    // and the type picks the one it wants.
    const isQuantityMetric = metric === 'product' || metric === 'category';
    const baseValue = isQuantityMetric ? 0 : achievedValue;
    const baseQty = isQuantityMetric ? achievedValue : 0;
    // Milestone has no quantity form — it compares one achievement against each
    // tier — so it always reads the achievement as `value`. Without this special
    // case a product or category milestone would compare against 0 and never pay.
    const eligibleAmount = round2(
      rule.incentiveType === 'milestone'
        ? rule.calculate(achievedValue, 0)
        : rule.calculate(baseValue, baseQty),
    );

    return {
      incentiveId: rule._id,
      incentiveCode: rule.incentiveCode,
      name: rule.incentiveName,
      incentiveType: rule.incentiveType,
      triggerEvent: rule.triggerEvent,
      period: rule.period,
      periodStart: rule.validFrom,
      periodEnd: rule.validTo,
      targetMetric: metric,
      metricLabel: DEALER_METRIC_META[metric]?.label || metric,
      achievedValue,
      eligibleAmount,
      maxCap: round2(rule.maxCap),
      remarks: rule.remarks || '',
    };
  }));
}

/** Recorded incentive earnings for one employee — "My Incentive History". */
export async function listMyEarnings({ dealerId, employeeId }) {
  const earnings = await IncentiveEarning.find({
    dealer: objectId(dealerId),
    dealerEmployee: objectId(employeeId),
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return earnings.map((earning) => ({
    id: earning._id,
    incentiveName: earning.incentiveName,
    incentiveType: earning.incentiveType,
    triggerEvent: earning.triggerEvent,
    triggerReference: earning.triggerReference,
    earnedAmount: round2(earning.earnedAmount),
    baseValue: round2(earning.baseValue),
    baseQty: round2(earning.baseQty),
    calculationDetail: earning.calculationDetail,
    period: earning.period,
    paymentStatus: earning.paymentStatus,
    approvedAt: earning.approvedAt,
    paidAt: earning.paidAt,
    paymentRef: earning.paymentRef,
    remarks: earning.remarks,
    createdAt: earning.createdAt,
  }));
}

/** Totals for an employee's incentive history, so the app can show one number. */
export function summariseEarnings(earnings) {
  return earnings.reduce((totals, earning) => {
    totals.total += earning.earnedAmount;
    if (earning.paymentStatus === 'paid') totals.paid += earning.earnedAmount;
    else if (earning.paymentStatus === 'pending' || earning.paymentStatus === 'approved') {
      totals.pending += earning.earnedAmount;
    }
    return totals;
  }, { total: 0, paid: 0, pending: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and normalise a dealer target payload into Incentive fields.
 * `partial` is used on update so untouched fields are left alone.
 *
 * `dealerId` is always taken from the token by the caller — never from the body —
 * so a dealer cannot write a rule onto another dealer's account.
 */
export async function buildDealerRulePayload(body, { dealerId, employeeDirectory, partial = false } = {}) {
  const payload = {};
  const has = (field) => body[field] !== undefined;

  if (has('targetMetric') || !partial) {
    const metric = body.targetMetric || 'sales';
    if (!DEALER_TARGET_METRICS.includes(metric)) {
      throw fail(
        422,
        `targetMetric must be one of: ${DEALER_TARGET_METRICS.join(', ')}.`,
        'INVALID_TARGET_METRIC',
      );
    }
    payload.targetMetric = metric;
  }

  const metric = payload.targetMetric || body.targetMetric || 'sales';
  const scope = DEALER_METRIC_META[metric]?.scope;

  if (has('scopeProducts') || has('scopeCategories') || !partial) {
    const products = (Array.isArray(body.scopeProducts) ? body.scopeProducts : []).filter(Boolean).map(String);
    const categories = (Array.isArray(body.scopeCategories) ? body.scopeCategories : []).filter(Boolean).map(String);
    if ([...products, ...categories].some((id) => !mongoose.isValidObjectId(id))) {
      throw fail(422, 'One of the selected products or categories is invalid.', 'INVALID_SCOPE');
    }
    if (scope === 'product' && !products.length) {
      throw fail(422, 'Select at least one product for a product target.', 'SCOPE_REQUIRED');
    }
    if (scope === 'category' && !categories.length) {
      throw fail(422, 'Select at least one category for a category target.', 'SCOPE_REQUIRED');
    }
    // A scope on a metric that has none would silently do nothing, so drop it.
    payload.scopeProducts = scope === 'product' ? products.map(objectId) : [];
    payload.scopeCategories = scope === 'category' ? categories.map(objectId) : [];
  }

  if (has('employeeId') || has('specificDealerEmployees') || !partial) {
    const raw = has('specificDealerEmployees') ? body.specificDealerEmployees : [body.employeeId];
    const ids = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(String);
    if (ids.length !== 1) {
      throw fail(422, 'A target must be assigned to exactly one employee.', 'TARGET_NEEDS_ONE_EMPLOYEE');
    }
    if (!mongoose.isValidObjectId(ids[0])) {
      throw fail(422, 'Invalid employee id.', 'INVALID_EMPLOYEE');
    }
    // Authorise against the directory, which only contains THIS dealer's staff —
    // so assigning a target to another dealer's employee is impossible.
    const employee = employeeDirectory?.get(String(ids[0]));
    if (!employee) throw fail(404, 'Employee not found on this dealer account.', 'EMPLOYEE_NOT_FOUND');
    if (employee.status !== 'active') {
      throw fail(422, `${employee.name} is inactive and cannot be given a target.`, 'EMPLOYEE_INACTIVE');
    }
    payload.specificDealerEmployees = [objectId(ids[0])];
  }

  if (has('title') || has('incentiveName') || !partial) {
    const title = String(body.title ?? body.incentiveName ?? '').trim();
    if (!title) throw fail(422, 'Target title is required.', 'TITLE_REQUIRED');
    if (title.length > 150) throw fail(422, 'Target title is too long.', 'TITLE_TOO_LONG');
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

  if (has('period') || !partial) {
    const period = body.period || 'monthly';
    if (!DEALER_TARGET_PERIODS.includes(period)) {
      throw fail(422, `period must be one of: ${DEALER_TARGET_PERIODS.join(', ')}.`, 'INVALID_PERIOD');
    }
    payload.period = period;
  }

  if (has('startDate') || has('validFrom') || !partial) {
    payload.validFrom = parseBoundary(body.startDate ?? body.validFrom, 'start');
  }
  if (has('endDate') || has('validTo') || !partial) {
    payload.validTo = parseBoundary(body.endDate ?? body.validTo, 'end');
  }

  if (has('notes') || has('remarks')) {
    payload.remarks = String(body.notes ?? body.remarks ?? '').trim().slice(0, 1000);
  }

  return payload;
}

/** Cross-field checks that need the merged (existing + incoming) document. */
export function assertDealerRuleCoherent(rule) {
  if (new Date(rule.validTo) <= new Date(rule.validFrom)) {
    throw fail(422, 'Target end date must be after the start date.', 'INVALID_DATE_RANGE');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff-facing (BDMTILES) listings
//
// The dealer-facing functions above are all scoped to one dealer. These are for
// the admin side, which needs to see across dealers. They deliberately reuse the
// same expansion and the same achievement maths, so a figure an admin sees is the
// figure the dealer and the employee see.
// ─────────────────────────────────────────────────────────────────────────────

/** Name lookup for a set of dealers. */
export async function loadDealerDirectory(dealerIds = []) {
  const ids = dealerIds.map(String).filter(Boolean);
  if (!ids.length) return new Map();
  const dealers = await Dealer.find({ _id: { $in: ids.map(objectId) } })
    .select('businessName dealerCode status')
    .lean();
  return new Map(dealers.map((dealer) => [String(dealer._id), {
    _id: dealer._id,
    businessName: dealer.businessName,
    dealerCode: dealer.dealerCode,
    status: dealer.status,
  }]));
}

/**
 * Every dealer-employee target across dealers, for the admin listing.
 *
 * Paginated by RULE, not by expanded row: a rule covering every employee of a
 * dealer expands to many rows, and paginating the expansion would make the page
 * size depend on team size. The page is expanded after it is fetched, so a page
 * of 20 rules can render more than 20 rows — the caller is told the rule total.
 */
export async function listAllDealerTargetRows({ filter = {}, page = 1, limit = 20, now = new Date() } = {}) {
  const currentPage = Math.max(1, Number(page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(limit) || 20));
  const match = { ...DEALER_TARGET_RULE_MATCH, ...filter };

  const [rules, totalRules] = await Promise.all([
    Incentive.find(match)
      .sort({ validTo: -1, createdAt: -1 })
      .skip((currentPage - 1) * perPage)
      .limit(perPage)
      .lean(),
    Incentive.countDocuments(match),
  ]);

  const dealerIds = [...new Set(rules.map((rule) => String(rule.dealer || '')).filter(Boolean))];
  const dealerDirectory = await loadDealerDirectory(dealerIds);

  // One employee directory per dealer, loaded once rather than per rule.
  const employeeDirectories = new Map();
  await Promise.all(dealerIds.map(async (id) => {
    employeeDirectories.set(id, await loadEmployeeDirectory(id));
  }));

  const expanded = await Promise.all(rules.map((rule) => expandDealerRule({
    rule,
    dealerId: rule.dealer,
    employeeDirectory: employeeDirectories.get(String(rule.dealer || '')) || new Map(),
    now,
  })));

  return {
    rows: expanded.flat().map((row) => ({
      ...row,
      dealer: dealerDirectory.get(String(row.dealerId || '')) || null,
    })),
    pagination: {
      currentPage,
      totalPages: Math.ceil(totalRules / perPage),
      totalItems: totalRules,
      itemsPerPage: perPage,
    },
  };
}

/**
 * Headline counts for the admin page.
 *
 * Counted in the database rather than by expanding rules — a summary that had to
 * compute every employee's achievement would be far more expensive than the
 * number is worth.
 */
export async function dealerTargetSummary() {
  const base = { ...DEALER_TARGET_RULE_MATCH };
  const [totalRules, activeRules, pausedRules, closedRules, dealerIds, employeeIds] = await Promise.all([
    Incentive.countDocuments(base),
    Incentive.countDocuments({ ...base, status: 'active' }),
    Incentive.countDocuments({ ...base, status: 'paused' }),
    Incentive.countDocuments({ ...base, status: 'closed' }),
    Incentive.distinct('dealer', base),
    Incentive.distinct('specificDealerEmployees', base),
  ]);

  return {
    totalRules,
    activeRules,
    pausedRules,
    closedRules,
    dealersWithTargets: dealerIds.filter(Boolean).length,
    employeesWithTargets: employeeIds.filter(Boolean).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule codes
// ─────────────────────────────────────────────────────────────────────────────

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Next rule code for a dealer, e.g. `DT-DLR00001-0004`.
 *
 * The dealer code is embedded so the code stays unique even when two dealers
 * share a branch — the Incentive unique index is (branch, incentiveCode), and a
 * bare sequence would collide across dealers on the same branch.
 *
 * Shared by the dealer router and the staff router so a code issued by BDMTILES
 * cannot collide with one the dealer issued.
 */
export async function nextDealerIncentiveCode(dealerId, dealerCode) {
  const prefix = `DT-${(dealerCode || String(dealerId).slice(-6)).toUpperCase()}-`;
  const last = await Incentive.findOne({
    dealer: dealerId,
    incentiveCode: { $regex: `^${escapeRegex(prefix)}\\d+$` },
  }).sort({ incentiveCode: -1 }).select('incentiveCode').lean();

  const next = last?.incentiveCode
    ? (Number.parseInt(last.incentiveCode.slice(prefix.length), 10) || 0) + 1
    : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

export { round2 as roundDealerTarget };
