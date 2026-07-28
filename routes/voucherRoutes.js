import { Router } from 'express';
import Voucher from '../models/Voucher.js';
import BankAccount from '../models/BankAccount.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ══════════════════════════════════
// VOUCHERS
// ══════════════════════════════════

router.get('/', requirePermission('finance.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, voucherType, status, dateFrom, dateTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ voucherNumber: r }, { narration: r }, { referenceNumber: r }];
    }
    if (voucherType) filter.voucherType = voucherType;
    if (status) filter.status = status;
    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) { const d = new Date(dateTo); d.setHours(23,59,59); filter.voucherDate.$lte = d; }
    }
    const [vouchers, total] = await Promise.all([
      Voucher.find(filter).sort({ voucherDate: -1 }).skip((p-1)*l).limit(l)
        .populate('bankAccount', 'accountName bankName').lean(),
      Voucher.countDocuments(filter),
    ]);
    res.json({ success: true, data: vouchers, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/stats', requirePermission('finance.management'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const [total, draft, posted, todayVouchers, monthTotal] = await Promise.all([
      Voucher.countDocuments(),
      Voucher.countDocuments({ status: 'draft' }),
      Voucher.countDocuments({ status: 'posted' }),
      Voucher.countDocuments({ voucherDate: { $gte: today } }),
      Voucher.aggregate([{ $match: { status: 'posted', voucherDate: { $gte: thisMonth } } }, { $group: { _id: null, total: { $sum: '$totalAmount' } } }]),
    ]);
    res.json({ success: true, data: { total, draft, posted, todayVouchers, monthTotal: monthTotal[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/:id', requirePermission('finance.management'), async (req, res) => {
  try {
    const v = await Voucher.findById(req.params.id).populate('bankAccount', 'accountName bankName').lean();
    if (!v) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: v });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', requirePermission('finance.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Voucher.countDocuments();
    const prefix = { receipt: 'RV', payment: 'PV', contra: 'CV', journal: 'JV', sales: 'SV', purchase: 'BV' }[data.voucherType] || 'VCH';
    data.voucherNumber = `${prefix}-${String(count + 1).padStart(5, '0')}`;
    data.totalAmount = data.entries?.reduce((sum, e) => sum + (e.debit || 0), 0) || 0;
    data.tallySyncStatus = 'not_synced';
    const v = await Voucher.create(data);
    // Update bank balance on posting
    if (data.status === 'posted' && data.bankAccount) {
      const delta = data.voucherType === 'receipt' ? data.totalAmount : data.voucherType === 'payment' ? -data.totalAmount : 0;
      if (delta !== 0) await BankAccount.findByIdAndUpdate(data.bankAccount, { $inc: { currentBalance: delta } });
    }
    res.status(201).json({ success: true, message: `Voucher ${v.voucherNumber} created.`, data: v });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/post', requirePermission('finance.management'), async (req, res) => {
  try {
    const v = await Voucher.findById(req.params.id);
    if (!v) return res.status(404).json({ success: false, message: 'Not found.' });
    if (v.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft vouchers can be posted.' });
    v.status = 'posted';
    await v.save();
    if (v.bankAccount) {
      const delta = v.voucherType === 'receipt' ? v.totalAmount : v.voucherType === 'payment' ? -v.totalAmount : 0;
      if (delta !== 0) await BankAccount.findByIdAndUpdate(v.bankAccount, { $inc: { currentBalance: delta } });
    }
    res.json({ success: true, message: 'Voucher posted.', data: v });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/cancel', requirePermission('finance.management'), async (req, res) => {
  try {
    const v = await Voucher.findByIdAndUpdate(req.params.id, { status: 'cancelled' }, { new: true });
    res.json({ success: true, message: 'Voucher cancelled.', data: v });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════
// BANK ACCOUNTS
// ══════════════════════════════════

router.get('/bank-accounts/list', requirePermission('finance.management'), async (req, res) => {
  try {
    const accounts = await BankAccount.find({ isActive: true }).sort({ isDefault: -1, accountName: 1 }).lean();
    res.json({ success: true, data: accounts });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/bank-accounts', requirePermission('finance.management'), async (req, res) => {
  try {
    const data = req.body;
    if (data.isDefault) await BankAccount.updateMany({}, { isDefault: false });
    if (data.openingBalance) data.currentBalance = data.openingBalance;
    const acc = await BankAccount.create(data);
    res.status(201).json({ success: true, message: 'Bank account created.', data: acc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/bank-accounts/:id', requirePermission('finance.management'), async (req, res) => {
  try {
    if (req.body.isDefault) await BankAccount.updateMany({ _id: { $ne: req.params.id } }, { isDefault: false });
    const acc = await BankAccount.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, message: 'Updated.', data: acc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/vouchers/cash-bank-book — transactions for a bank/cash account
router.get('/cash-bank-book/entries', requirePermission('finance.management'), async (req, res) => {
  try {
    const { bankAccount, dateFrom, dateTo, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 50);
    let filter = { status: 'posted' };
    if (bankAccount) filter.bankAccount = bankAccount;
    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = new Date(dateFrom);
      if (dateTo) { const d = new Date(dateTo); d.setHours(23,59,59); filter.voucherDate.$lte = d; }
    }
    const [entries, total] = await Promise.all([
      Voucher.find(filter).sort({ voucherDate: 1 }).skip((p-1)*l).limit(l)
        .populate('bankAccount', 'accountName bankName').lean(),
      Voucher.countDocuments(filter),
    ]);
    res.json({ success: true, data: entries, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
