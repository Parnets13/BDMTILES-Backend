import { Router } from 'express';
import mongoose from 'mongoose';
import Incentive from '../models/Incentive.js';
import Dealer from '../models/Dealer.js';
import DealerEmployee from '../models/DealerEmployee.js';
import Product from '../models/Product.js';
import Category from '../models/Category.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { resolveDealerBranch } from '../services/dealerAssignmentService.js';
import {
  DEALER_METRIC_META,
  DEALER_TARGET_METRICS,
  DEALER_TARGET_PERIODS,
  DEALER_TARGET_RULE_MATCH,
  assertDealerRuleCoherent,
  buildDealerRulePayload,
  dealerTargetError,
  dealerTargetSummary,
  listAllDealerTargetRows,
  loadEmployeeDirectory,
  nextDealerIncentiveCode,
  triggerEventForDealer,
} from '../services/dealerTargetService.js';

/**
 * BDMTILES staff view of dealer-employee targets.
 *
 * Mounted at /api/v1/dealer-employee-targets. This is the admin counterpart to
 * /api/v1/dealer-app/targets: same rules, same achievement maths (both go through
 * services/dealerTargetService.js), but scoped across dealers rather than to one.
 *
 * WHY BOTH EXIST
 * A dealer owns its team's targets and authors them from the app. This router
 * exists so BDMTILES can see what dealers have committed to their staff, and —
 * with an explicit grant — step in. Reading is deliberately cheap to grant: it
 * rides along with `dealer.master`, because anyone who can already open a dealer
 * and see its employees should not be locked out of seeing their targets.
 * Writing is not: overriding a target a dealer set is a business decision, so it
 * needs `dealer.employee.targets.manage`.
 */
const router = Router();
router.use(protect);

/** Reading: the granular permission, or dealer.master as the pre-existing route in. */
const canView = requireAnyPermission('dealer.employee.targets.view', 'dealer.master');
/** Writing: explicit grant only. */
const canManage = requirePermission('dealer.employee.targets.manage');

const sendError = (res, error) => res.status(
  error.status || (error.code === 11000 ? 409 : error.name === 'CastError' ? 422 : 500),
).json({
  success: false,
  code: error.code,
  message: error.name === 'CastError' ? 'Invalid identifier.' : error.message,
});

/** Build the Mongo filter for the listing from query params. */
async function buildListFilter(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.targetMetric) filter.targetMetric = query.targetMetric;
  if (query.period) filter.period = query.period;
  if (mongoose.isValidObjectId(query.dealerId)) filter.dealer = query.dealerId;
  if (mongoose.isValidObjectId(query.employeeId)) filter.specificDealerEmployees = query.employeeId;

  // A name search spans two collections, so resolve the matching ids first and
  // then filter by them. Bounded, because this feeds a picker not a report.
  const search = String(query.search || '').trim();
  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [dealers, employees] = await Promise.all([
      Dealer.find({ $or: [{ businessName: regex }, { dealerCode: regex }] }).select('_id').limit(200).lean(),
      DealerEmployee.find({ $or: [{ name: regex }, { employeeCode: regex }, { mobile: regex }] })
        .select('_id dealer').limit(200).lean(),
    ]);
    const dealerIds = [...new Set([
      ...dealers.map((dealer) => String(dealer._id)),
      ...employees.map((employee) => String(employee.dealer)),
    ])];
    const employeeIds = employees.map((employee) => employee._id);
    // Match a rule whose dealer matched, or that covers a matched employee.
    filter.$or = [
      ...(dealerIds.length ? [{ dealer: { $in: dealerIds } }] : []),
      ...(employeeIds.length ? [{ specificDealerEmployees: { $in: employeeIds } }] : []),
    ];
    if (!filter.$or.length) {
      // Nothing matched — force an empty result rather than falling through to
      // returning every rule.
      filter._id = { $in: [] };
      delete filter.$or;
    }
  }

  return filter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-employee-targets/summary
