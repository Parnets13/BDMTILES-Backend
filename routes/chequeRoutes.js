import { Router } from 'express';
import Cheque from '../models/Cheque.js';
import Payment from '../models/Payment.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/cheques — list with filters
router.get('/', requirePermission('cheque.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, chequeType, dateFrom, dateTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ chequeNumber: r }, { partyName: r }, { bankName: r }];
    }
    if (status) filter.status = status;
    if (chequeType) filter.chequeType = chequeType;
    if (dateFrom || dateTo) {
      filter.chequeDate = {};
      if (dateFrom) filter.chequeDate.$gte = new Date(dateFrom);
      if (dateTo) filter.chequeDate.$lte = new Date(dateTo);
    }
    const [cheques, total] = await Promise.all([
      Cheque.find(filter).sort({ chequeDate: -1 }).skip((p-1)*l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('supplier', 'companyName supplierCode')
        .lean(),
      Cheque.countDocuments(filter),
    ]);
    res.json({ success: true, data: cheques, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/cheques/stats
router.get('/stats', requirePermission('cheque.management'), async (req, res) => {
  try {
    const [received, deposited, cleared, bounced, totalReceived, totalCleared] = await Promise.all([
      Cheque.countDocuments({ status: 'received' }),
      Cheque.countDocuments({ status: 'deposited' }),
      Cheque.countDocuments({ status: 'cleared' }),
      Cheque.countDocuments({ status: 'bounced' }),
      Cheque.aggregate([{ $match: { chequeType: 'received', status: { $nin: ['bounced', 'cancelled'] } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Cheque.aggregate([{ $match: { status: 'cleared' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);
    res.json({ success: true, data: { received, deposited, cleared, bounced, totalReceived: totalReceived[0]?.total || 0, totalCleared: totalCleared[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/cheques/:id
router.get('/:id', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode mobile')
      .populate('supplier', 'companyName supplierCode mobile')
      .lean();
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/cheques — add cheque
router.post('/', requirePermission('cheque.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id, createdByName: req.user.name };
    if (data.dealer) {
      const d = await Dealer.findById(data.dealer).lean();
      if (d) { data.partyName = d.businessName; data.partyPhone = d.mobile || ''; }
    } else if (data.supplier) {
      const s = await Supplier.findById(data.supplier).lean();
      if (s) { data.partyName = s.companyName; data.partyPhone = s.mobile || ''; }
    }
    // Initialize timeline
    data.timeline = [{ action: 'received', performedBy: req.user._id, performedByName: req.user.name, notes: 'Cheque received and recorded' }];
    const cheque = await Cheque.create(data);
    res.status(201).json({ success: true, message: 'Cheque recorded.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/cheques/:id/deposit
router.patch('/:id/deposit', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    if (!['received', 're_deposited'].includes(cheque.status)) return res.status(400).json({ success: false, message: 'Only received/re-deposited cheques can be deposited.' });
    cheque.status = 'deposited';
    cheque.depositedDate = req.body.depositedDate || new Date();
    cheque.depositedBank = req.body.depositedBank || '';
    cheque.depositedBranch = req.body.depositedBranch || '';
    cheque.depositedAccountNumber = req.body.depositedAccountNumber || '';
    cheque.depositSlipNumber = req.body.depositSlipNumber || '';
    cheque.timeline.push({ action: 'deposited', performedBy: req.user._id, performedByName: req.user.name, notes: `Deposited at ${req.body.depositedBank || 'bank'}` });
    await cheque.save();
    res.json({ success: true, message: 'Cheque deposited.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/cheques/:id/clear
router.patch('/:id/clear', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    if (cheque.status !== 'deposited') return res.status(400).json({ success: false, message: 'Only deposited cheques can be cleared.' });
    cheque.status = 'cleared';
    cheque.clearedDate = req.body.clearedDate || new Date();
    cheque.clearanceReference = req.body.clearanceReference || '';
    cheque.timeline.push({ action: 'cleared', performedBy: req.user._id, performedByName: req.user.name, notes: `Cleared on ${new Date().toLocaleDateString('en-IN')}` });
    await cheque.save();
    res.json({ success: true, message: 'Cheque cleared.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/cheques/:id/bounce
router.patch('/:id/bounce', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    if (cheque.status === 'bounced') return res.json({ success: true, message: 'Cheque is already marked bounced.', data: cheque });

    let bounceReason = req.body.reason || '';
    let bounceCharges = req.body.charges || 0;
    if (cheque.payment) {
      const payment = await Payment.findById(cheque.payment).lean();
      if (!payment) return res.status(409).json({ success: false, message: 'The linked Payment no longer exists.' });
      if (payment.status !== 'bounced') {
        return res.status(422).json({
          success: false,
          message: 'Bounce the linked Payment first so its branch subledger reversal and charge are posted atomically.',
        });
      }
      bounceReason = payment.bounceReason || bounceReason;
      bounceCharges = payment.bounceCharges || 0;
    }

    cheque.status = 'bounced';
    cheque.bounceDate = new Date();
    cheque.bounceReason = bounceReason;
    cheque.bounceCharges = bounceCharges;
    cheque.bounceCount = (cheque.bounceCount || 0) + 1;
    cheque.timeline.push({ action: 'bounced', performedBy: req.user._id, performedByName: req.user.name, notes: `Bounced: ${bounceReason || 'No reason'} · Charges: ₹${bounceCharges}` });
    await cheque.save();
    res.json({ success: true, message: 'Cheque marked bounced.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/cheques/:id/re-deposit — re-deposit a bounced cheque
router.patch('/:id/re-deposit', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    if (cheque.status !== 'bounced') return res.status(400).json({ success: false, message: 'Only bounced cheques can be re-deposited.' });
    cheque.status = 're_deposited';
    cheque.reDepositDate = new Date();
    cheque.reDepositCount = (cheque.reDepositCount || 0) + 1;
    cheque.timeline.push({ action: 're_deposited', performedBy: req.user._id, performedByName: req.user.name, notes: `Re-deposited (attempt ${cheque.reDepositCount})` });
    await cheque.save();
    res.json({ success: true, message: 'Cheque re-deposited.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/cheques/:id/return — return cheque to party
router.patch('/:id/return', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    cheque.status = 'returned';
    cheque.returnedDate = new Date();
    cheque.returnReason = req.body.reason || '';
    cheque.timeline.push({ action: 'returned', performedBy: req.user._id, performedByName: req.user.name, notes: `Returned to ${cheque.partyName}: ${req.body.reason || ''}` });
    await cheque.save();
    res.json({ success: true, message: 'Cheque returned.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
