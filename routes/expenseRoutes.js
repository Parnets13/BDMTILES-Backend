import { Router } from 'express';
import Expense from '../models/Expense.js';
import ExpenseCategory from '../models/ExpenseCategory.js';
import Employee from '../models/Employee.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ── List ────────────────────────────────────────────────────
router.get('/', requirePermission('finance.management'), async (req, res) => {
  try {
    const { page = 1, limit = 25, search, status, category, dateFrom, dateTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 25);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ expenseNumber: r }, { description: r }, { employeeName: r }]; }
    if (status)   filter.status = status;
    if (category) filter.category = category;
    if (dateFrom || dateTo) {
      filter.expenseDate = {};
      if (dateFrom) filter.expenseDate.$gte = new Date(dateFrom);
      if (dateTo)   { const d = new Date(dateTo); d.setHours(23,59,59); filter.expenseDate.$lte = d; }
    }
    const [data, total] = await Promise.all([
      Expense.find(filter).sort({ expenseDate: -1 }).skip((p-1)*l).limit(l)
        .populate('category', 'name').populate('employee', 'name').lean(),
      Expense.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Stats ───────────────────────────────────────────────────
router.get('/stats', requirePermission('finance.management'), async (req, res) => {
  try {
    const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const [total, pending, approved, monthTotal, byCategory] = await Promise.all([
      Expense.countDocuments(),
      Expense.countDocuments({ status: { $in: ['submitted'] } }),
      Expense.countDocuments({ status: 'approved' }),
      Expense.aggregate([{ $match: { expenseDate: { $gte: thisMonth }, status: { $ne: 'rejected' } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.aggregate([
        { $match: { status: { $ne: 'rejected' } } },
        { $group: { _id: '$categoryName', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } }, { $limit: 5 },
      ]),
    ]);
    res.json({ success: true, data: { total, pending, approved, monthTotal: monthTotal[0]?.total || 0, byCategory } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Create ──────────────────────────────────────────────────
router.post('/', requirePermission('finance.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Expense.countDocuments();
    data.expenseNumber = `EXP-${String(count + 1).padStart(5, '0')}`;
    if (data.category) {
      const cat = await ExpenseCategory.findById(data.category).lean();
      if (cat) data.categoryName = cat.name;
    }
    if (data.employee) {
      const emp = await Employee.findById(data.employee).lean();
      if (emp) data.employeeName = emp.name;
    }
    const expense = await Expense.create(data);
    res.status(201).json({ success: true, message: `Expense ${expense.expenseNumber} created.`, data: expense });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Update ──────────────────────────────────────────────────
router.put('/:id', requirePermission('finance.management'), async (req, res) => {
  try {
    const exp = await Expense.findById(req.params.id);
    if (!exp) return res.status(404).json({ success: false, message: 'Not found.' });
    if (['approved', 'paid'].includes(exp.status)) return res.status(400).json({ success: false, message: 'Cannot edit approved expense.' });
    Object.assign(exp, req.body);
    await exp.save();
    res.json({ success: true, data: exp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Approve ─────────────────────────────────────────────────
router.patch('/:id/approve', requirePermission('finance.management'), async (req, res) => {
  try {
    const exp = await Expense.findByIdAndUpdate(req.params.id, {
      status: 'approved', approvedBy: req.user._id,
      approvalNotes: req.body.notes || '', approvalDate: new Date(),
    }, { new: true });
    res.json({ success: true, message: 'Expense approved.', data: exp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Reject ──────────────────────────────────────────────────
router.patch('/:id/reject', requirePermission('finance.management'), async (req, res) => {
  try {
    const exp = await Expense.findByIdAndUpdate(req.params.id, {
      status: 'rejected', approvalNotes: req.body.notes || '', approvalDate: new Date(),
    }, { new: true });
    res.json({ success: true, message: 'Expense rejected.', data: exp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Mark Paid ───────────────────────────────────────────────
router.patch('/:id/pay', requirePermission('finance.management'), async (req, res) => {
  try {
    const exp = await Expense.findByIdAndUpdate(req.params.id, {
      status: 'paid', paidDate: new Date(), bankAccount: req.body.bankAccount,
    }, { new: true });
    res.json({ success: true, message: 'Marked as paid.', data: exp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
