import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import SalarySlip from '../models/SalarySlip.js';
import Loan from '../models/Loan.js';
import HrmsSettings from '../models/HrmsSettings.js';
import EmployeeExit, { EXIT_CLEARANCE_ITEMS } from '../models/EmployeeExit.js';
import PerformanceReview, { PERFORMANCE_COMPONENTS } from '../models/PerformanceReview.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { buildSalarySnapshot } from '../utils/salarySnapshot.js';
import { hrGeneratedDocumentDirectory, candidateResumeDirectory } from '../middleware/upload.js';
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
import {
  buildClearanceFacts,
  closeRecoveredLoans,
  computeSettlementDraft,
  recalcSettlementTotals,
} from '../services/employeeExitService.js';
import { computePerformance } from '../services/performanceService.js';

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

// Authenticated download for a file in Employee.documents (candidate resumes
// carried forward on conversion live in candidateResumeDirectory; HR-generated
// offer/appointment letters etc. live in hrGeneratedDocumentDirectory — try both
// since the stored filename alone doesn't say which one it came from).
router.get('/employees/:id/documents/:fileName', ...employeeAccess, async (req, res) => {
  try {
    if (!validEmployeeId(req, res)) return;
    const employee = await Employee.findOne({ _id: req.params.id, branchId: req.branchId }).select('documents').lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found in the selected branch.' });
    const storedName = path.basename(req.params.fileName);
    if (storedName !== req.params.fileName) return res.status(400).json({ success: false, message: 'Invalid file reference.' });
    const doc = (employee.documents || []).find((d) => d.url === storedName);
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found on this employee.' });
    for (const directory of [hrGeneratedDocumentDirectory, candidateResumeDirectory]) {
      const filePath = path.join(directory, storedName);
      try {
        const content = await fs.promises.readFile(filePath);
        res.attachment(doc.name || storedName);
        return res.send(content);
      } catch { /* try the next directory */ }
    }
    return res.status(404).json({ success: false, message: 'Document file is missing from storage.' });
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

// ═══════════════════════════════════════
// EMPLOYEE EXIT (resignation → clearance → full & final)
// ═══════════════════════════════════════
// The case document drives the exit; terminating the employee and revoking app
// access still happens only through exitEmployee(), at the final step.
const exitAccess = [requirePermission('employee.exit')];

const validExitId = (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(400).json({ success: false, message: 'Exit case identifier is invalid.' });
  return false;
};

const OPEN_EXIT_STATUSES = ['pending_approval', 'approved', 'in_clearance', 'settled'];

const loadExitCase = async (id, branchId) => EmployeeExit.findOne({ _id: id, branch: branchId });

router.get('/exits/stats', ...exitAccess, async (req, res) => {
  try {
    const base = { branch: req.branchId };
    const [pendingApproval, inClearance, settled, completed, rows] = await Promise.all([
      EmployeeExit.countDocuments({ ...base, status: 'pending_approval' }),
      EmployeeExit.countDocuments({ ...base, status: { $in: ['approved', 'in_clearance'] } }),
      EmployeeExit.countDocuments({ ...base, status: 'settled' }),
      EmployeeExit.countDocuments({ ...base, status: 'completed' }),
      EmployeeExit.aggregate([
        { $match: { ...base, status: { $in: ['settled', 'completed'] } } },
        { $group: { _id: null, netPayable: { $sum: '$settlement.netPayable' } } },
      ]),
    ]);
    res.json({
      success: true,
      data: {
        pendingApproval,
        inClearance,
        settled,
        completed,
        open: pendingApproval + inClearance + settled,
        settledNetPayable: Math.round((rows[0]?.netPayable || 0) * 100) / 100,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/exits', ...exitAccess, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, exitType, search } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const clauses = [{ branch: req.branchId }];
    if (status === 'open') clauses.push({ status: { $in: OPEN_EXIT_STATUSES } });
    else if (status) clauses.push({ status });
    if (exitType) clauses.push({ exitType });
    if (search) {
      const regex = new RegExp(escapeRegex(String(search)), 'i');
      clauses.push({ $or: [{ employeeName: regex }, { empId: regex }, { department: regex }] });
    }
    const filter = { $and: clauses };
    const [data, total] = await Promise.all([
      EmployeeExit.find(filter)
        .sort({ resignationDate: -1, createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      EmployeeExit.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Resignation entry. Puts the employee on notice but leaves them active — they
// are still working, and revoking access now would be wrong.
router.post('/exits', ...exitAccess, async (req, res) => {
  try {
    const {
      employeeId, exitType, reason, reasonCategory, resignationDate,
      noticePeriodDays, requestedLastWorkingDay,
    } = req.body;

    if (!mongoose.isValidObjectId(employeeId)) {
      return res.status(400).json({ success: false, message: 'A valid employee must be selected.' });
    }
    if (!String(reason || '').trim()) {
      return res.status(400).json({ success: false, message: 'A reason for the exit is required.' });
    }
    const resigned = parseDay(resignationDate) || new Date();
    const requestedLwd = parseDay(requestedLastWorkingDay);
    if (requestedLastWorkingDay && !requestedLwd) {
      return res.status(400).json({ success: false, message: 'Requested last working day is not a valid date.' });
    }
    if (requestedLwd && requestedLwd < resigned) {
      return res.status(400).json({ success: false, message: 'Last working day cannot fall before the resignation date.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, branchId: req.branchId });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found in the selected branch.' });
    if (employee.status === 'Terminated') {
      return res.status(409).json({ success: false, message: 'This employee has already exited.' });
    }

    const existing = await EmployeeExit.findOne({
      branch: req.branchId, employee: employeeId, status: { $in: OPEN_EXIT_STATUSES },
    }).select('_id status').lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `An exit case is already open for this employee (status ${existing.status}).`,
        data: { exitId: existing._id },
      });
    }

    const notice = Number.isFinite(Number(noticePeriodDays)) ? Math.max(0, Number(noticePeriodDays)) : 30;
    const exitCase = await EmployeeExit.create({
      branch: req.branchId,
      employee: employee._id,
      employeeName: employee.name,
      empId: employee.empId || '',
      designation: employee.designation || '',
      department: employee.department || '',
      dateOfJoining: employee.dateOfJoining,
      exitType: exitType || 'resignation',
      reason: String(reason).trim(),
      reasonCategory: reasonCategory || 'other',
      resignationDate: resigned,
      noticePeriodDays: notice,
      requestedLastWorkingDay: requestedLwd
        || new Date(resigned.getTime() + notice * 86400000),
      clearance: EXIT_CLEARANCE_ITEMS.map(item => ({ ...item, status: 'pending' })),
      createdBy: req.user._id,
    });

    // 'On Notice' already exists in the Employee status enum and was unused.
    if (employee.status === 'Active') {
      employee.status = 'On Notice';
      await employee.save();
    }

    res.status(201).json({ success: true, message: 'Resignation recorded. Employee is now on notice.', data: exitCase });
  } catch (e) {
    if (e.name === 'ValidationError' || e.name === 'CastError') return res.status(400).json({ success: false, message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

// Detail view bundles the live clearance facts so the UI never has to guess
// whether an asset is still outstanding.
router.get('/exits/:id', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });

    const employee = await Employee.findById(exitCase.employee).lean();
    const facts = employee
      ? await buildClearanceFacts({ employee, branchId: req.branchId })
      : null;

    res.json({
      success: true,
      data: {
        exit: exitCase.toObject(),
        employee: employee
          ? {
            _id: employee._id, name: employee.name, empId: employee.empId,
            designation: employee.designation, department: employee.department,
            dateOfJoining: employee.dateOfJoining, status: employee.status,
            salaryType: employee.salaryType, grossSalary: employee.grossSalary,
            netSalary: employee.netSalary, basicSalary: employee.basicSalary,
            dailyWageRate: employee.dailyWageRate, leaveBalance: employee.leaveBalance,
            mobile: employee.mobile, email: employee.email,
          }
          : null,
        clearanceFacts: facts,
        employeeMissing: !employee,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/exits/:id/decision', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const { decision, approvedLastWorkingDay, noticeWaived, remarks } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approved or rejected.' });
    }
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });
    if (exitCase.status !== 'pending_approval') {
      return res.status(409).json({ success: false, message: `This case is already ${exitCase.status} and cannot be decided again.` });
    }

    exitCase.approval = {
      by: req.user._id, byName: req.user.name || '', at: new Date(),
      remarks: String(remarks || '').trim(), decision,
    };

    if (decision === 'rejected') {
      exitCase.status = 'rejected';
      // Rejecting the resignation puts the employee back to work.
      await Employee.updateOne(
        { _id: exitCase.employee, branchId: req.branchId, status: 'On Notice' },
        { $set: { status: 'Active' } }
      );
      await exitCase.save();
      return res.json({ success: true, message: 'Exit request rejected. Employee restored to Active.', data: exitCase });
    }

    const approvedLwd = parseDay(approvedLastWorkingDay) || exitCase.requestedLastWorkingDay;
    if (!approvedLwd) {
      return res.status(400).json({ success: false, message: 'An approved last working day is required.' });
    }
    if (approvedLwd < exitCase.resignationDate) {
      return res.status(400).json({ success: false, message: 'Approved last working day cannot fall before the resignation date.' });
    }

    exitCase.approvedLastWorkingDay = approvedLwd;
    exitCase.noticeWaived = !!noticeWaived;
    // Shortfall is what the employee did not serve, and it is what a notice-pay
    // deduction is computed from later.
    const servedDays = Math.max(0, Math.floor((approvedLwd - exitCase.resignationDate) / 86400000));
    exitCase.noticeShortfallDays = noticeWaived ? 0 : Math.max(0, (exitCase.noticePeriodDays || 0) - servedDays);
    exitCase.status = 'in_clearance';

    await exitCase.save();
    res.json({ success: true, message: 'Exit approved. Clearance is now open.', data: exitCase });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/exits/:id/withdraw', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });
    if (!['pending_approval', 'approved', 'in_clearance'].includes(exitCase.status)) {
      return res.status(409).json({ success: false, message: `A case that is ${exitCase.status} can no longer be withdrawn.` });
    }
    exitCase.status = 'withdrawn';
    exitCase.approval.remarks = String(req.body.remarks || exitCase.approval.remarks || '').trim();
    await exitCase.save();
    await Employee.updateOne(
      { _id: exitCase.employee, branchId: req.branchId, status: 'On Notice' },
      { $set: { status: 'Active' } }
    );
    res.json({ success: true, message: 'Exit withdrawn. Employee restored to Active.', data: exitCase });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/exits/:id/clearance/:key', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const { status, remarks } = req.body;
    if (!['pending', 'cleared', 'blocked', 'waived'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Clearance status must be pending, cleared, blocked or waived.' });
    }
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });
    if (['completed', 'rejected', 'withdrawn'].includes(exitCase.status)) {
      return res.status(409).json({ success: false, message: `Clearance cannot be changed on a ${exitCase.status} case.` });
    }

    const item = exitCase.clearance.find(entry => entry.key === req.params.key);
    if (!item) return res.status(404).json({ success: false, message: 'Clearance item not found on this case.' });

    item.status = status;
    item.remarks = String(remarks || '').trim();
    if (status === 'cleared' || status === 'waived') {
      item.clearedBy = req.user._id;
      item.clearedByName = req.user.name || '';
      item.clearedAt = new Date();
    } else {
      item.clearedBy = undefined;
      item.clearedByName = '';
      item.clearedAt = undefined;
    }
    if (exitCase.status === 'approved') exitCase.status = 'in_clearance';

    await exitCase.save();
    res.json({ success: true, message: 'Clearance updated.', data: exitCase });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Draft the settlement without saving, so HR can see the basis for every figure
// before committing to it.
router.get('/exits/:id/settlement-draft', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });

    const lastWorkingDay = exitCase.approvedLastWorkingDay || exitCase.requestedLastWorkingDay;
    if (!lastWorkingDay) {
      return res.status(409).json({ success: false, message: 'Approve a last working day before drafting the settlement.' });
    }
    const employee = await Employee.findById(exitCase.employee).lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Linked employee record is missing.' });

    const result = await computeSettlementDraft({
      employee,
      branchId: req.branchId,
      lastWorkingDay,
      noticeShortfallDays: exitCase.noticeShortfallDays,
    });
    res.json({ success: true, data: { ...result, lastWorkingDay } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Save the agreed settlement. Totals are always recomputed from the lines so a
// stored net can never disagree with its own components.
router.post('/exits/:id/settlement', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });
    if (['completed', 'rejected', 'withdrawn'].includes(exitCase.status)) {
      return res.status(409).json({ success: false, message: `A ${exitCase.status} case cannot be settled.` });
    }
    if (exitCase.status === 'pending_approval') {
      return res.status(409).json({ success: false, message: 'Approve the exit before recording a settlement.' });
    }

    const lineFields = [
      'perDayRate', 'payableDays', 'pendingSalary', 'leaveEncashmentDays', 'leaveEncashment',
      'pendingIncentive', 'gratuity', 'otherEarnings', 'loanOutstanding', 'advanceOutstanding',
      'noticeShortfallDeduction', 'unreturnedAssetValue', 'otherDeductions',
    ];
    const invalid = lineFields.filter(field => Object.prototype.hasOwnProperty.call(req.body, field)
      && (!Number.isFinite(Number(req.body[field])) || Number(req.body[field]) < 0));
    if (invalid.length) {
      return res.status(400).json({ success: false, message: `These amounts must be non-negative numbers: ${invalid.join(', ')}.` });
    }

    for (const field of lineFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        exitCase.settlement[field] = Number(req.body[field]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'perDayBasis')) {
      exitCase.settlement.perDayBasis = String(req.body.perDayBasis || '');
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'notes')) {
      exitCase.settlement.notes = String(req.body.notes || '').trim();
    }

    const totals = recalcSettlementTotals(exitCase.settlement);
    Object.assign(exitCase.settlement, totals);
    exitCase.settlement.computedAt = new Date();
    exitCase.settlement.computedBy = req.user._id;
    if (exitCase.settlement.paymentStatus === 'not_computed') exitCase.settlement.paymentStatus = 'computed';
    if (exitCase.status === 'in_clearance' || exitCase.status === 'approved') exitCase.status = 'settled';

    await exitCase.save();
    res.json({ success: true, message: 'Settlement saved.', data: exitCase });
  } catch (e) {
    if (e.name === 'ValidationError' || e.name === 'CastError') return res.status(400).json({ success: false, message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch('/exits/:id/settlement/status', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const { paymentStatus, paymentRef } = req.body;
    if (!['approved', 'paid'].includes(paymentStatus)) {
      return res.status(400).json({ success: false, message: 'Settlement status must be approved or paid.' });
    }
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });
    if (exitCase.settlement.paymentStatus === 'not_computed') {
      return res.status(409).json({ success: false, message: 'Compute and save the settlement first.' });
    }
    if (paymentStatus === 'paid' && exitCase.settlement.paymentStatus !== 'approved') {
      return res.status(409).json({ success: false, message: 'The settlement must be approved before it can be marked paid.' });
    }

    exitCase.settlement.paymentStatus = paymentStatus;
    if (paymentStatus === 'approved') {
      exitCase.settlement.approvedBy = req.user._id;
      exitCase.settlement.approvedAt = new Date();
    } else {
      exitCase.settlement.paidAt = new Date();
      exitCase.settlement.paymentRef = String(paymentRef || '').trim();
    }
    await exitCase.save();
    res.json({ success: true, message: `Settlement marked ${paymentStatus}.`, data: exitCase });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/exits/:id/exit-interview', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });

    const { date, wouldRehire, overallExperience, feedback, improvementSuggestions, reasonCategory } = req.body;
    const rating = overallExperience === undefined || overallExperience === null
      ? undefined
      : Number(overallExperience);
    if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ success: false, message: 'Overall experience must be a whole number from 1 to 5.' });
    }

    exitCase.exitInterview = {
      conducted: true,
      conductedBy: req.user._id,
      conductedByName: req.user.name || '',
      date: parseDay(date) || new Date(),
      wouldRehire: typeof wouldRehire === 'boolean' ? wouldRehire : exitCase.exitInterview?.wouldRehire,
      overallExperience: rating ?? exitCase.exitInterview?.overallExperience,
      feedback: String(feedback || '').trim(),
      improvementSuggestions: String(improvementSuggestions || '').trim(),
    };
    if (reasonCategory) exitCase.reasonCategory = reasonCategory;

    const item = exitCase.clearance.find(entry => entry.key === 'exit_interview');
    if (item && item.status === 'pending') {
      item.status = 'cleared';
      item.clearedBy = req.user._id;
      item.clearedByName = req.user.name || '';
      item.clearedAt = new Date();
    }

    await exitCase.save();
    res.json({ success: true, message: 'Exit interview recorded.', data: exitCase });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Final step. This is the only place that terminates the employee and revokes
// app access, and it refuses to run while anything is still outstanding.
router.post('/exits/:id/complete', ...exitAccess, async (req, res) => {
  try {
    if (!validExitId(req, res)) return;
    const exitCase = await loadExitCase(req.params.id, req.branchId);
    if (!exitCase) return res.status(404).json({ success: false, message: 'Exit case not found in the selected branch.' });
    if (exitCase.status === 'completed') {
      return res.status(409).json({ success: false, message: 'This exit is already completed.' });
    }
    if (!['in_clearance', 'settled', 'approved'].includes(exitCase.status)) {
      return res.status(409).json({ success: false, message: `A ${exitCase.status} case cannot be completed.` });
    }

    const blockers = [];
    const unresolved = exitCase.clearance.filter(item => item.status === 'pending' || item.status === 'blocked');
    if (unresolved.length) {
      blockers.push(`Clearance still open: ${unresolved.map(i => i.label).join(', ')}.`);
    }
    if (exitCase.settlement.paymentStatus === 'not_computed') {
      blockers.push('Full-and-final settlement has not been computed.');
    }

    const employee = await Employee.findById(exitCase.employee).lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Linked employee record is missing.' });
    const facts = await buildClearanceFacts({ employee, branchId: req.branchId });
    if (facts.assets.count > 0) {
      blockers.push(`${facts.assets.count} company asset(s) are still assigned to this employee.`);
    }

    // `force` exists because a real exit sometimes has to close over a known gap
    // (an absconding employee will never return the laptop). It demands a reason
    // so the override is on the record rather than invisible.
    const force = req.body.force === true;
    if (blockers.length && !force) {
      return res.status(409).json({
        success: false,
        message: 'Exit cannot be completed while items are outstanding.',
        data: { blockers, canForce: true },
      });
    }
    if (blockers.length && force && !String(req.body.forceReason || '').trim()) {
      return res.status(400).json({ success: false, message: 'Overriding outstanding items requires a reason.' });
    }

    const exitDate = exitCase.approvedLastWorkingDay || exitCase.requestedLastWorkingDay || new Date();
    const terminated = await exitEmployee({
      employeeId: exitCase.employee,
      input: { exitDate, exitReason: exitCase.reason },
      actor: req.user,
      selectedBranchId: req.branchId,
    });

    const closedLoans = await closeRecoveredLoans({
      branchId: req.branchId,
      employeeId: exitCase.employee,
      actorId: req.user._id,
    });

    exitCase.status = 'completed';
    exitCase.completedAt = new Date();
    exitCase.completedBy = req.user._id;
    exitCase.accessRevokedAt = new Date();
    if (blockers.length && force) {
      exitCase.settlement.notes = [
        exitCase.settlement.notes,
        `Force-completed by ${req.user.name || 'user'}: ${String(req.body.forceReason).trim()} (outstanding: ${blockers.join(' ')})`,
      ].filter(Boolean).join('\n');
    }
    await exitCase.save();

    res.json({
      success: true,
      message: `Exit completed. App access revoked${closedLoans ? ` and ${closedLoans} loan/advance closed` : ''}.`,
      data: { exit: exitCase, employee: terminated, forcedOver: force ? blockers : [] },
    });
  } catch (error) { return sendEmployeeError(res, error); }
});

// ═══════════════════════════════════════
// PERFORMANCE APPRAISAL
// ═══════════════════════════════════════
const performanceAccess = [requirePermission('performance.appraisal')];

const parsePeriod = (fromValue, toValue) => {
  const from = parseDay(fromValue);
  const to = parseDay(toValue);
  if (!from || !to) return { error: 'A valid period from and to date are required (YYYY-MM-DD).' };
  if (to < from) return { error: 'Period end cannot fall before period start.' };
  // The window is inclusive of the closing day, so it runs to that night.
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999);
  return { from, to: end };
};

router.get('/performance/components', ...performanceAccess, (req, res) => {
  res.json({ success: true, data: PERFORMANCE_COMPONENTS });
});

router.get('/performance/stats', ...performanceAccess, async (req, res) => {
  try {
    const base = { branch: req.branchId };
    const [total, drafts, submitted, acknowledged, pipOpen, promotions, avg] = await Promise.all([
      PerformanceReview.countDocuments(base),
      PerformanceReview.countDocuments({ ...base, status: 'draft' }),
      PerformanceReview.countDocuments({ ...base, status: 'submitted' }),
      PerformanceReview.countDocuments({ ...base, status: 'acknowledged' }),
      PerformanceReview.countDocuments({ ...base, 'performanceImprovementPlan.required': true, 'performanceImprovementPlan.outcome': 'open' }),
      PerformanceReview.countDocuments({ ...base, promotionRecommended: true }),
      PerformanceReview.aggregate([
        // Averaging in reviews that measured almost nothing would misrepresent the
        // branch, so the headline average only counts reasonably-grounded reviews.
        { $match: { ...base, status: { $ne: 'draft' }, measuredWeight: { $gte: 50 } } },
        { $group: { _id: null, avgScore: { $avg: '$totalScore' }, count: { $sum: 1 } } },
      ]),
    ]);
    res.json({
      success: true,
      data: {
        total, drafts, submitted, acknowledged, pipOpen, promotions,
        averageScore: Math.round((avg[0]?.avgScore || 0) * 100) / 100,
        averageScoreBasis: `Mean of ${avg[0]?.count || 0} submitted review(s) with at least 50 of 100 weight measured.`,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/performance', ...performanceAccess, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, employee, grade, search } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const clauses = [{ branch: req.branchId }];
    if (status) clauses.push({ status });
    if (grade) clauses.push({ grade });
    if (employee && mongoose.isValidObjectId(employee)) clauses.push({ employee });
    if (search) {
      const regex = new RegExp(escapeRegex(String(search)), 'i');
      clauses.push({ $or: [{ employeeName: regex }, { empId: regex }, { department: regex }, { periodLabel: regex }] });
    }
    const filter = { $and: clauses };
    const [data, total] = await Promise.all([
      PerformanceReview.find(filter).sort({ periodTo: -1, createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      PerformanceReview.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Preview the automatic score without saving, so a reviewer can see the basis and
// which components were excluded before committing to an appraisal.
router.get('/performance/preview', ...performanceAccess, async (req, res) => {
  try {
    const { employeeId, from, to, managerRating } = req.query;
    if (!mongoose.isValidObjectId(employeeId)) {
      return res.status(400).json({ success: false, message: 'A valid employeeId is required.' });
    }
    const period = parsePeriod(from, to);
    if (period.error) return res.status(400).json({ success: false, message: period.error });

    const employee = await Employee.findOne({ _id: employeeId, branchId: req.branchId }).lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found in the selected branch.' });

    const result = await computePerformance({
      employee,
      branchId: req.branchId,
      from: period.from,
      to: period.to,
      managerRating,
    });
    res.json({
      success: true,
      data: {
        ...result,
        employee: {
          _id: employee._id, name: employee.name, empId: employee.empId,
          designation: employee.designation, department: employee.department,
          hasAppAccount: !!employee.userId,
        },
        periodFrom: period.from,
        periodTo: period.to,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/performance/:id', ...performanceAccess, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Review identifier is invalid.' });
    }
    const review = await PerformanceReview.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!review) return res.status(404).json({ success: false, message: 'Review not found in the selected branch.' });
    res.json({ success: true, data: review });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// The automatic components are always recomputed here; the client's numbers are
// never trusted, only its judgement fields.
router.post('/performance', ...performanceAccess, async (req, res) => {
  try {
    const {
      employeeId, from, to, periodLabel, managerRating, strengths, improvements,
      managerRemarks, pipRequired, pipObjectives, pipReviewDate,
      promotionRecommended, promotionRemarks, incrementRecommended, submit,
    } = req.body;

    if (!mongoose.isValidObjectId(employeeId)) {
      return res.status(400).json({ success: false, message: 'A valid employee must be selected.' });
    }
    const period = parsePeriod(from, to);
    if (period.error) return res.status(400).json({ success: false, message: period.error });

    const rating = managerRating === undefined || managerRating === null || managerRating === ''
      ? undefined
      : Number(managerRating);
    if (rating !== undefined && (!Number.isFinite(rating) || rating < 1 || rating > 10)) {
      return res.status(400).json({ success: false, message: 'Manager rating must be a number from 1 to 10.' });
    }
    // Submitting without a rating would bake the manager's silence into the score.
    if (submit === true && rating === undefined) {
      return res.status(400).json({ success: false, message: 'A manager rating is required before a review can be submitted.' });
    }
    const increment = incrementRecommended === undefined ? 0 : Number(incrementRecommended);
    if (!Number.isFinite(increment) || increment < 0 || increment > 100) {
      return res.status(400).json({ success: false, message: 'Increment recommendation must be a percentage between 0 and 100.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, branchId: req.branchId }).lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found in the selected branch.' });

    const duplicate = await PerformanceReview.findOne({
      branch: req.branchId, employee: employeeId,
      periodFrom: period.from, periodTo: period.to,
    }).select('_id status').lean();
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'A review already exists for this employee and period. Edit that review instead.',
        data: { reviewId: duplicate._id },
      });
    }

    const computed = await computePerformance({
      employee, branchId: req.branchId, from: period.from, to: period.to, managerRating: rating,
    });

    const review = await PerformanceReview.create({
      branch: req.branchId,
      employee: employee._id,
      employeeName: employee.name,
      empId: employee.empId || '',
      designation: employee.designation || '',
      department: employee.department || '',
      periodFrom: period.from,
      periodTo: period.to,
      periodLabel: String(periodLabel || '').trim(),
      components: computed.components,
      managerRating: rating,
      strengths: String(strengths || '').trim(),
      improvements: String(improvements || '').trim(),
      managerRemarks: String(managerRemarks || '').trim(),
      totalScore: computed.totalScore,
      grade: computed.grade,
      measuredWeight: computed.measuredWeight,
      excludedComponents: computed.excludedComponents,
      performanceImprovementPlan: {
        required: pipRequired === true,
        objectives: String(pipObjectives || '').trim(),
        reviewDate: parseDay(pipReviewDate) || undefined,
        outcome: 'open',
      },
      promotionRecommended: promotionRecommended === true,
      promotionRemarks: String(promotionRemarks || '').trim(),
      incrementRecommended: increment,
      status: submit === true ? 'submitted' : 'draft',
      submittedAt: submit === true ? new Date() : undefined,
      reviewedBy: req.user._id,
      reviewedByName: req.user.name || '',
      computedAt: new Date(),
      warnings: computed.warnings,
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      message: submit === true ? 'Appraisal submitted.' : 'Appraisal saved as draft.',
      data: review,
      meta: { suggestions: computed.suggestions },
    });
  } catch (e) {
    if (e.name === 'ValidationError' || e.name === 'CastError') return res.status(400).json({ success: false, message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

// Editing a draft recomputes the automatic half, because the underlying data may
// have moved since the draft was first taken.
router.put('/performance/:id', ...performanceAccess, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Review identifier is invalid.' });
    }
    const review = await PerformanceReview.findOne({ _id: req.params.id, branch: req.branchId });
    if (!review) return res.status(404).json({ success: false, message: 'Review not found in the selected branch.' });
    if (review.status === 'acknowledged') {
      return res.status(409).json({ success: false, message: 'An acknowledged review is a signed record and cannot be edited.' });
    }

    const {
      managerRating, strengths, improvements, managerRemarks,
      pipRequired, pipObjectives, pipReviewDate, pipOutcome,
      promotionRecommended, promotionRemarks, incrementRecommended, submit,
    } = req.body;

    const rating = managerRating === undefined || managerRating === null || managerRating === ''
      ? review.managerRating
      : Number(managerRating);
    if (rating !== undefined && (!Number.isFinite(rating) || rating < 1 || rating > 10)) {
      return res.status(400).json({ success: false, message: 'Manager rating must be a number from 1 to 10.' });
    }
    if (submit === true && rating === undefined) {
      return res.status(400).json({ success: false, message: 'A manager rating is required before a review can be submitted.' });
    }

    const employee = await Employee.findOne({ _id: review.employee, branchId: req.branchId }).lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Linked employee record is missing.' });

    const computed = await computePerformance({
      employee, branchId: req.branchId,
      from: review.periodFrom, to: review.periodTo, managerRating: rating,
    });

    review.components = computed.components;
    review.totalScore = computed.totalScore;
    review.grade = computed.grade;
    review.measuredWeight = computed.measuredWeight;
    review.excludedComponents = computed.excludedComponents;
    review.warnings = computed.warnings;
    review.computedAt = new Date();
    review.managerRating = rating;
    if (strengths !== undefined)      review.strengths = String(strengths || '').trim();
    if (improvements !== undefined)   review.improvements = String(improvements || '').trim();
    if (managerRemarks !== undefined) review.managerRemarks = String(managerRemarks || '').trim();
    if (pipRequired !== undefined)    review.performanceImprovementPlan.required = pipRequired === true;
    if (pipObjectives !== undefined)  review.performanceImprovementPlan.objectives = String(pipObjectives || '').trim();
    if (pipReviewDate !== undefined)  review.performanceImprovementPlan.reviewDate = parseDay(pipReviewDate) || undefined;
    if (pipOutcome !== undefined) {
      if (!['open', 'met', 'not_met', 'withdrawn'].includes(pipOutcome)) {
        return res.status(400).json({ success: false, message: 'PIP outcome must be open, met, not_met or withdrawn.' });
      }
      review.performanceImprovementPlan.outcome = pipOutcome;
      if (pipOutcome !== 'open') review.performanceImprovementPlan.closedAt = new Date();
    }
    if (promotionRecommended !== undefined) review.promotionRecommended = promotionRecommended === true;
    if (promotionRemarks !== undefined)     review.promotionRemarks = String(promotionRemarks || '').trim();
    if (incrementRecommended !== undefined) {
      const increment = Number(incrementRecommended);
      if (!Number.isFinite(increment) || increment < 0 || increment > 100) {
        return res.status(400).json({ success: false, message: 'Increment recommendation must be a percentage between 0 and 100.' });
      }
      review.incrementRecommended = increment;
    }
    if (submit === true && review.status === 'draft') {
      review.status = 'submitted';
      review.submittedAt = new Date();
    }
    review.reviewedBy = req.user._id;
    review.reviewedByName = req.user.name || '';

    await review.save();
    res.json({
      success: true,
      message: review.status === 'submitted' ? 'Appraisal submitted.' : 'Appraisal updated.',
      data: review,
      meta: { suggestions: computed.suggestions },
    });
  } catch (e) {
    if (e.name === 'ValidationError' || e.name === 'CastError') return res.status(400).json({ success: false, message: e.message });
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch('/performance/:id/acknowledge', ...performanceAccess, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Review identifier is invalid.' });
    }
    const review = await PerformanceReview.findOne({ _id: req.params.id, branch: req.branchId });
    if (!review) return res.status(404).json({ success: false, message: 'Review not found in the selected branch.' });
    if (review.status !== 'submitted') {
      return res.status(409).json({ success: false, message: `Only a submitted review can be acknowledged (this one is ${review.status}).` });
    }
    review.status = 'acknowledged';
    review.acknowledgedAt = new Date();
    review.acknowledgementRemarks = String(req.body.remarks || '').trim();
    await review.save();
    res.json({ success: true, message: 'Appraisal acknowledged.', data: review });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
