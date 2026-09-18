import { Router } from 'express';
import mongoose from 'mongoose';
import Incentive from '../models/Incentive.js';
import IncentiveEarning from '../models/IncentiveEarning.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import {
  TARGET_RULE_MATCH,
  TARGET_METRICS,
  METRIC_META,
  listTargetRows,
  expandRule,
  loadExecutiveDirectory,
  buildRulePayload,
  assertRuleCoherent,
  triggerEventFor,
  metricOf,
} from '../services/targetService.js';

/**
 * Sales Executive target authoring (SOW 18.7).
 *
 * These endpoints are a facade over `Incentive` documents with
 * `incentiveType: 'target'` — the very records the Sales Executive app reads via
 * GET /sales-executive/me/target-progress. Writing through this route therefore
 * shows up on the executive's phone immediately, with no second data store to
 * keep in sync.
 */
const router = Router();
router.use(protect);
router.use(requireBranch);

function sendError(res, error) {
  const status = error.status || (error.name === 'CastError' ? 422 : 500);
  const message = error.name === 'CastError' ? 'Invalid identifier.' : error.message;
  return res.status(status).json({ success: false, message, code: error.code });
}

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function findRule(branchId, id) {
  if (!mongoose.isValidObjectId(id)) throw fail(422, 'Invalid target id.', 'INVALID_ID');
  const rule = await Incentive.findOne({ _id: id, branch: branchId, ...TARGET_RULE_MATCH });
  if (!rule) throw fail(404, 'Target not found in the active branch.', 'TARGET_NOT_FOUND');
  return rule;
}

/**
 * A rule with zero or several executives is a shared rule. Editing it from a
 * per-executive row would silently rewrite everyone else's target, so those
 * edits are refused and the caller is told to use the incentive rule screen.
 */
function assertNotShared(rule) {
  const count = (rule.specificUsers || []).filter(Boolean).length;
  if (count !== 1) {
    throw fail(
      409,
      'This target is a shared incentive rule covering more than one executive. Edit it from Incentive Rules so the impact on every executive is visible.',
      'SHARED_TARGET_RULE',
    );
  }
}

// Metric options, so the UI labels and units come from the backend.
router.get('/meta', requirePermission('incentive.rules.view'), (_req, res) => res.json({
  success: true,
  data: {
    metrics: TARGET_METRICS.map((metric) => ({ value: metric, ...METRIC_META[metric] })),
    periods: ['monthly', 'quarterly', 'half_yearly', 'annual', 'one_time'],
    statuses: ['active', 'scheduled', 'completed', 'expired', 'paused', 'closed'],
  },
}));

