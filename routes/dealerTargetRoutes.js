import { Router } from 'express';
import mongoose from 'mongoose';
import Incentive from '../models/Incentive.js';
import IncentiveEarning from '../models/IncentiveEarning.js';
import DealerEmployee from '../models/DealerEmployee.js';
import Product from '../models/Product.js';
import Category from '../models/Category.js';
import { protectDealer } from '../middleware/dealerAuth.js';
import {
  requireAnyDealerPermission,
  requireDealerPermission,
} from '../middleware/dealerPermission.js';
import { resolveDealerBranch } from '../services/dealerAssignmentService.js';
import {
  DEALER_METRIC_META,
  DEALER_TARGET_PERIODS,
  DEALER_TARGET_RULE_MATCH,
  DEALER_INCENTIVE_RULE_MATCH,
  DEALER_TARGET_METRICS,
  assertDealerRuleCoherent,
  buildDealerRulePayload,
  computeDealerAchievement,
  dealerTargetError,
  listDealerTargetRows,
  listMyEarnings,
  listMyEligibleIncentives,
  listMyTargetProgress,
  loadEmployeeDirectory,
  nextDealerIncentiveCode,
  roundDealerTarget,
  summariseEarnings,
  triggerEventForDealer,
} from '../services/dealerTargetService.js';

/**
 * Dealer App — targets and incentives a dealer sets for its own employees.
 *
 * Mounted at /api/v1/dealer-app/targets. Two audiences share this router:
 *
 *   the dealer        authors targets, configures incentives, sees the whole team
 *   the employee      sees only their own target, achievement and incentive
 *
 * The separation is enforced two ways: every query filters by `req.dealerId`
 * (from the token, never the body), and the `me/*` routes always resolve the
 * employee from the token rather than accepting an id — so an employee can never
 * read a colleague's numbers by guessing a parameter.
 */
const router = Router();
router.use(protectDealer);

const sendError = (res, error) => res.status(
  error.status || (error.code === 11000 ? 409 : error.name === 'CastError' ? 422 : 500),
).json({
  success: false,
  code: error.code,
  message: error.name === 'CastError' ? 'Invalid identifier.' : error.message,
});

const objectId = (value) => new mongoose.Types.ObjectId(String(value));

/** Load a rule, proving it belongs to this dealer. */
async function findOwnedRule(dealerId, ruleId, match) {
  if (!mongoose.isValidObjectId(ruleId)) {
    throw dealerTargetError(422, 'Invalid identifier.', 'INVALID_ID');
  }
  const rule = await Incentive.findOne({ _id: ruleId, dealer: dealerId, ...match }).lean();
  if (!rule) throw dealerTargetError(404, 'This rule was not found on your account.', 'RULE_NOT_FOUND');
  return rule;
}

/** The employee the caller is signed in as, or null when they are the owner. */
const callerEmployeeId = (req) => req.dealerEmployee?._id || null;