router.get('/summary', canView, async (_req, res) => {
  try {
    return res.json({ success: true, data: await dealerTargetSummary() });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/dealer-employee-targets/meta
// Everything the staff authoring form needs. Declared before '/:id' so "meta" is
// not read as an id.
router.get('/meta', canView, async (_req, res) => {
  try {
    const [dealers, products, categories] = await Promise.all([
      Dealer.find({ status: 'active' }).select('businessName dealerCode city').sort({ businessName: 1 }).limit(2000).lean(),
      Product.find({ status: 'active' }).select('itemName productCode unit category').limit(2000).lean(),
      Category.find({ status: 'active' }).select('name').limit(500).lean(),
    ]);

    return res.json({
      success: true,
      data: {
        metrics: DEALER_TARGET_METRICS.map((metric) => ({
          value: metric,
          label: DEALER_METRIC_META[metric].label,
          unit: DEALER_METRIC_META[metric].unit,
          scope: DEALER_METRIC_META[metric].scope,
        })),
        periods: DEALER_TARGET_PERIODS,
        dealers: dealers.map((dealer) => ({
          _id: dealer._id,
          businessName: dealer.businessName,
          dealerCode: dealer.dealerCode,
          city: dealer.city,
        })),
        products: products.map((product) => ({
          _id: product._id,
          name: product.itemName,
          code: product.productCode,
          unit: product.unit,
          category: product.category,
        })),
        categories: categories.map((category) => ({ _id: category._id, name: category.name })),
        itemUnit: 'boxes',
      },
    });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/dealer-employee-targets
router.get('/', canView, async (req, res) => {
  try {
    const filter = await buildListFilter(req.query);
    const { rows, pagination } = await listAllDealerTargetRows({
      filter,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ success: true, data: rows, pagination });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/dealer-employee-targets/dealers/:dealerId
// One dealer's targets — what the Dealer Master detail modal reads.
router.get('/dealers/:dealerId', canView, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.dealerId)) {
      throw dealerTargetError(422, 'Invalid dealer identifier.', 'INVALID_DEALER');
    }
    const dealer = await Dealer.findById(req.params.dealerId).select('businessName dealerCode').lean();
    if (!dealer) throw dealerTargetError(404, 'Dealer not found.', 'DEALER_NOT_FOUND');

    const { rows } = await listAllDealerTargetRows({
      filter: { dealer: dealer._id },
      page: 1,
      // A single dealer's rule count is small; one page is enough and avoids a
      // second round trip in the modal.
      limit: 100,
    });

    const achieved = rows.filter((row) => row.isAchieved).length;
    return res.json({
      success: true,
      data: rows.map((row) => ({ ...row, dealer: { _id: dealer._id, businessName: dealer.businessName, dealerCode: dealer.dealerCode } })),
      summary: { total: rows.length, achieved, inProgress: rows.length - achieved },
    });
  } catch (error) { return sendError(res, error); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Writes — explicit grant only
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/v1/dealer-employee-targets
//
// Creates a target on a dealer's behalf. The dealer id comes from the body here
// (staff act across dealers), but it is validated to be a real dealer and the
// employee is validated against THAT dealer's directory — so a mismatched pair
// is refused rather than silently creating a cross-dealer rule.
router.post('/', canManage, async (req, res) => {
  try {
    const dealerId = req.body?.dealerId;
    if (!mongoose.isValidObjectId(dealerId)) {
      throw dealerTargetError(422, 'Select a dealer.', 'INVALID_DEALER');
    }
    const dealer = await Dealer.findById(dealerId).select('_id businessName dealerCode assignedSalesExecutive').lean();
    if (!dealer) throw dealerTargetError(404, 'Dealer not found.', 'DEALER_NOT_FOUND');

    const employeeDirectory = await loadEmployeeDirectory(dealer._id);
    const payload = await buildDealerRulePayload(req.body, {
      dealerId: dealer._id,
      employeeDirectory,
    });
    assertDealerRuleCoherent(payload);

    const branch = await resolveDealerBranch(dealer);
    const rule = await Incentive.create({
      ...payload,
      incentiveCode: await nextDealerIncentiveCode(dealer._id, dealer.dealerCode),
      branch: branch || undefined,
      dealer: dealer._id,
      applicableTo: 'dealer_employee',
      incentiveType: 'target',
      triggerEvent: triggerEventForDealer(payload.targetMetric, payload.period),
      status: 'active',
      // Records which staff member set it, so a target the dealer did not author
      // is traceable.
      createdBy: req.user._id,
    });

    const { rows } = await listAllDealerTargetRows({ filter: { _id: rule._id }, limit: 1 });
    return res.status(201).json({
      success: true,
      message: `Target "${rule.incentiveName}" assigned for ${dealer.businessName}.`,
      data: rows,
    });
  } catch (error) { return sendError(res, error); }
});

/** Load a rule, proving it is a dealer-employee target rule. */
async function findTargetRule(ruleId) {
  if (!mongoose.isValidObjectId(ruleId)) {
    throw dealerTargetError(422, 'Invalid identifier.', 'INVALID_ID');
  }
  const rule = await Incentive.findOne({ _id: ruleId, ...DEALER_TARGET_RULE_MATCH }).lean();
  if (!rule) throw dealerTargetError(404, 'Target not found.', 'TARGET_NOT_FOUND');
  return rule;
}

// PUT /api/v1/dealer-employee-targets/:id
router.put('/:id', canManage, async (req, res) => {
  try {
    const existing = await findTargetRule(req.params.id);
    const employeeDirectory = await loadEmployeeDirectory(existing.dealer);
    const payload = await buildDealerRulePayload(req.body, {
      dealerId: existing.dealer,
      employeeDirectory,
      partial: true,
    });
    assertDealerRuleCoherent({ ...existing, ...payload });

    if (payload.targetMetric) {
      payload.triggerEvent = triggerEventForDealer(payload.targetMetric, payload.period || existing.period);
    } else if (payload.period) {
      payload.triggerEvent = triggerEventForDealer(existing.targetMetric || 'sales', payload.period);
    }

    await Incentive.updateOne({ _id: existing._id }, { $set: payload });
    const { rows } = await listAllDealerTargetRows({ filter: { _id: existing._id }, limit: 1 });
    return res.json({ success: true, message: 'Target updated.', data: rows });
  } catch (error) { return sendError(res, error); }
});

// PATCH /api/v1/dealer-employee-targets/:id/status  { status }
router.patch('/:id/status', canManage, async (req, res) => {
  try {
    const status = ['active', 'paused', 'closed'].includes(req.body?.status) ? req.body.status : null;
    if (!status) throw dealerTargetError(422, 'status must be active, paused or closed.', 'INVALID_STATUS');

    const existing = await findTargetRule(req.params.id);
    await Incentive.updateOne({ _id: existing._id }, { $set: { status } });
    const { rows } = await listAllDealerTargetRows({ filter: { _id: existing._id }, limit: 1 });
    return res.json({ success: true, message: `Target ${status}.`, data: rows });
  } catch (error) { return sendError(res, error); }
});

// DELETE /api/v1/dealer-employee-targets/:id
router.delete('/:id', canManage, async (req, res) => {
  try {
    const existing = await findTargetRule(req.params.id);
    await Incentive.deleteOne({ _id: existing._id });
    return res.json({ success: true, message: 'Target removed.' });
  } catch (error) { return sendError(res, error); }
});

export default router;
