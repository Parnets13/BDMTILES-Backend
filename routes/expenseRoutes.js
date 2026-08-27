import { Router } from 'express';
import Expense from '../models/Expense.js';
import Employee from '../models/Employee.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

// GET /api/v1/expenses
router.get('/', requirePermission('expense.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, category, employee, dateFrom, dateTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = { branch: req.branchId };
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ expenseNumber: r }, { employeeName: r }, { description: r }]; }
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (employee) filter.employee = employee;
    if (dateFrom || dateTo) {
      filter.expenseDate = {};
      if (dateFrom) filter.expenseDate.$gte = new Date(dateFrom);
      if (dateTo) { const d = new Date(dateTo); d.setHours(23,59,59); filter.expenseDate.$lte = d; }
    }
    const [data, total] = await Promise.all([
      Expense.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('employee', 'name employeeCode department').populate('approvedBy', 'name').lean(),
      Expense.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/expenses/stats
router.get('/stats', requirePermission('expense.management'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, pending, approved, rejected, reimbursed] = await Promise.all([
      Expense.countDocuments(scope),
      Expense.countDocuments({ ...scope, status: 'pending' }),
      Expense.countDocuments({ ...scope, status: 'approved' }),
      Expense.countDocuments({ ...scope, status: 'rejected' }),
      Expense.countDocuments({ ...scope, status: 'reimbursed' }),
    ]);
    const totalAmount = await Expense.aggregate([
      { $match: { ...scope, status: { $in: ['approved', 'reimbursed'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const pendingAmount = await Expense.aggregate([
      { $match: { ...scope, status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    res.json({ success: true, data: { total, pending, approved, rejected, reimbursed, totalAmount: totalAmount[0]?.total || 0, pendingAmount: pendingAmount[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/expenses
router.post('/', requirePermission('expense.management'), async (req, res) => {
  try {
    const data = { ...req.body, branch: req.branchId, createdBy: req.user._id };
    data.expenseNumber = await generateBranchNumber(req.branchId, 'expense', data.expenseDate || new Date());
    if (data.employee) {
      const emp = await Employee.findById(data.employee).lean();
      if (emp) { data.employeeName = emp.name; data.department = emp.department; }
    }
    const expense = await Expense.create(data);
    res.status(201).json({ success: true, message: `Expense ${expense.expenseNumber} submitted.`, data: expense });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/expenses/:id/approve
router.patch('/:id/approve', requirePermission('expense.approve'), async (req, res) => {
  try {
    const exp = await Expense.findOne({ _id: req.params.id, branch: req.branchId });
    if (!exp) return res.status(404).json({ success: false, message: 'Not found.' });
    exp.status = 'approved';
    exp.approvedBy = req.user._id;
    exp.approvedAt = new Date();
    await exp.save();
    res.json({ success: true, message: 'Expense approved.', data: exp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/expenses/:id/reject
router.patch('/:id/reject', requirePermission('expense.approve'), async (req, res) => {
  try {
    const exp = await Expense.findOneAndUpdate({ _id: req.params.id, branch: req.branchId }, {
      status: 'rejected', rejectionReason: req.body.reason || '', approvedBy: req.user._id, approvedAt: new Date(),
    }, { new: true });
    res.json({ success: true, message: 'Expense rejected.', data: exp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/expenses/:id/reimburse
router.patch('/:id/reimburse', requirePermission('expense.approve'), async (req, res) => {
  try {
    const exp = await Expense.findOneAndUpdate({ _id: req.params.id, branch: req.branchId }, {
      status: 'reimbursed', reimbursementDate: new Date(), reimbursementRef: req.body.ref || '',
    }, { new: true });
    res.json({ success: true, message: 'Marked as reimbursed.', data: exp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