// GET /api/v1/targets — one row per (target rule x executive), with live achievement.
router.get('/', requirePermission('incentive.rules.view'), async (req, res) => {
  try {
    const filter = {};
    if (req.query.targetMetric) {
      if (!TARGET_METRICS.includes(req.query.targetMetric)) {
        throw fail(422, `targetMetric must be one of: ${TARGET_METRICS.join(', ')}.`, 'INVALID_TARGET_METRIC');
      }
      filter.targetMetric = req.query.targetMetric;
    }
    if (req.query.ruleStatus) filter.status = req.query.ruleStatus;

    let rows = await listTargetRows({ branchId: req.branchId, filter });

    if (req.query.salesExecutive) {
      const wanted = String(req.query.salesExecutive);
      rows = rows.filter((row) => String(row.salesExecutive?._id || '') === wanted);
    }
    if (req.query.status) {
      rows = rows.filter((row) => row.status === req.query.status);
    }

    const summary = rows.reduce((acc, row) => {
      acc.totalTargets += 1;
      if (row.status === 'active') acc.active += 1;
      if (row.status === 'completed') acc.completed += 1;
      if (row.status === 'expired') acc.expired += 1;
      // Only currency metrics are meaningful to add up as money.
      if (row.unit === 'currency') {
        acc.totalTargetValue += row.targetValue;
        acc.totalAchievedValue += row.achievedValue;
      }
      return acc;
    }, { totalTargets: 0, active: 0, completed: 0, expired: 0, totalTargetValue: 0, totalAchievedValue: 0 });

    return res.json({ success: true, data: rows, summary });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/targets — author a per-executive target.
router.post('/', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    const payload = await buildRulePayload(req.body);
    assertRuleCoherent(payload);

    const metric = payload.targetMetric;
    const period = payload.period || req.body.period || 'monthly';
    const rule = await Incentive.create({
      ...payload,
      branch: req.branchId,
      applicableTo: 'sales_executive',
      incentiveType: 'target',
      period,
      triggerEvent: triggerEventFor(metric, period),
      incentiveCode: await generateBranchNumber(req.branchId, 'se_target', payload.validFrom),
      status: 'active',
      createdBy: req.user._id,
    });

    const executiveDirectory = await loadExecutiveDirectory(rule.specificUsers);
    const [row] = await expandRule({ rule: rule.toObject(), branchId: req.branchId, executiveDirectory });
    return res.status(201).json({ success: true, message: `Target ${rule.incentiveCode} created.`, data: row });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/targets/:id
router.get('/:id', requirePermission('incentive.rules.view'), async (req, res) => {
  try {
    const rule = await findRule(req.branchId, req.params.id);
    const executiveDirectory = await loadExecutiveDirectory(rule.specificUsers);
    const rows = await expandRule({ rule: rule.toObject(), branchId: req.branchId, executiveDirectory });
    return res.json({ success: true, data: rows.length === 1 ? rows[0] : rows });
  } catch (error) { return sendError(res, error); }
});

// PUT /api/v1/targets/:id
router.put('/:id', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    const rule = await findRule(req.branchId, req.params.id);
    assertNotShared(rule);

    const updates = await buildRulePayload(req.body, { partial: true });
    Object.assign(rule, updates);
    assertRuleCoherent(rule);
    // Keep triggerEvent consistent with whatever the metric/period now is, so the
    // app's progress query and any downstream earning logic still agree.
    rule.triggerEvent = triggerEventFor(metricOf(rule), rule.period);
    await rule.save();

    const executiveDirectory = await loadExecutiveDirectory(rule.specificUsers);
    const [row] = await expandRule({ rule: rule.toObject(), branchId: req.branchId, executiveDirectory });
    return res.json({ success: true, message: 'Target updated.', data: row });
  } catch (error) { return sendError(res, error); }
});

// PATCH /api/v1/targets/:id/status — pause / resume / close without losing history.
router.patch('/:id/status', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    const allowed = ['active', 'paused', 'closed'];
    if (!allowed.includes(req.body.status)) {
      throw fail(422, `status must be one of: ${allowed.join(', ')}.`, 'INVALID_STATUS');
    }
    const rule = await findRule(req.branchId, req.params.id);
    assertNotShared(rule);
    rule.status = req.body.status;
    await rule.save();

    const executiveDirectory = await loadExecutiveDirectory(rule.specificUsers);
    const [row] = await expandRule({ rule: rule.toObject(), branchId: req.branchId, executiveDirectory });
    return res.json({ success: true, message: `Target ${req.body.status}.`, data: row });
  } catch (error) { return sendError(res, error); }
});

// DELETE /api/v1/targets/:id — refused once the rule has paid-out history.
router.delete('/:id', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    const rule = await findRule(req.branchId, req.params.id);
    assertNotShared(rule);
    if (await IncentiveEarning.exists({ branch: req.branchId, incentive: rule._id })) {
      throw fail(409, 'This target already has incentive earning history. Close it instead of deleting.', 'TARGET_HAS_EARNINGS');
    }
    await rule.deleteOne();
    return res.json({ success: true, message: 'Target deleted.' });
  } catch (error) { return sendError(res, error); }
});

export default router;
