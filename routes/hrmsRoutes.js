import { Router } from 'express';
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import SalarySlip from '../models/SalarySlip.js';
import Loan from '../models/Loan.js';
import HrmsSettings from '../models/HrmsSettings.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { buildSalarySnapshot } from '../utils/salarySnapshot.js';
import {
  createEmployeeWithAccess,
  deactivateEmployee,
  employeeServiceErrorResponse,
  exitEmployee,
  getAssignableEmployeeRoles,
  getEmployeeWithAccess,
  listEmployeesWithAccess,
  updateEmployeeWithAccess,
} from '../services/employeeAccessService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getEmployeeIdsForSearch = async (search, branchId) => {
  if (!search) return null;
  const regex = new RegExp(escapeRegex(search), 'i');
  const employees = await Employee.find({
    branchId,
    $or: [{ name: regex }, { empId: regex }, { department: regex }],
  }).select('_id').lean();
  return employees.map(employee => employee._id);
};

const employeeBelongsToBranch = (employeeId, branchId) => mongoose.isValidObjectId(employeeId)
  ? Employee.exists({ _id: employeeId, branchId })
  : false;

const parseDay = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
    return parsed;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
};

const parseSalaryPeriod = (monthValue, yearValue) => {
  const month = Number(monthValue);
  const year = Number(yearValue);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: 'Month must be an integer between 1 and 12.' };
  }
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    return { error: 'Year must be a valid four-digit year.' };
  }
  return { month, year };
};

// ═══════════════════════════════════════
// EMPLOYEES
// ═══════════════════════════════════════
const employeeAccess = [requirePermission('employee.registration')];

const sendEmployeeError = (res, error) => {
  const response = employeeServiceErrorResponse(error);
  return res.status(response.status).json(response.body);
};

const validEmployeeId = (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(400).json({ success: false, message: 'Employee identifier is invalid.' });
  return false;
};

router.get('/employees/app-access-options', ...employeeAccess, (req, res) => {
  res.json({ success: true, data: { roles: getAssignableEmployeeRoles(req.user) } });
});

router.get('/employees', ...employeeAccess, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, department } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const clauses = [{ branchId: req.branchId }];
    if (search) {
      const regex = new RegExp(escapeRegex(String(search)), 'i');
      clauses.push({ $or: [{ name: regex }, { empId: regex }, { mobile: regex }, { department: regex }] });
    }
    if (status) clauses.push({ status });
    if (department) clauses.push({ department });
    const filter = { $and: clauses };
    const [employees, total] = await Promise.all([
      listEmployeesWithAccess(filter, { skip: (p - 1) * l, limit: l }),
      Employee.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: employees,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { sendEmployeeError(res, error); }
});

router.get('/employees/stats', ...employeeAccess, async (req, res) => {
  try {
    const branchFilter = { branchId: req.branchId };
    const [total, active, inactive, onNotice, terminated] = await Promise.all([
      Employee.countDocuments(branchFilter),
      Employee.countDocuments({ ...branchFilter, status: 'Active' }),
      Employee.countDocuments({ ...branchFilter, status: 'Inactive' }),
      Employee.countDocuments({ ...branchFilter, status: 'On Notice' }),
      Employee.countDocuments({ ...branchFilter, status: 'Terminated' }),
    ]);
    res.json({ success: true, data: { total, active, inactive, onNotice, terminated } });
  } catch (error) { sendEmployeeError(res, error); }
});

router.get('/employees/:id', ...employeeAccess, async (req, res) => {
  try {
    if (!validEmployeeId(req, res)) return;
    const employee = await getEmployeeWithAccess(req.params.id, req.branchId);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found in the selected branch.' });
    return res.json({ success: true, data: employee });
  } catch (error) { return sendEmployeeError(res, error); }
});