// ─────────────────────────────────────────────────────────────────────────────
// Meta — what the authoring form needs
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-app/targets/meta
router.get('/meta', requireAnyDealerPermission('targets.manage', 'performance.view'), async (req, res) => {
  try {
    const [employees, products, categories] = await Promise.all([
      DealerEmployee.find({ dealer: req.dealerId })
        .select('name employeeCode designation role status')
        .sort({ name: 1 })
        .lean(),
      Product.find({ status: 'active' }).select('itemName productCode unit category').limit(2000).lean(),
      Category.find({ status: 'active' }).select('name').limit(500).lean(),
    ]);

    res.json({
      success: true,
      data: {
        metrics: DEALER_TARGET_METRICS.map((metric) => ({
          value: metric,
          label: DEALER_METRIC_META[metric].label,
          unit: DEALER_METRIC_META[metric].unit,
          scope: DEALER_METRIC_META[metric].scope,
        })),
        periods: DEALER_TARGET_PERIODS,
        employees,
        products: products.map((product) => ({
          _id: product._id,
          name: product.itemName,
          code: product.productCode,
          unit: product.unit,
          category: product.category,
        })),
        categories: categories.map((category) => ({ _id: category._id, name: category.name })),
        // Makes the boxes-vs-rupees distinction visible in the UI rather than
        // leaving the dealer to infer it.
        itemUnit: 'boxes',
      },
    });
  } catch (error) { return sendError(res, error); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Employee-facing — "My Target" / "My Incentive"
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-app/targets/me
router.get('/me', requireDealerPermission('targets.view'), async (req, res) => {
  try {
    // An owner has no personal target, so this is empty for them by design.
    const employeeId = callerEmployeeId(req);
    if (!employeeId) return res.json({ success: true, data: [], summary: null });

    const targets = await listMyTargetProgress({ dealerId: req.dealerId, employeeId });
    const achieved = targets.filter((target) => target.isAchieved).length;

    return res.json({
      success: true,
      data: targets,
      summary: {
        total: targets.length,
        achieved,
        inProgress: targets.length - achieved,
        // Sum of the per-target bonus the employee stands to earn. A headline
        // number only — the authoritative figure is per target.
        potentialBonus: roundDealerTarget(
          targets.reduce((sum, target) => sum + (target.bonusOnTarget || 0), 0),
        ),
      },
    });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/dealer-app/targets/me/incentives
router.get('/me/incentives', requireDealerPermission('incentives.view'), async (req, res) => {
  try {
    const employeeId = callerEmployeeId(req);
    if (!employeeId) {
      return res.json({ success: true, data: { eligible: [], history: [], totals: { total: 0, paid: 0, pending: 0 } } });
    }

    const [eligible, history] = await Promise.all([
      listMyEligibleIncentives({ dealerId: req.dealerId, employeeId }),
      listMyEarnings({ dealerId: req.dealerId, employeeId }),
    ]);

    return res.json({
      success: true,
      data: {
        // What the rules currently say this employee has earned. Recomputed live,
        // so a rule the dealer just changed is reflected immediately.
        eligible,
        eligibleTotal: roundDealerTarget(
          eligible.reduce((sum, item) => sum + (item.eligibleAmount || 0), 0),
        ),
        // What the dealer has actually recorded and paid.
        history,
        totals: summariseEarnings(history),
      },
    });
  } catch (error) { return sendError(res, error); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dealer-facing — team targets
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-app/targets
router.get('/', requireDealerPermission('performance.view'), async (req, res) => {
  try {
    const rows = await listDealerTargetRows({ dealerId: req.dealerId });
    const filtered = req.query.employeeId
      ? rows.filter((row) => String(row.employee?._id) === String(req.query.employeeId))
      : rows;

    const achieved = filtered.filter((row) => row.isAchieved).length;
    return res.json({
      success: true,
      data: filtered,
      summary: {
        total: filtered.length,
        achieved,
        inProgress: filtered.length - achieved,
      },
    });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/dealer-app/targets
router.post('/', requireDealerPermission('targets.manage'), async (req, res) => {
  try {
    const employeeDirectory = await loadEmployeeDirectory(req.dealerId);
    const payload = await buildDealerRulePayload(req.body, {
      dealerId: req.dealerId,
      employeeDirectory,
    });
    assertDealerRuleCoherent(payload);

    // A dealer rule still needs a branch: the Incentive collection is branch-
    // indexed and shared with SE rules. It is derived, never taken from the body.
    const branch = await resolveDealerBranch(req.dealer);

    const rule = await Incentive.create({
      ...payload,
      incentiveCode: await nextDealerIncentiveCode(req.dealerId, req.dealer.dealerCode),
      incentiveName: payload.incentiveName,
      branch: branch || undefined,
      dealer: req.dealerId,
      applicableTo: 'dealer_employee',
      incentiveType: 'target',
      triggerEvent: triggerEventForDealer(payload.targetMetric, payload.period),
      status: 'active',
    });

    const rows = await listDealerTargetRows({ dealerId: req.dealerId });
    const created = rows.filter((row) => String(row._id) === String(rule._id));
    return res.status(201).json({
      success: true,
      message: `Target "${rule.incentiveName}" assigned.`,
      data: created,
    });
  } catch (error) { return sendError(res, error); }
});

// PUT /api/v1/dealer-app/targets/:id
router.put('/:id', requireDealerPermission('targets.manage'), async (req, res) => {
  try {
    const existing = await findOwnedRule(req.dealerId, req.params.id, DEALER_TARGET_RULE_MATCH);
    const employeeDirectory = await loadEmployeeDirectory(req.dealerId);
    const payload = await buildDealerRulePayload(req.body, {
      dealerId: req.dealerId,
      employeeDirectory,
      partial: true,
    });
    assertDealerRuleCoherent({ ...existing, ...payload });

    if (payload.targetMetric) {
      payload.triggerEvent = triggerEventForDealer(
        payload.targetMetric,
        payload.period || existing.period,
      );
    } else if (payload.period) {
      payload.triggerEvent = triggerEventForDealer(existing.targetMetric || 'sales', payload.period);
    }

    await Incentive.updateOne({ _id: existing._id, dealer: req.dealerId }, { $set: payload });
    const rows = await listDealerTargetRows({ dealerId: req.dealerId });
    return res.json({
      success: true,
      message: 'Target updated.',
      data: rows.filter((row) => String(row._id) === String(existing._id)),
    });
  } catch (error) { return sendError(res, error); }
});

// PATCH /api/v1/dealer-app/targets/:id/status  { status }
router.patch('/:id/status', requireDealerPermission('targets.manage'), async (req, res) => {
  try {
    const status = ['active', 'paused', 'closed'].includes(req.body?.status) ? req.body.status : null;
    if (!status) throw dealerTargetError(422, 'status must be active, paused or closed.', 'INVALID_STATUS');

    const existing = await findOwnedRule(req.dealerId, req.params.id, DEALER_TARGET_RULE_MATCH);
    await Incentive.updateOne({ _id: existing._id, dealer: req.dealerId }, { $set: { status } });

    const rows = await listDealerTargetRows({ dealerId: req.dealerId });
    return res.json({
      success: true,
      message: `Target ${status}.`,
      data: rows.filter((row) => String(row._id) === String(existing._id)),
    });
  } catch (error) { return sendError(res, error); }
});

// DELETE /api/v1/dealer-app/targets/:id
router.delete('/:id', requireDealerPermission('targets.manage'), async (req, res) => {
  try {
    const existing = await findOwnedRule(req.dealerId, req.params.id, DEALER_TARGET_RULE_MATCH);
    await Incentive.deleteOne({ _id: existing._id, dealer: req.dealerId });
    return res.json({ success: true, message: 'Target removed.' });
  } catch (error) { return sendError(res, error); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dealer-facing — one employee's performance
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-app/targets/employees/:id/performance
router.get('/employees/:id/performance', requireDealerPermission('performance.view'), async (req, res) => {
  try {
    // Scoped to this dealer, so another dealer's employee id resolves to nothing.
    const employee = await DealerEmployee.findOne({ _id: req.params.id, dealer: req.dealerId })
      .select('name employeeCode designation role status joiningDate')
      .lean();
    if (!employee) throw dealerTargetError(404, 'Employee not found on this dealer account.', 'EMPLOYEE_NOT_FOUND');

    const [targets, eligible, history] = await Promise.all([
      listMyTargetProgress({ dealerId: req.dealerId, employeeId: employee._id }),
      listMyEligibleIncentives({ dealerId: req.dealerId, employeeId: employee._id }),
      listMyEarnings({ dealerId: req.dealerId, employeeId: employee._id }),
    ]);

    // A 12-month orders/collections trend, so the dealer can see the shape of the
    // employee's work rather than only the current window.
    const now = new Date();
    const trend = await Promise.all(
      Array.from({ length: 12 }).map(async (_, index) => {
        const start = new Date(now.getFullYear(), now.getMonth() - (11 - index), 1, 0, 0, 0, 0);
        const end = new Date(now.getFullYear(), now.getMonth() - (11 - index) + 1, 0, 23, 59, 59, 999);
        const [sales, orders, collections] = await Promise.all([
          computeDealerAchievement({ dealerId: req.dealerId, employeeId: employee._id, metric: 'sales', from: start, to: end }),
          computeDealerAchievement({ dealerId: req.dealerId, employeeId: employee._id, metric: 'orders', from: start, to: end }),
          computeDealerAchievement({ dealerId: req.dealerId, employeeId: employee._id, metric: 'collections', from: start, to: end }),
        ]);
        return {
          month: start.toLocaleString('en-IN', { month: 'short' }),
          year: start.getFullYear(),
          sales,
          orders,
          collections,
        };
      }),
    );

    return res.json({
      success: true,
      data: {
        employee,
        targets,
        incentives: { eligible, eligibleTotal: roundDealerTarget(eligible.reduce((sum, item) => sum + (item.eligibleAmount || 0), 0)) },
        earnings: { history, totals: summariseEarnings(history) },
        trend,
      },
    });
  } catch (error) { return sendError(res, error); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dealer-facing — incentive rules and recorded payouts
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-app/targets/incentives
router.get('/incentives', requireDealerPermission('performance.view'), async (req, res) => {
  try {
    const rules = await Incentive.find({ dealer: req.dealerId, ...DEALER_INCENTIVE_RULE_MATCH })
      .sort({ validTo: -1, createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: rules.map((rule) => ({
        id: rule._id,
        incentiveCode: rule.incentiveCode,
        name: rule.incentiveName,
        incentiveType: rule.incentiveType,
        triggerEvent: rule.triggerEvent,
        period: rule.period,
        startDate: rule.validFrom,
        endDate: rule.validTo,
        status: rule.status,
        flatAmount: roundDealerTarget(rule.flatAmount),
        percentage: roundDealerTarget(rule.percentage),
        maxCap: roundDealerTarget(rule.maxCap),
        perUnitAmount: roundDealerTarget(rule.perUnitAmount),
        thresholdQty: roundDealerTarget(rule.thresholdQty),
        targetValue: roundDealerTarget(rule.targetValue),
        bonusOnTarget: roundDealerTarget(rule.bonusOnTarget),
        employeeIds: (rule.specificDealerEmployees || []).map(String),
        remarks: rule.remarks || '',
      })),
    });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/dealer-app/targets/incentives
router.post('/incentives', requireDealerPermission('incentives.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) throw dealerTargetError(422, 'Incentive name is required.', 'NAME_REQUIRED');

    const incentiveType = ['flat', 'percentage', 'per_unit', 'target', 'milestone'].includes(body.incentiveType)
      ? body.incentiveType
      : 'percentage';
    const period = DEALER_TARGET_PERIODS.includes(body.period) ? body.period : 'monthly';
    const metric = DEALER_TARGET_METRICS.includes(body.targetMetric) ? body.targetMetric : 'sales';

    const numeric = (value, label, { min = 0 } = {}) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min) {
        throw dealerTargetError(422, `${label} must be a number of at least ${min}.`, 'INVALID_AMOUNT');
      }
      return roundDealerTarget(parsed);
    };

    // Validate the employee scope against THIS dealer's directory, so an id from
    // another dealer can never be attached to a rule here.
    const employeeIds = (Array.isArray(body.employeeIds) ? body.employeeIds : []).filter(Boolean).map(String);
    if (employeeIds.some((id) => !mongoose.isValidObjectId(id))) {
      throw dealerTargetError(422, 'One of the selected employees is invalid.', 'INVALID_EMPLOYEE');
    }
    if (employeeIds.length) {
      const count = await DealerEmployee.countDocuments({ _id: { $in: employeeIds }, dealer: req.dealerId });
      if (count !== employeeIds.length) {
        throw dealerTargetError(422, 'One of the selected employees is not on this dealer account.', 'EMPLOYEE_NOT_FOUND');
      }
    }

    const payload = {
      incentiveName: name,
      incentiveType,
      period,
      targetMetric: metric,
      validFrom: body.startDate ? new Date(body.startDate) : new Date(),
      validTo: body.endDate ? new Date(body.endDate) : new Date(),
      status: 'active',
      remarks: String(body.remarks || '').trim().slice(0, 1000),
    };
    if (Number.isNaN(payload.validFrom.getTime()) || Number.isNaN(payload.validTo.getTime())) {
      throw dealerTargetError(422, 'Enter valid start and end dates.', 'INVALID_DATE');
    }
    if (payload.validTo <= payload.validFrom) {
      throw dealerTargetError(422, 'End date must be after the start date.', 'INVALID_DATE_RANGE');
    }

    if (incentiveType === 'flat') payload.flatAmount = numeric(body.flatAmount, 'Flat amount');
    if (incentiveType === 'percentage') {
      payload.percentage = numeric(body.percentage, 'Percentage');
      payload.maxCap = body.maxCap === undefined ? 0 : numeric(body.maxCap, 'Maximum cap');
    }
    if (incentiveType === 'per_unit') {
      payload.perUnitAmount = numeric(body.perUnitAmount, 'Per-unit amount');
      payload.thresholdQty = body.thresholdQty === undefined ? 0 : numeric(body.thresholdQty, 'Threshold quantity');
    }
    if (incentiveType === 'target') payload.bonusOnTarget = numeric(body.bonusOnTarget, 'Bonus on target');
    if (incentiveType === 'milestone') {
      const milestones = Array.isArray(body.milestones) ? body.milestones : [];
      if (!milestones.length) throw dealerTargetError(422, 'Add at least one milestone.', 'MILESTONE_REQUIRED');
      payload.milestones = milestones.map((milestone) => ({
        milestoneName: String(milestone.milestoneName || '').trim(),
        targetValue: numeric(milestone.targetValue, 'Milestone target'),
        bonusAmount: numeric(milestone.bonusAmount, 'Milestone bonus'),
      }));
    }

    const branch = await resolveDealerBranch(req.dealer);
    const rule = await Incentive.create({
      ...payload,
      incentiveCode: await nextDealerIncentiveCode(req.dealerId, req.dealer.dealerCode),
      branch: branch || undefined,
      dealer: req.dealerId,
      applicableTo: 'dealer_employee',
      specificDealerEmployees: employeeIds,
      triggerEvent: triggerEventForDealer(metric, period),
    });

    return res.status(201).json({ success: true, message: `Incentive "${rule.incentiveName}" created.`, data: { id: rule._id } });
  } catch (error) { return sendError(res, error); }
});

// DELETE /api/v1/dealer-app/targets/incentives/:id
router.delete('/incentives/:id', requireDealerPermission('incentives.manage'), async (req, res) => {
  try {
    const existing = await findOwnedRule(req.dealerId, req.params.id, DEALER_INCENTIVE_RULE_MATCH);
    await Incentive.deleteOne({ _id: existing._id, dealer: req.dealerId });
    return res.json({ success: true, message: 'Incentive removed.' });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/dealer-app/targets/earnings
//
// Records a payout the dealer has decided on. The amount is supplied by the
// dealer rather than recomputed here: eligibility is advisory, and the dealer may
// round, adjust or pay something different — so what is stored is what was agreed.
router.post('/earnings', requireDealerPermission('incentives.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const employeeId = body.employeeId;
    if (!mongoose.isValidObjectId(employeeId)) {
      throw dealerTargetError(422, 'Select an employee.', 'INVALID_EMPLOYEE');
    }
    const employee = await DealerEmployee.findOne({ _id: employeeId, dealer: req.dealerId })
      .select('name')
      .lean();
    if (!employee) throw dealerTargetError(404, 'Employee not found on this dealer account.', 'EMPLOYEE_NOT_FOUND');

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw dealerTargetError(422, 'Enter an incentive amount greater than zero.', 'INVALID_AMOUNT');
    }

    // Optional link to the rule it came from, validated against this dealer.
    let rule = null;
    if (body.incentiveId && mongoose.isValidObjectId(body.incentiveId)) {
      rule = await Incentive.findOne({ _id: body.incentiveId, dealer: req.dealerId }).select('incentiveName incentiveType triggerEvent').lean();
    }

    const earning = await IncentiveEarning.create({
      dealer: req.dealerId,
      dealerName: req.dealer.businessName,
      // The earner is a dealer employee, not a User — `earnedBy` is deliberately
      // left empty so the two identity spaces stay separate.
      dealerEmployee: employee._id,
      dealerEmployeeName: employee.name,
      earnedByRole: 'dealer_employee',
      incentive: rule?._id,
      incentiveName: rule?.incentiveName || String(body.incentiveName || 'Incentive').slice(0, 200),
      incentiveType: rule?.incentiveType || '',
      triggerEvent: rule?.triggerEvent || 'custom',
      triggerReference: String(body.triggerReference || '').slice(0, 300),
      baseValue: roundDealerTarget(body.baseValue),
      baseQty: roundDealerTarget(body.baseQty),
      earnedAmount: roundDealerTarget(amount),
      calculationDetail: String(body.calculationDetail || '').slice(0, 500),
      period: String(body.period || '').slice(0, 50),
      periodStart: body.periodStart ? new Date(body.periodStart) : undefined,
      periodEnd: body.periodEnd ? new Date(body.periodEnd) : undefined,
      paymentStatus: 'pending',
      remarks: String(body.remarks || '').slice(0, 500),
    });

    return res.status(201).json({
      success: true,
      message: `Incentive of ${roundDealerTarget(amount)} recorded for ${employee.name}.`,
      data: { id: earning._id },
    });
  } catch (error) { return sendError(res, error); }
});

// PATCH /api/v1/dealer-app/targets/earnings/:id/pay  { paymentRef? }
router.patch('/earnings/:id/pay', requireDealerPermission('incentives.manage'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw dealerTargetError(422, 'Invalid identifier.', 'INVALID_ID');
    }
    const earning = await IncentiveEarning.findOneAndUpdate(
      { _id: req.params.id, dealer: req.dealerId },
      {
        $set: {
          paymentStatus: 'paid',
          paidAt: new Date(),
          paymentRef: String(req.body?.paymentRef || '').slice(0, 200),
        },
      },
      { new: true },
    ).lean();

    if (!earning) throw dealerTargetError(404, 'That incentive record was not found.', 'EARNING_NOT_FOUND');
    return res.json({ success: true, message: 'Marked as paid.' });
  } catch (error) { return sendError(res, error); }
});

export default router;
