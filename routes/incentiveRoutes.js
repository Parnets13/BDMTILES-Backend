import { Router } from 'express';
import Incentive from '../models/Incentive.js';
import IncentiveEarning from '../models/IncentiveEarning.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ═══════════════════════════════════════
// INCENTIVE RULES CRUD
// ═══════════════════════════════════════

// GET /api/v1/incentives — list all incentive rules
router.get('/', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const { applicableTo, incentiveType, status, triggerEvent } = req.query;
    let filter = {};
    if (applicableTo) filter.applicableTo = applicableTo;
    if (incentiveType) filter.incentiveType = incentiveType;
    if (status) filter.status = status;
    if (triggerEvent) filter.triggerEvent = triggerEvent;

    const incentives = await Incentive.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: incentives });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/incentives/stats
router.get('/stats', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const [total, active, totalEarned, totalPaid, totalPending] = await Promise.all([
      Incentive.countDocuments(),
      Incentive.countDocuments({ status: 'active' }),
      IncentiveEarning.aggregate([{ $group: { _id: null, total: { $sum: '$earnedAmount' } } }]),
      IncentiveEarning.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$earnedAmount' } } }]),
      IncentiveEarning.aggregate([{ $match: { paymentStatus: 'pending' } }, { $group: { _id: null, total: { $sum: '$earnedAmount' } } }]),
    ]);
    res.json({ success: true, data: {
      totalRules: total, activeRules: active,
      totalEarned: totalEarned[0]?.total || 0,
      totalPaid: totalPaid[0]?.total || 0,
      totalPending: totalPending[0]?.total || 0,
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/incentives — create incentive rule
router.post('/', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Incentive.countDocuments();
    data.incentiveCode = `INC-${String(count + 1).padStart(4, '0')}`;
    const incentive = await Incentive.create(data);
    res.status(201).json({ success: true, message: `Incentive ${incentive.incentiveCode} created.`, data: incentive });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/incentives/my-earnings — current user's earnings (for SE app)
// MUST be before /:id to avoid route conflict
router.get('/my-earnings', async (req, res) => {
  try {
    const earnings = await IncentiveEarning.find({ earnedBy: req.user._id })
      .sort({ createdAt: -1 }).limit(50)
      .populate('incentive', 'incentiveName incentiveType')
      .lean();
    const totalEarned = earnings.reduce((s, e) => s + e.earnedAmount, 0);
    const totalPaid = earnings.filter(e => e.paymentStatus === 'paid').reduce((s, e) => s + e.earnedAmount, 0);
    const totalPending = earnings.filter(e => e.paymentStatus === 'pending' || e.paymentStatus === 'approved').reduce((s, e) => s + e.earnedAmount, 0);

    res.json({ success: true, data: { earnings, summary: { totalEarned, totalPaid, totalPending } } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/incentives/:id
router.get('/:id', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const incentive = await Incentive.findById(req.params.id).lean();
    if (!incentive) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: incentive });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/v1/incentives/:id
router.put('/:id', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const incentive = await Incentive.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!incentive) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Incentive updated.', data: incentive });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/incentives/:id/status — toggle active/paused
router.patch('/:id/status', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const incentive = await Incentive.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    res.json({ success: true, message: `Incentive ${req.body.status}.`, data: incentive });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE
router.delete('/:id', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    await Incentive.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Incentive deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// INCENTIVE EARNINGS
// ═══════════════════════════════════════

// GET /api/v1/incentives/earnings — list all earnings
router.get('/earnings/list', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const { earnedBy, dealer, paymentStatus, triggerEvent, page = 1, limit = 20 } = req.query;
    const p = Math.max(1, parseInt(page)), l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (earnedBy) filter.earnedBy = earnedBy;
    if (dealer) filter.dealer = dealer;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (triggerEvent) filter.triggerEvent = triggerEvent;

    const [data, total] = await Promise.all([
      IncentiveEarning.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('earnedBy', 'name').populate('incentive', 'incentiveName incentiveType').lean(),
      IncentiveEarning.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/incentives/earnings/record — manually record an earning
router.post('/earnings/record', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const data = req.body;
    const earning = await IncentiveEarning.create(data);
    // Update incentive totals
    if (data.incentive) {
      await Incentive.findByIdAndUpdate(data.incentive, {
        $inc: { totalEarned: earning.earnedAmount, totalPending: earning.earnedAmount },
      });
    }
    res.status(201).json({ success: true, message: 'Earning recorded.', data: earning });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/incentives/earnings/calculate — calculate incentive for a given value/qty
router.post('/earnings/calculate', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const { incentiveId, value, qty } = req.body;
    const incentive = await Incentive.findById(incentiveId);
    if (!incentive) return res.status(404).json({ success: false, message: 'Incentive rule not found.' });

    const amount = incentive.calculate(value || 0, qty || 0);
    res.json({ success: true, data: { incentiveId, value, qty, calculatedAmount: Math.round(amount * 100) / 100, incentiveType: incentive.incentiveType } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/incentives/earnings/:id/approve — approve earning for payment
router.patch('/earnings/:id/approve', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const earning = await IncentiveEarning.findByIdAndUpdate(req.params.id, {
      paymentStatus: 'approved', approvedBy: req.user._id, approvedAt: new Date(),
    }, { new: true });
    if (!earning) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Earning approved for payment.', data: earning });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/incentives/earnings/:id/pay — mark as paid
router.patch('/earnings/:id/pay', requirePermission('dealer.scheme'), async (req, res) => {
  try {
    const earning = await IncentiveEarning.findByIdAndUpdate(req.params.id, {
      paymentStatus: 'paid', paidAt: new Date(), paymentRef: req.body.paymentRef || '',
    }, { new: true });
    if (!earning) return res.status(404).json({ success: false, message: 'Not found.' });
    // Update incentive totals
    if (earning.incentive) {
      await Incentive.findByIdAndUpdate(earning.incentive, {
        $inc: { totalPaid: earning.earnedAmount, totalPending: -earning.earnedAmount },
      });
    }
    res.json({ success: true, message: 'Marked as paid.', data: earning });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
