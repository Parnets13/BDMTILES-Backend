import { Router } from 'express';
import Incentive from '../models/Incentive.js';
import IncentiveEarning from '../models/IncentiveEarning.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

function sendError(res, error) {
  const status = error.status || (error.name === 'CastError' ? 422 : 500);
  return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
}

function routeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertNonDealerRule(rule) {
  if (rule?.applicableTo === 'dealer') {
    throw routeError(410, 'Dealer monetary incentives must use the authoritative branch scheme and credit-note settlement workflow.');
  }
}

function ruleBody(body) {
  if (body.applicableTo === 'dealer') assertNonDealerRule(body);
  const allowed = [
    'incentiveName', 'applicableTo', 'specificUsers', 'incentiveType', 'triggerEvent',
    'flatAmount', 'percentage', 'maxCap', 'perUnitAmount', 'thresholdQty',
    'targetValue', 'targetQty', 'bonusOnTarget', 'slabs', 'milestones', 'period',
    'validFrom', 'validTo', 'remarks',
  ];
  return Object.fromEntries(allowed.filter(field => body[field] !== undefined).map(field => [field, body[field]]));
}

router.get('/', requirePermission('incentive.rules.view'), async (req, res) => {
  try {
    const filter = { branch: req.branchId, applicableTo: { $ne: 'dealer' } };
    for (const field of ['applicableTo', 'incentiveType', 'status', 'triggerEvent']) {
      if (req.query[field] !== undefined) filter[field] = req.query[field];
    }
    if (filter.applicableTo === 'dealer') assertNonDealerRule(filter);
    const incentives = await Incentive.find(filter).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: incentives });
  } catch (error) { return sendError(res, error); }
});

router.get('/stats', requirePermission('incentive.rules.view'), async (req, res) => {
  try {
    const earningMatch = { branch: req.branchId, dealer: null };
    const [total, active, totals] = await Promise.all([
      Incentive.countDocuments({ branch: req.branchId, applicableTo: { $ne: 'dealer' } }),
      Incentive.countDocuments({ branch: req.branchId, applicableTo: { $ne: 'dealer' }, status: 'active' }),
      IncentiveEarning.aggregate([
        { $match: earningMatch },
        { $group: {
          _id: null,
          earned: { $sum: '$earnedAmount' },
          paid: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$earnedAmount', 0] } },
          pending: { $sum: { $cond: [{ $in: ['$paymentStatus', ['pending', 'approved']] }, '$earnedAmount', 0] } },
        } },
      ]),
    ]);
    return res.json({ success: true, data: {
      totalRules: total, activeRules: active,
      totalEarned: totals[0]?.earned || 0, totalPaid: totals[0]?.paid || 0, totalPending: totals[0]?.pending || 0,
    } });
  } catch (error) { return sendError(res, error); }
});

router.post('/', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    const data = ruleBody(req.body);
    assertNonDealerRule(data);
    data.branch = req.branchId;
    data.incentiveCode = await generateBranchNumber(req.branchId, 'staff_incentive_rule', data.validFrom || new Date());
    data.status = 'active';
    data.createdBy = req.user._id;
    const incentive = await Incentive.create(data);
    return res.status(201).json({ success: true, message: `Incentive ${incentive.incentiveCode} created.`, data: incentive });
  } catch (error) { return sendError(res, error); }
});

router.get('/my-earnings', requirePermission('incentive.earnings.self'), async (req, res) => {
  try {
    const earnings = await IncentiveEarning.find({ branch: req.branchId, earnedBy: req.user._id, dealer: null })
      .sort({ createdAt: -1 }).limit(50).populate('incentive', 'incentiveName incentiveType').lean();
    const totalEarned = earnings.reduce((sum, row) => sum + row.earnedAmount, 0);
    const totalPaid = earnings.filter(row => row.paymentStatus === 'paid').reduce((sum, row) => sum + row.earnedAmount, 0);
    const totalPending = earnings.filter(row => ['pending', 'approved'].includes(row.paymentStatus)).reduce((sum, row) => sum + row.earnedAmount, 0);
    return res.json({ success: true, data: { earnings, summary: { totalEarned, totalPaid, totalPending } } });
  } catch (error) { return sendError(res, error); }
});

router.get('/earnings/list', requirePermission('incentive.earnings.view'), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { branch: req.branchId, dealer: null };
    for (const field of ['earnedBy', 'paymentStatus', 'triggerEvent']) if (req.query[field]) filter[field] = req.query[field];
    const [data, total] = await Promise.all([
      IncentiveEarning.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('earnedBy', 'name').populate('incentive', 'incentiveName incentiveType').lean(),
      IncentiveEarning.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total } });
  } catch (error) { return sendError(res, error); }
});

router.post('/earnings/record', requirePermission('incentive.earnings.record'), (_req, res) => res.status(410).json({
  success: false,
  message: 'Manual earnings are disabled. Earnings must be created idempotently by an authoritative business event; dealer incentives use scheme settlements.',
}));