router.post('/employees', ...employeeAccess, async (req, res) => {
  try {
    const employee = await createEmployeeWithAccess({
      input: req.body,
      actor: req.user,
      selectedBranchId: req.branchId,
    });
    return res.status(201).json({ success: true, message: 'Employee created.', data: employee });
  } catch (error) { return sendEmployeeError(res, error); }
});

router.put('/employees/:id', ...employeeAccess, async (req, res) => {
  try {
    if (!validEmployeeId(req, res)) return;
    const employee = await updateEmployeeWithAccess({
      employeeId: req.params.id,
      input: req.body,
      actor: req.user,
      selectedBranchId: req.branchId,
    });
    return res.json({ success: true, message: 'Employee updated.', data: employee });
  } catch (error) { return sendEmployeeError(res, error); }
});

router.post('/employees/:id/exit', ...employeeAccess, async (req, res) => {
  try {
    if (!validEmployeeId(req, res)) return;
    const employee = await exitEmployee({
      employeeId: req.params.id,
      input: req.body,
      actor: req.user,
      selectedBranchId: req.branchId,
    });
    return res.json({ success: true, message: 'Employee exited and linked app access revoked.', data: employee });
  } catch (error) { return sendEmployeeError(res, error); }
});

router.delete('/employees/:id', ...employeeAccess, async (req, res) => {
  try {
    if (!validEmployeeId(req, res)) return;
    const employee = await deactivateEmployee({ employeeId: req.params.id, selectedBranchId: req.branchId });
    return res.json({
      success: true,
      message: employee.status === 'Terminated'
        ? 'Exited employee remains preserved and app access was revoked.'
        : 'Employee deactivated and linked app access revoked. No records were deleted.',
      data: employee,
    });
  } catch (error) { return sendEmployeeError(res, error); }
});

