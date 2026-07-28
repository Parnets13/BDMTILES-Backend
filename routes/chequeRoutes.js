import { Router } from 'express';
import Cheque from '../models/Cheque.js';
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
    const data = { ...req.body, createdBy: req.user._id };
    if (data.dealer) {
      const d = await Dealer.findById(data.dealer).lean();
      if (d) data.partyName = d.businessName;
    } else if (data.supplier) {
      const s = await Supplier.findById(data.supplier).lean();
      if (s) data.partyName = s.companyName;
    }
    const cheque = await Cheque.create(data);
    res.status(201).json({ success: true, message: 'Cheque recorded.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/cheques/:id/deposit
router.patch('/:id/deposit', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    if (cheque.status !== 'received') return res.status(400).json({ success: false, message: 'Only "received" cheques can be deposited.' });
    cheque.status = 'deposited';
    cheque.depositedDate = req.body.depositedDate || new Date();
    cheque.depositedBank = req.body.depositedBank || '';
    cheque.depositedBranch = req.body.depositedBranch || '';
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
    await cheque.save();
    res.json({ success: true, message: 'Cheque cleared.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/cheques/:id/bounce
router.patch('/:id/bounce', requirePermission('cheque.management'), async (req, res) => {
  try {
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ success: false, message: 'Not found.' });
    cheque.status = 'bounced';
    cheque.bounceDate = new Date();
    cheque.bounceReason = req.body.reason || '';
    cheque.bounceCharges = req.body.charges || 0;
    await cheque.save();
    // Update dealer outstanding — amount comes back + charges
    if (cheque.chequeType === 'received' && cheque.dealer) {
      await Dealer.findByIdAndUpdate(cheque.dealer, { $inc: { currentOutstanding: cheque.amount + (cheque.bounceCharges || 0) } });
    }
    res.json({ success: true, message: 'Cheque marked bounced.', data: cheque });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
