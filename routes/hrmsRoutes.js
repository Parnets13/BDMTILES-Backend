import { Router } from 'express';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import SalarySlip from '../models/SalarySlip.js';
import Loan from '../models/Loan.js';
import HrmsSettings from '../models/HrmsSettings.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ═══════════════════════════════════════
// EMPLOYEES
// ═══════════════════════════════════════
router.get('/employees', requirePermission('employee.registration'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, department } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ name: r }, { empId: r }, { mobile: r }, { department: r }]; }
    if (status) filter.status = status;
    if (department) filter.department = department;
    const [employees, total] = await Promise.all([
      Employee.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Employee.countDocuments(filter),
    ]);
    res.json({ success: true, data: employees, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/employees/stats', requirePermission('employee.registration'), async (req, res) => {
  try {
    const [total, active, inactive] = await Promise.all([
      Employee.countDocuments(), Employee.countDocuments({ status: 'Active' }), Employee.countDocuments({ status: { $ne: 'Active' } }),
    ]);
    res.json({ success: true, data: { total, active, inactive } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/employees/:id', requirePermission('employee.registration'), async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id).lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, data: emp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/employees', requirePermission('employee.registration'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    if (!data.empId) data.empId = await Employee.generateEmpId();
    const emp = await Employee.create(data);
    res.status(201).json({ success: true, message: 'Employee created.', data: emp });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Employee ID already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/employees/:id', requirePermission('employee.registration'), async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Not found.' });
    Object.assign(emp, req.body);
    await emp.save();
    res.json({ success: true, message: 'Employee updated.', data: emp });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/employees/:id', requirePermission('employee.registration'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const Employee = (await import('../models/Employee.js')).default;
    const result = await safeDelete(Employee, req.params.id, { user: req.user, module: 'employee', titleField: 'name', codeField: 'empId' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// ATTENDANCE
// ═══════════════════════════════════════
router.get('/attendance', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { date, employee, status, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(100, parseInt(limit) || 50);
    let filter = {};
    if (date) { const d = new Date(date); d.setHours(0,0,0,0); const next = new Date(d); next.setDate(next.getDate()+1); filter.date = { $gte: d, $lt: next }; }
    if (employee) filter.employee = employee;
    if (status) filter.status = status;
    const [records, total] = await Promise.all([
      Attendance.find(filter).sort({ date: -1 }).skip((p-1)*l).limit(l).populate('employee', 'name empId department designation').lean(),
      Attendance.countDocuments(filter),
    ]);
    res.json({ success: true, data: records, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/attendance/punch-in', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, location, selfie } = req.body;
    const today = new Date(); today.setHours(0,0,0,0);
    let record = await Attendance.findOne({ employee, date: today });
    if (record && record.punchIn) return res.status(400).json({ success: false, message: 'Already punched in today.' });
    if (!record) record = new Attendance({ employee, date: today });
    record.punchIn = new Date();
    record.punchInLocation = location;
    record.punchInSelfie = selfie;
    record.status = 'Present';
    record.source = 'GPS';
    await record.save();
    res.json({ success: true, message: 'Punched in.', data: record });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/attendance/punch-out', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, location, selfie } = req.body;
    const today = new Date(); today.setHours(0,0,0,0);
    const record = await Attendance.findOne({ employee, date: today });
    if (!record || !record.punchIn) return res.status(400).json({ success: false, message: 'No punch-in found for today.' });
    if (record.punchOut) return res.status(400).json({ success: false, message: 'Already punched out.' });
    record.punchOut = new Date();
    record.punchOutLocation = location;
    record.punchOutSelfie = selfie;
    // Calculate hours
    const diff = (record.punchOut - record.punchIn) / (1000 * 60 * 60);
    record.totalHours = Math.round(diff * 100) / 100;
    await record.save();
    res.json({ success: true, message: 'Punched out.', data: record });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/attendance/mark', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, date, status, remarks, punchIn, punchOut } = req.body;
    const d = new Date(date); d.setHours(0,0,0,0);
    let record = await Attendance.findOne({ employee, date: d });
    if (!record) record = new Attendance({ employee, date: d });
    record.status = status;
    record.remarks = remarks || '';
    if (punchIn) record.punchIn = punchIn;
    if (punchOut) record.punchOut = punchOut;
    record.markedBy = req.user._id;
    record.source = 'Manual';
    await record.save();
    res.json({ success: true, message: 'Attendance marked.', data: record });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// LEAVES
// ═══════════════════════════════════════
router.get('/leaves', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, status, page = 1, limit = 20 } = req.query;
    const p = Math.max(1, parseInt(page)); const l = parseInt(limit) || 20;
    let filter = {};
    if (employee) filter.employee = employee;
    if (status) filter.status = status;
    const [leaves, total] = await Promise.all([
      Leave.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).populate('employee', 'name empId department').lean(),
      Leave.countDocuments(filter),
    ]);
    res.json({ success: true, data: leaves, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/leaves', requirePermission('attendance.master'), async (req, res) => {
  try {
    const leave = await Leave.create({ ...req.body, appliedBy: req.user._id });
    res.status(201).json({ success: true, message: 'Leave applied.', data: leave });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/leaves/:id/approve', requirePermission('attendance.master'), async (req, res) => {
  try {
    const leave = await Leave.findByIdAndUpdate(req.params.id, { status: 'Approved', approvedBy: req.user._id, approvalDate: new Date() }, { new: true });
    if (!leave) return res.status(404).json({ success: false, message: 'Not found.' });
    // Deduct from employee balance
    const emp = await Employee.findById(leave.employee);
    if (emp && emp.leaveBalance) {
      const key = leave.leaveType.toLowerCase();
      if (emp.leaveBalance[key] !== undefined) { emp.leaveBalance[key] = Math.max(0, emp.leaveBalance[key] - leave.days); await emp.save(); }
    }
    res.json({ success: true, message: 'Leave approved.', data: leave });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/leaves/:id/reject', requirePermission('attendance.master'), async (req, res) => {
  try {
    const leave = await Leave.findByIdAndUpdate(req.params.id, { status: 'Rejected', rejectionReason: req.body.reason, approvedBy: req.user._id }, { new: true });
    res.json({ success: true, message: 'Leave rejected.', data: leave });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// SALARY SLIPS
// ═══════════════════════════════════════
router.get('/salary-slips', requirePermission('salary.management'), async (req, res) => {
  try {
    const { month, year, status, page = 1, limit = 20 } = req.query;
    const p = Math.max(1, parseInt(page)); const l = parseInt(limit) || 20;
    let filter = {};
    if (month) filter.month = parseInt(month);
    if (year) filter.year = parseInt(year);
    if (status) filter.status = status;
    const [slips, total] = await Promise.all([
      SalarySlip.find(filter).sort({ year: -1, month: -1 }).skip((p-1)*l).limit(l).populate('employee', 'name empId department designation').lean(),
      SalarySlip.countDocuments(filter),
    ]);
    res.json({ success: true, data: slips, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/salary-slips/generate', requirePermission('salary.management'), async (req, res) => {
  try {
    const { employeeId, month, year } = req.body;
    const emp = await Employee.findById(employeeId).lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
    // Check if already exists
    const existing = await SalarySlip.findOne({ employee: employeeId, month, year });
    if (existing) return res.status(400).json({ success: false, message: 'Salary slip already exists for this month.' });
    // Basic salary calculation (can be enhanced with attendance-based deductions)
    const slip = await SalarySlip.create({
      employee: employeeId, month, year,
      basicSalary: emp.basicSalary, hra: emp.hra, conveyance: emp.conveyance,
      medicalAllowance: emp.medicalAllowance, specialAllowance: emp.specialAllowance, otherAllowance: emp.otherAllowance,
      pf: emp.pf, esi: emp.esi, professionalTax: emp.professionalTax, tds: emp.tds, otherDeductions: emp.otherDeductions,
      grossEarnings: emp.grossSalary, grossDeductions: (emp.pf||0) + (emp.esi||0) + (emp.professionalTax||0) + (emp.tds||0) + (emp.otherDeductions||0),
      netSalary: emp.netSalary,
      generatedBy: req.user._id, tallySyncStatus: 'not_synced',
    });
    res.status(201).json({ success: true, message: 'Salary slip generated.', data: slip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// LOANS & ADVANCES
// ═══════════════════════════════════════
router.get('/loans', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, status, page = 1, limit = 20 } = req.query;
    let filter = {};
    if (employee) filter.employee = employee;
    if (status) filter.status = status;
    const p = Math.max(1, parseInt(page)); const l = parseInt(limit) || 20;
    const [loans, total] = await Promise.all([
      Loan.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).populate('employee', 'name empId department').lean(),
      Loan.countDocuments(filter),
    ]);
    res.json({ success: true, data: loans, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/loans', requirePermission('attendance.master'), async (req, res) => {
  try {
    const data = { ...req.body, remainingAmount: req.body.amount, createdBy: req.user._id };
    const loan = await Loan.create(data);
    res.status(201).json({ success: true, message: 'Loan/Advance created.', data: loan });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// HRMS SETTINGS
// ═══════════════════════════════════════
router.get('/settings', requirePermission('attendance.master'), async (req, res) => {
  try {
    let settings = await HrmsSettings.findOne().lean();
    if (!settings) settings = await HrmsSettings.create({});
    res.json({ success: true, data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/settings', requirePermission('attendance.master'), async (req, res) => {
  try {
    let settings = await HrmsSettings.findOne();
    if (!settings) settings = new HrmsSettings();
    Object.assign(settings, req.body);
    await settings.save();
    res.json({ success: true, message: 'Settings updated.', data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