// ═══════════════════════════════════════
// ATTENDANCE
// ═══════════════════════════════════════
router.get('/attendance', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { date, dateFrom, dateTo, employee, status, search, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(5000, Math.max(1, parseInt(limit) || 50));
    const filter = { branch: req.branchId };

    if (date) {
      const start = parseDay(date);
      if (!start) return res.status(400).json({ success: false, message: 'Invalid attendance date.' });
      const end = new Date(start); end.setDate(end.getDate() + 1);
      filter.date = { $gte: start, $lt: end };
    } else if (dateFrom || dateTo) {
      const start = dateFrom ? parseDay(dateFrom) : null;
      const endDay = dateTo ? parseDay(dateTo) : null;
      if ((dateFrom && !start) || (dateTo && !endDay)) {
        return res.status(400).json({ success: false, message: 'Invalid attendance date range.' });
      }
      if (start && endDay && endDay < start) {
        return res.status(400).json({ success: false, message: 'dateTo cannot be before dateFrom.' });
      }
      filter.date = {};
      if (start) filter.date.$gte = start;
      if (endDay) { const exclusiveEnd = new Date(endDay); exclusiveEnd.setDate(exclusiveEnd.getDate() + 1); filter.date.$lt = exclusiveEnd; }
    }

    if (employee) filter.employee = employee;
    if (status) filter.status = status;
    if (search) filter.employee = { $in: await getEmployeeIdsForSearch(search, req.branchId) };

    const [records, total] = await Promise.all([
      Attendance.find(filter).sort({ date: -1 }).skip((p - 1) * l).limit(l).populate('employee', 'name empId department designation').lean(),
      Attendance.countDocuments(filter),
    ]);
    res.json({ success: true, data: records, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/attendance/punch-in', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, location, selfie } = req.body;
    if (!await employeeBelongsToBranch(employee, req.branchId)) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let record = await Attendance.findOne({ branch: req.branchId, employee, date: today });
    if (record && record.punchIn) return res.status(400).json({ success: false, message: 'Already punched in today.' });
    if (!record) record = new Attendance({ branch: req.branchId, employee, date: today });
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
    if (!await employeeBelongsToBranch(employee, req.branchId)) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const record = await Attendance.findOne({ branch: req.branchId, employee, date: today });
    if (!record || !record.punchIn) return res.status(400).json({ success: false, message: 'No punch-in found for today.' });
    if (record.punchOut) return res.status(400).json({ success: false, message: 'Already punched out.' });
    record.punchOut = new Date();
    record.punchOutLocation = location;
    record.punchOutSelfie = selfie;
    const diff = (record.punchOut - record.punchIn) / (1000 * 60 * 60);
    record.totalHours = Math.round(diff * 100) / 100;
    await record.save();
    res.json({ success: true, message: 'Punched out.', data: record });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/attendance/mark', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, date, status, remarks, punchIn, punchOut } = req.body;
    const attendanceDate = parseDay(date);
    if (!employee || !attendanceDate) {
      return res.status(400).json({ success: false, message: 'A valid employee and attendance date are required.' });
    }
    if (!await employeeBelongsToBranch(employee, req.branchId)) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    const parsedPunchIn = punchIn ? new Date(punchIn) : null;
    const parsedPunchOut = punchOut ? new Date(punchOut) : null;
    if ((punchIn && Number.isNaN(parsedPunchIn.getTime())) || (punchOut && Number.isNaN(parsedPunchOut.getTime()))) {
      return res.status(400).json({ success: false, message: 'Punch times must be valid date-time values.' });
    }
    if (parsedPunchIn && parsedPunchOut && parsedPunchOut < parsedPunchIn) {
      return res.status(400).json({ success: false, message: 'Punch-out cannot be before punch-in.' });
    }

    let record = await Attendance.findOne({ branch: req.branchId, employee, date: attendanceDate });
    if (!record) record = new Attendance({ branch: req.branchId, employee, date: attendanceDate });
    record.status = status;
    record.remarks = remarks || '';
    if (parsedPunchIn) record.punchIn = parsedPunchIn;
    if (parsedPunchOut) record.punchOut = parsedPunchOut;
    const effectivePunchIn = parsedPunchIn || record.punchIn;
    const effectivePunchOut = parsedPunchOut || record.punchOut;
    if (effectivePunchIn && effectivePunchOut && effectivePunchOut < effectivePunchIn) {
      return res.status(400).json({ success: false, message: 'Punch-out cannot be before punch-in.' });
    }
    record.totalHours = effectivePunchIn && effectivePunchOut
      ? Math.round(((effectivePunchOut - effectivePunchIn) / (1000 * 60 * 60)) * 100) / 100
      : 0;
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
    const filter = { branch: req.branchId };
    if (employee) filter.employee = employee;
    if (status) filter.status = status;
    const [leaves, total] = await Promise.all([
      Leave.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).populate('employee', 'name empId department').lean(),
      Leave.countDocuments(filter),
    ]);
    res.json({ success: true, data: leaves, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/leaves', requirePermission('attendance.master'), async (req, res) => {
  try {
    if (!await employeeBelongsToBranch(req.body.employee, req.branchId)) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    const leave = await Leave.create({ ...req.body, branch: req.branchId, appliedBy: req.user._id });
    res.status(201).json({ success: true, message: 'Leave applied.', data: leave });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/leaves/:id/approve', requirePermission('attendance.master'), async (req, res) => {
  try {
    const leave = await Leave.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'Pending' },
      { status: 'Approved', approvedBy: req.user._id, approvalDate: new Date() },
      { new: true, runValidators: true },
    );
    if (!leave) {
      const existing = await Leave.findOne({ _id: req.params.id, branch: req.branchId }).select('status').lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Leave not found.' });
      return res.status(409).json({ success: false, message: `Only Pending leave can be approved. Current status: ${existing.status}.` });
    }

    const balanceKey = { Casual: 'casual', Sick: 'sick', Earned: 'earned', Unpaid: 'unpaid' }[leave.leaveType];
    if (balanceKey) {
      const balancePath = `leaveBalance.${balanceKey}`;
      await Employee.updateOne(
        { _id: leave.employee, branchId: req.branchId },
        [{ $set: { [balancePath]: { $max: [0, { $subtract: [{ $ifNull: [`$${balancePath}`, 0] }, leave.days] }] } } }],
      );
    }
    res.json({ success: true, message: 'Leave approved.', data: leave });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/leaves/:id/reject', requirePermission('attendance.master'), async (req, res) => {
  try {
    const leave = await Leave.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'Pending' },
      { status: 'Rejected', rejectionReason: req.body.reason, approvedBy: req.user._id, approvalDate: new Date() },
      { new: true, runValidators: true },
    );
    if (!leave) {
      const existing = await Leave.findOne({ _id: req.params.id, branch: req.branchId }).select('status').lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Leave not found.' });
      return res.status(409).json({ success: false, message: `Only Pending leave can be rejected. Current status: ${existing.status}.` });
    }
    res.json({ success: true, message: 'Leave rejected.', data: leave });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// SALARY SLIPS
// ═══════════════════════════════════════
router.get('/salary-slips', requirePermission('salary.management'), async (req, res) => {
  try {
    const { month, year, status, search, page = 1, limit = 20 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const filter = { branch: req.branchId };
    if (month) filter.month = parseInt(month);
    if (year) filter.year = parseInt(year);
    if (status) filter.status = status;
    if (search) filter.employee = { $in: await getEmployeeIdsForSearch(search, req.branchId) };
    const [slips, total] = await Promise.all([
      SalarySlip.find(filter).sort({ year: -1, month: -1 }).skip((p - 1) * l).limit(l).populate('employee', 'name empId department designation').lean(),
      SalarySlip.countDocuments(filter),
    ]);
    res.json({ success: true, data: slips, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/salary-slips/generate-bulk', requirePermission('salary.management'), async (req, res) => {
  try {
    const period = parseSalaryPeriod(req.body.month, req.body.year);
    if (period.error) return res.status(400).json({ success: false, message: period.error });

    const employees = await Employee.find({ branchId: req.branchId, status: 'Active' }).lean();
    if (!employees.length) {
      return res.json({ success: true, message: 'No active employees found.', data: { createdCount: 0, skippedCount: 0 } });
    }

    const operations = employees.map(employee => ({
      updateOne: {
        filter: { branch: req.branchId, employee: employee._id, month: period.month, year: period.year },
        update: { $setOnInsert: buildSalarySnapshot(employee, period.month, period.year, req.user._id, req.branchId) },
        upsert: true,
      },
    }));
    const result = await SalarySlip.bulkWrite(operations, { ordered: false });
    const createdCount = result.upsertedCount || 0;
    const skippedCount = employees.length - createdCount;
    res.json({
      success: true,
      message: `Draft salary slips generated: ${createdCount} created, ${skippedCount} skipped.`,
      data: { createdCount, skippedCount },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/salary-slips/generate', requirePermission('salary.management'), async (req, res) => {
  try {
    const { employeeId } = req.body;
    const period = parseSalaryPeriod(req.body.month, req.body.year);
    if (period.error) return res.status(400).json({ success: false, message: period.error });
    if (!employeeId) return res.status(400).json({ success: false, message: 'employeeId is required.' });
    if (!mongoose.isValidObjectId(employeeId)) {
      return res.status(400).json({ success: false, message: 'employeeId must be a valid identifier.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, branchId: req.branchId }).lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    const existing = await SalarySlip.findOne({ branch: req.branchId, employee: employeeId, month: period.month, year: period.year });
    if (existing) return res.status(409).json({ success: false, message: 'Salary slip already exists for this month.' });

    const slip = await SalarySlip.create(buildSalarySnapshot(employee, period.month, period.year, req.user._id, req.branchId));
    res.status(201).json({ success: true, message: 'Draft salary slip generated.', data: slip });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ success: false, message: 'Salary slip already exists for this month.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════
// LOANS & ADVANCES
// ═══════════════════════════════════════
router.get('/loans', requirePermission('attendance.master'), async (req, res) => {
  try {
    const { employee, status, type, search, page = 1, limit = 20 } = req.query;
    const filter = { branch: req.branchId };
    if (employee) filter.employee = employee;
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (search) filter.employee = { $in: await getEmployeeIdsForSearch(search, req.branchId) };
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const [loans, total] = await Promise.all([
      Loan.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).populate('employee', 'name empId department').lean(),
      Loan.countDocuments(filter),
    ]);
    res.json({ success: true, data: loans, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/loans', requirePermission('attendance.master'), async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const totalInstallments = Number(req.body.totalInstallments);
    const providedEmi = req.body.emiAmount === undefined || req.body.emiAmount === null || req.body.emiAmount === ''
      ? null
      : Number(req.body.emiAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than zero.' });
    }
    if (!Number.isInteger(totalInstallments) || totalInstallments <= 0) {
      return res.status(400).json({ success: false, message: 'Total installments must be a positive integer.' });
    }
    if (providedEmi !== null && (!Number.isFinite(providedEmi) || providedEmi <= 0)) {
      return res.status(400).json({ success: false, message: 'EMI amount must be greater than zero when provided.' });
    }
    if (!await employeeBelongsToBranch(req.body.employee, req.branchId)) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    const emiAmount = Math.round((providedEmi ?? (amount / totalInstallments)) * 100) / 100;
    const data = {
      ...req.body,
      branch: req.branchId,
      amount,
      totalInstallments,
      emiAmount,
      remainingAmount: amount,
      createdBy: req.user._id,
    };
    const loan = await Loan.create(data);
    res.status(201).json({ success: true, message: 'Loan/Advance created.', data: loan });
  } catch (e) {
    if (e.name === 'ValidationError' || e.name === 'CastError') return res.status(400).json({ success: false, message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════
// HRMS SETTINGS
// ═══════════════════════════════════════
const configurableSettingFields = [
  'defaultShiftStart', 'defaultShiftEnd', 'lunchBreakMinutes', 'graceMinutes',
  'lateMarkAfterMinutes', 'halfDayAfterMinutes', 'lateMarksForHalfDay',
  'overtimeAfterHours', 'overtimeRateMultiplier', 'overtimeEnabled', 'weeklyOffs',
  'officeLocation', 'geofenceRadius', 'casualLeavePerYear', 'sickLeavePerYear',
  'earnedLeavePerYear', 'leaveAccrualDay', 'salaryProcessingDay', 'pfPercentage',
  'esiPercentage', 'esiThreshold', 'noPunchAlertTime', 'sendLateAlerts', 'sendAbsentAlerts',
];

router.get('/settings', requirePermission('attendance.master'), async (req, res) => {
  try {
    const settings = await HrmsSettings.findOneAndUpdate(
      { branch: req.branchId },
      { $setOnInsert: { branch: req.branchId } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ success: true, data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/settings', requirePermission('attendance.master'), async (req, res) => {
  try {
    const unknownFields = Object.keys(req.body).filter(key => !configurableSettingFields.includes(key));
    if (unknownFields.length) {
      return res.status(400).json({ success: false, message: `Unsupported settings fields: ${unknownFields.join(', ')}.` });
    }

    const updates = Object.fromEntries(configurableSettingFields
      .filter(key => Object.prototype.hasOwnProperty.call(req.body, key))
      .map(key => [key, req.body[key]]));
    const settings = await HrmsSettings.findOneAndUpdate(
      { branch: req.branchId },
      { $set: updates, $setOnInsert: { branch: req.branchId } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ success: true, message: 'Settings updated.', data: settings });
  } catch (e) {
    if (e.name === 'ValidationError' || e.name === 'CastError') return res.status(400).json({ success: false, message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

export default router;