router.post('/earnings/calculate', requirePermission('incentive.earnings.record'), async (req, res) => {
  try {
    const incentive = await Incentive.findOne({ _id: req.body.incentiveId, branch: req.branchId });
    if (!incentive) throw routeError(404, 'Incentive rule not found in the active branch.');
    assertNonDealerRule(incentive);
    const value = Number(req.body.value || 0);
    const qty = Number(req.body.qty || 0);
    if (!Number.isFinite(value) || !Number.isFinite(qty) || value < 0 || qty < 0) throw routeError(422, 'value and qty must be finite nonnegative numbers.');
    const amount = incentive.calculate(value, qty);
    return res.json({ success: true, data: {
      incentiveId: incentive._id, value, qty,
      calculatedAmount: Math.round((amount + Number.EPSILON) * 100) / 100,
      incentiveType: incentive.incentiveType,
      previewOnly: true,
    } });
  } catch (error) { return sendError(res, error); }
});

router.patch('/earnings/:id/approve', requirePermission('incentive.earnings.approve'), async (req, res) => {
  try {
    const current = await IncentiveEarning.findOne({ _id: req.params.id, branch: req.branchId, dealer: null });
    if (!current) throw routeError(404, 'Earning not found in the active branch.');
    if (current.paymentStatus !== 'pending') throw routeError(409, `Only pending earnings can be approved; this record is ${current.paymentStatus}.`);
    if ([current.createdBy, current.earnedBy].filter(Boolean).some(actor => String(actor) === String(req.user._id))) {
      throw routeError(403, 'The earning creator or beneficiary cannot approve it.');
    }
    const earning = await IncentiveEarning.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, paymentStatus: 'pending' },
      { $set: { paymentStatus: 'approved', approvedBy: req.user._id, approvedAt: new Date() } },
      { new: true, runValidators: true }
    );
    if (!earning) throw routeError(409, 'Earning state changed before approval.');
    return res.json({ success: true, message: 'Earning approved for payment.', data: earning });
  } catch (error) { return sendError(res, error); }
});

router.patch('/earnings/:id/pay', requirePermission('incentive.earnings.pay'), async (req, res) => {
  try {
    const current = await IncentiveEarning.findOne({ _id: req.params.id, branch: req.branchId, dealer: null });
    if (!current) throw routeError(404, 'Earning not found in the active branch.');
    if (current.paymentStatus !== 'approved') throw routeError(409, `Only approved earnings can be paid; this record is ${current.paymentStatus}.`);
    if ([current.createdBy, current.approvedBy, current.earnedBy].filter(Boolean).some(actor => String(actor) === String(req.user._id))) {
      throw routeError(403, 'Payment requires an actor who is not the creator, approver, or beneficiary.');
    }
    const earning = await IncentiveEarning.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, paymentStatus: 'approved' },
      { $set: { paymentStatus: 'paid', paidAt: new Date(), paymentRef: String(req.body.paymentRef || '').trim() } },
      { new: true, runValidators: true }
    );
    if (!earning) throw routeError(409, 'Earning state changed before payment.');
    await Incentive.updateOne(
      { _id: earning.incentive, branch: req.branchId },
      { $inc: { totalPaid: earning.earnedAmount, totalPending: -earning.earnedAmount } }
    );
    return res.json({ success: true, message: 'Earning marked paid.', data: earning });
  } catch (error) { return sendError(res, error); }
});

router.get('/:id', requirePermission('incentive.rules.view'), async (req, res) => {
  try {
    const incentive = await Incentive.findOne({ _id: req.params.id, branch: req.branchId, applicableTo: { $ne: 'dealer' } }).lean();
    if (!incentive) throw routeError(404, 'Incentive rule not found in the active branch.');
    return res.json({ success: true, data: incentive });
  } catch (error) { return sendError(res, error); }
});

router.put('/:id', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    const current = await Incentive.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) throw routeError(404, 'Incentive rule not found in the active branch.');
    assertNonDealerRule(current);
    const updates = ruleBody(req.body);
    assertNonDealerRule(updates);
    Object.assign(current, updates);
    await current.save();
    return res.json({ success: true, message: 'Incentive updated.', data: current });
  } catch (error) { return sendError(res, error); }
});

router.patch('/:id/status', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    if (!['active', 'paused', 'expired', 'closed'].includes(req.body.status)) throw routeError(422, 'Invalid status.');
    const incentive = await Incentive.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, applicableTo: { $ne: 'dealer' } },
      { $set: { status: req.body.status } },
      { new: true, runValidators: true }
    );
    if (!incentive) throw routeError(404, 'Incentive rule not found in the active branch.');
    return res.json({ success: true, message: `Incentive ${req.body.status}.`, data: incentive });
  } catch (error) { return sendError(res, error); }
});

router.delete('/:id', requirePermission('incentive.rules.manage'), async (req, res) => {
  try {
    const incentive = await Incentive.findOne({ _id: req.params.id, branch: req.branchId, applicableTo: { $ne: 'dealer' } });
    if (!incentive) throw routeError(404, 'Incentive rule not found in the active branch.');
    if (await IncentiveEarning.exists({ branch: req.branchId, incentive: incentive._id })) throw routeError(409, 'Cannot delete an incentive rule with earning history. Close it instead.');
    await incentive.deleteOne();
    return res.json({ success: true, message: 'Incentive deleted.' });
  } catch (error) { return sendError(res, error); }
});

export default router;
