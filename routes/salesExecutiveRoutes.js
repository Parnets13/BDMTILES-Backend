import { Router } from 'express';
import mongoose from 'mongoose';
import Dealer from '../models/Dealer.js';
import DealerLedger from '../models/DealerLedger.js';
import SalesOrder from '../models/SalesOrder.js';
import Quotation from '../models/Quotation.js';
import Complaint from '../models/Complaint.js';
import Route from '../models/Route.js';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import HrmsSettings from '../models/HrmsSettings.js';
import Expense from '../models/Expense.js';
import Incentive from '../models/Incentive.js';
import Payment from '../models/Payment.js';
import Invoice from '../models/Invoice.js';
import DealerVisit from '../models/DealerVisit.js';
import DealerMessage from '../models/DealerMessage.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { getDealerCreditExposure } from '../services/dealerCreditService.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

// Open (non-terminal) statuses used for "pending"/in-flight counts.
const OPEN_ORDER_STATUSES = ['confirmed', 'approved', 'processing', 'partial_dispatch', 'dispatched'];
const OPEN_QUOTATION_STATUSES = ['draft', 'pending_approval', 'approved', 'sent'];
const TERMINAL_COMPLAINT_STATUSES = ['resolved', 'closed', 'rejected', 'return_reversed'];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Dealers assigned to the signed-in executive (Dealer is global; scope by owner).
async function myDealerIds(userId) {
  const dealers = await Dealer.find({ assignedSalesExecutive: userId }).select('_id').lean();
  return dealers.map((dealer) => dealer._id);
}

async function ledgerOutstanding(branchId, dealerId) {
  const [row] = await DealerLedger.aggregate([
    { $match: { branch: branchId, dealer: dealerId } },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  return round2((row?.debit || 0) - (row?.credit || 0));
}

router.get('/me/dealers', requirePermission('se.dealer.insights'), async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { assignedSalesExecutive: req.user._id };
    if (search && String(search).trim()) {
      const term = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(term, 'i');
      filter.$or = [{ businessName: regex }, { dealerCode: regex }, { mobile: regex }, { ownerName: regex }];
    }
    const [dealers, total] = await Promise.all([
      Dealer.find(filter).sort({ businessName: 1 }).skip((p - 1) * l).limit(l)
        .select('businessName dealerCode ownerName mobile city creditLimit creditDays currentOutstanding status dealerType lastPurchaseDate lastPaymentDate')
        .populate('dealerType', 'name pricingTier').lean(),
      Dealer.countDocuments(filter),
    ]);

    const dealerIds = dealers.map((dealer) => dealer._id);
    const outstandingRows = dealerIds.length ? await DealerLedger.aggregate([
      { $match: { branch: req.branchId, dealer: { $in: dealerIds } } },
      { $group: { _id: '$dealer', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]) : [];
    const outstandingByDealer = new Map(
      outstandingRows.map((row) => [String(row._id), round2((row.debit || 0) - (row.credit || 0))]),
    );

    const data = dealers.map((dealer) => ({
      ...dealer,
      branchOutstanding: outstandingByDealer.get(String(dealer._id)) ?? 0,
    }));
    return res.json({
      success: true,
      data,
      pagination: {
        currentPage: p,
        totalPages: Math.ceil(total / l),
        totalItems: total,
        itemsPerPage: l,
        hasMore: p * l < total,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/dealers/:id/insights', requirePermission('se.dealer.insights'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(422).json({ success: false, message: 'Invalid dealer id.' });
    }
    const dealer = await Dealer.findOne({ _id: req.params.id, assignedSalesExecutive: req.user._id })
      .populate('dealerType', 'name pricingTier')
      .populate('assignedRegion', 'name')
      .populate('assignedRoute', 'name')
      .lean();
    if (!dealer) {
      return res.status(404).json({ success: false, message: 'Dealer not found or not assigned to you.' });
    }

    const [outstanding, exposure, pendingOrders, openQuotations, openComplaints] = await Promise.all([
      ledgerOutstanding(req.branchId, dealer._id),
      getDealerCreditExposure({ branchId: req.branchId, dealer }),
      SalesOrder.countDocuments({ branch: req.branchId, dealer: dealer._id, status: { $in: OPEN_ORDER_STATUSES } }),
      Quotation.countDocuments({ branch: req.branchId, dealer: dealer._id, createdBy: req.user._id, status: { $in: OPEN_QUOTATION_STATUSES } }),
      Complaint.countDocuments({ branch: req.branchId, dealer: dealer._id, status: { $nin: TERMINAL_COMPLAINT_STATUSES } }),
    ]);

    const creditLimit = Number(dealer.creditLimit || 0);
    const availableCredit = round2(creditLimit - outstanding);

    return res.json({
      success: true,
      data: {
        dealer: {
          _id: dealer._id,
          businessName: dealer.businessName,
          dealerCode: dealer.dealerCode,
          ownerName: dealer.ownerName,
          mobile: dealer.mobile,
          city: dealer.city,
          status: dealer.status,
          dealerType: dealer.dealerType,
          region: dealer.assignedRegion,
          route: dealer.assignedRoute,
          lastPurchaseDate: dealer.lastPurchaseDate,
          lastPaymentDate: dealer.lastPaymentDate,
        },
        credit: {
          creditLimit,
          creditDays: Number(dealer.creditDays || 0),
          outstanding,
          availableCredit,
          overCreditLimit: creditLimit > 0 && outstanding > creditLimit,
          overdueAmount: round2(exposure?.overdueAmount || 0),
          overdueCount: exposure?.overdueCount || 0,
          creditDaysValid: exposure?.creditDaysValid ?? false,
        },
        activity: {
          pendingOrders,
          openQuotations,
          openComplaints,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get(
  '/me/dashboard',
  requireAnyPermission('sales.executive.app', 'dashboard.view'),
  async (req, res) => {
  try {
    const dealerIds = await myDealerIds(req.user._id);
    const [dealerCount, outstandingRows, pendingOrders, openQuotations, openComplaints] = await Promise.all([
      Promise.resolve(dealerIds.length),
      dealerIds.length ? DealerLedger.aggregate([
        { $match: { branch: req.branchId, dealer: { $in: dealerIds } } },
        { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ]) : [],
      SalesOrder.countDocuments({ branch: req.branchId, salesExecutive: req.user._id, status: { $in: OPEN_ORDER_STATUSES } }),
      dealerIds.length ? Quotation.countDocuments({ branch: req.branchId, dealer: { $in: dealerIds }, createdBy: req.user._id, status: { $in: OPEN_QUOTATION_STATUSES } }) : 0,
      dealerIds.length ? Complaint.countDocuments({ branch: req.branchId, dealer: { $in: dealerIds }, status: { $nin: TERMINAL_COMPLAINT_STATUSES } }) : 0,
    ]);
    const totalOutstanding = round2((outstandingRows[0]?.debit || 0) - (outstandingRows[0]?.credit || 0));

    return res.json({
      success: true,
      data: {
        dealerCount,
        totalOutstanding,
        pendingOrders,
        openQuotations,
        openComplaints,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/target-progress', requirePermission('se.targets.view'), async (req, res) => {
  try {
    const now = new Date();
    const rules = await Incentive.find({
      branch: req.branchId,
      applicableTo: 'sales_executive',
      incentiveType: 'target',
      triggerEvent: { $in: ['monthly_sales', 'quarterly_sales', 'annual_sales'] },
      status: 'active',
      targetValue: { $gt: 0 },
      validFrom: { $lte: now },
      validTo: { $gte: now },
      $or: [
        { specificUsers: req.user._id },
        { specificUsers: { $size: 0 } },
        { specificUsers: { $exists: false } },
      ],
    }).sort({ validTo: 1, createdAt: -1 }).lean();

    const targets = await Promise.all(rules.map(async (rule) => {
      const [totals] = await SalesOrder.aggregate([
        {
          $match: {
            branch: req.branchId,
            salesExecutive: req.user._id,
            orderDate: { $gte: rule.validFrom, $lte: rule.validTo },
            status: { $nin: ['draft', 'cancelled'] },
          },
        },
        { $group: { _id: null, achievedAmount: { $sum: '$grandTotal' } } },
      ]);
      const targetAmount = round2(rule.targetValue);
      const achievedAmount = round2(totals?.achievedAmount || 0);
      return {
        incentiveId: rule._id,
        incentiveName: rule.incentiveName,
        triggerEvent: rule.triggerEvent,
        period: rule.period,
        periodStart: rule.validFrom,
        periodEnd: rule.validTo,
        targetAmount,
        achievedAmount,
        remainingAmount: round2(Math.max(0, targetAmount - achievedAmount)),
        progressPercent: targetAmount > 0
          ? round2((achievedAmount / targetAmount) * 100)
          : 0,
        isAchieved: achievedAmount >= targetAmount,
      };
    }));

    return res.json({ success: true, data: { targets } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/routes', requirePermission('se.route.plan'), async (req, res) => {
  try {
    const routes = await Route.find({ assignedSE: req.user._id, status: 'active' })
      .sort({ name: 1 })
      .populate('region', 'name')
      .select('name description region citiesCovered visitFrequency dayOfWeek status')
      .lean();
    const routeIds = routes.map((route) => route._id);
    const dealerCounts = routeIds.length ? await Dealer.aggregate([
      { $match: { assignedRoute: { $in: routeIds }, assignedSalesExecutive: req.user._id } },
      { $group: { _id: '$assignedRoute', count: { $sum: 1 } } },
    ]) : [];
    const countByRoute = new Map(dealerCounts.map((row) => [String(row._id), row.count]));
    const data = routes.map((route) => ({ ...route, dealerCount: countByRoute.get(String(route._id)) || 0 }));
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Self-service GPS attendance (SOW 18.1)
// ---------------------------------------------------------------------------

// Business timezone offset in minutes east of UTC (IST = +330). Configurable so
// attendance day-bucketing and lateness stay correct regardless of server TZ.
const BUSINESS_TZ_OFFSET_MINUTES = (() => {
  const parsed = Number.parseInt(process.env.BUSINESS_TZ_OFFSET_MINUTES, 10);
  return Number.isFinite(parsed) ? parsed : 330;
})();
const TZ_MS = BUSINESS_TZ_OFFSET_MINUTES * 60 * 1000;

// Midnight of "today" in the business timezone, expressed as a UTC Date so the
// stored attendance `date` key is stable no matter where the server runs.
const startOfToday = () => {
  const now = Date.now();
  const local = new Date(now + TZ_MS);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(localMidnight - TZ_MS);
};

// Resolve the Employee profile linked to the signed-in user, scoped to branch.
async function resolveEmployee(req) {
  const employee = await Employee.findOne({ userId: req.user._id, branchId: req.branchId })
    .select('_id name empId branchId department')
    .lean();
  return employee;
}

// Sanitize an incoming {lat,lng,accuracy} payload into stored numbers.
function normalizeLocation(location) {
  if (!location || typeof location !== 'object') return undefined;
  const lat = Number(location.lat ?? location.latitude);
  const lng = Number(location.lng ?? location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const accuracy = Number(location.accuracy);
  return { lat, lng, ...(Number.isFinite(accuracy) ? { accuracy } : {}) };
}

// Minutes a punch-in time is past (shiftStart + grace) in the business timezone,
// using branch HRMS settings. shiftStart is a wall-clock "HH:MM" with no TZ, so
// it is anchored to the business offset rather than the server's local clock.
function computeLateMinutes(punchInAt, settings) {
  const shiftStart = String(settings?.defaultShiftStart || '09:00');
  const grace = Number(settings?.graceMinutes ?? 15);
  const match = /^(\d{1,2}):(\d{2})$/.exec(shiftStart);
  if (!match) return 0;
  const local = new Date(punchInAt.getTime() + TZ_MS);
  const thresholdLocalMs = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    Number(match[1]), Number(match[2]), 0, 0,
  ) + (Number.isFinite(grace) ? grace : 0) * 60000;
  const thresholdUtcMs = thresholdLocalMs - TZ_MS;
  const diffMinutes = Math.floor((punchInAt.getTime() - thresholdUtcMs) / 60000);
  return diffMinutes > 0 ? diffMinutes : 0;
}

const attendanceView = (record) => ({
  _id: record._id,
  date: record.date,
  status: record.status,
  punchIn: record.punchIn || null,
  punchOut: record.punchOut || null,
  punchInLocation: record.punchInLocation || null,
  punchOutLocation: record.punchOutLocation || null,
  punchInSelfie: record.punchInSelfie || null,
  punchOutSelfie: record.punchOutSelfie || null,
  totalHours: record.totalHours || 0,
  lateMinutes: record.lateMinutes || 0,
  lateReason: record.lateReason || '',
  source: record.source,
});

router.get('/me/attendance/today', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const employee = await resolveEmployee(req);
    if (!employee) return res.status(404).json({ success: false, message: 'No employee profile is linked to your account.' });
    const settings = await HrmsSettings.findOne({ branch: req.branchId }).select('defaultShiftStart graceMinutes').lean();
    const record = await Attendance.findOne({ branch: req.branchId, employee: employee._id, date: startOfToday() }).lean();
    return res.json({
      success: true,
      data: {
        employee: { _id: employee._id, name: employee.name, empId: employee.empId },
        shiftStart: settings?.defaultShiftStart || '09:00',
        attendance: record ? attendanceView(record) : null,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/attendance/history', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const employee = await resolveEmployee(req);
    if (!employee) return res.status(404).json({ success: false, message: 'No employee profile is linked to your account.' });
    const limit = Math.min(60, Math.max(1, Number.parseInt(req.query.limit, 10) || 30));
    const records = await Attendance.find({ branch: req.branchId, employee: employee._id })
      .sort({ date: -1 }).limit(limit).lean();
    return res.json({ success: true, data: records.map(attendanceView) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/me/attendance/punch-in', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const employee = await resolveEmployee(req);
    if (!employee) return res.status(404).json({ success: false, message: 'No employee profile is linked to your account.' });

    const location = normalizeLocation(req.body?.location);
    if (!location) return res.status(422).json({ success: false, message: 'A valid GPS location (lat, lng) is required to punch in.' });
    const selfie = typeof req.body?.selfie === 'string' ? req.body.selfie : '';
    const lateReason = String(req.body?.lateReason || '').trim();

    const today = startOfToday();
    let record = await Attendance.findOne({ branch: req.branchId, employee: employee._id, date: today });
    if (record && record.punchIn) {
      return res.status(409).json({ success: false, message: 'You have already punched in today.' });
    }

    const settings = await HrmsSettings.findOne({ branch: req.branchId }).select('defaultShiftStart graceMinutes').lean();
    const punchInAt = new Date();
    const lateMinutes = computeLateMinutes(punchInAt, settings);
    if (lateMinutes > 0 && !lateReason) {
      return res.status(422).json({ success: false, message: 'You are past the grace period. A late-entry reason is required.', code: 'LATE_REASON_REQUIRED', lateMinutes });
    }

    if (!record) record = new Attendance({ branch: req.branchId, employee: employee._id, date: today });
    record.punchIn = punchInAt;
    record.punchInLocation = location;
    if (selfie) record.punchInSelfie = selfie;
    record.lateMinutes = lateMinutes;
    record.lateReason = lateMinutes > 0 ? lateReason : '';
    record.status = lateMinutes > 0 ? 'Late' : 'Present';
    record.source = 'App';
    await record.save();
    return res.json({ success: true, message: lateMinutes > 0 ? `Punched in (${lateMinutes} min late).` : 'Punched in.', data: attendanceView(record.toObject()) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Attendance already recorded for today.' });
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

router.post('/me/attendance/punch-out', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const employee = await resolveEmployee(req);
    if (!employee) return res.status(404).json({ success: false, message: 'No employee profile is linked to your account.' });

    const location = normalizeLocation(req.body?.location);
    if (!location) return res.status(422).json({ success: false, message: 'A valid GPS location (lat, lng) is required to punch out.' });
    const selfie = typeof req.body?.selfie === 'string' ? req.body.selfie : '';

    const record = await Attendance.findOne({ branch: req.branchId, employee: employee._id, date: startOfToday() });
    if (!record || !record.punchIn) return res.status(409).json({ success: false, message: 'You have not punched in today.' });
    if (record.punchOut) return res.status(409).json({ success: false, message: 'You have already punched out today.' });

    record.punchOut = new Date();
    record.punchOutLocation = location;
    if (selfie) record.punchOutSelfie = selfie;
    const hours = (record.punchOut.getTime() - new Date(record.punchIn).getTime()) / 3600000;
    record.totalHours = Math.round(hours * 100) / 100;
    await record.save();
    return res.json({ success: true, message: 'Punched out.', data: attendanceView(record.toObject()) });
  } catch (error) {
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Self-service expense claims (SOW 18.8)
// ---------------------------------------------------------------------------

const EXPENSE_CATEGORIES = new Set([
  'travel', 'fuel', 'phone', 'lodging', 'food', 'office', 'loading', 'unloading',
  'vehicle_repair', 'warehouse', 'marketing', 'staff_welfare', 'courier', 'miscellaneous',
]);
const EXPENSE_STATUSES = new Set(['pending', 'approved', 'rejected', 'reimbursed', 'cancelled']);

const expenseView = (expense) => ({
  _id: expense._id,
  expenseNumber: expense.expenseNumber,
  category: expense.category,
  amount: expense.amount,
  expenseDate: expense.expenseDate,
  description: expense.description,
  dealerRef: expense.dealerRef || '',
  tripRef: expense.tripRef || '',
  billUpload: expense.billUpload || [],
  photoUpload: expense.photoUpload || [],
  gpsLocation: expense.gpsLocation || null,
  status: expense.status,
  rejectionReason: expense.rejectionReason || '',
  reimbursementDate: expense.reimbursementDate || null,
  createdAt: expense.createdAt,
});

router.get('/me/expenses', requirePermission('sales.executive.app'), async (req, res) => {
  try {
    const employee = await resolveEmployee(req);
    if (!employee) return res.status(404).json({ success: false, message: 'No employee profile is linked to your account.' });

    const { status, category, page = 1, limit = 20 } = req.query;
    if (status && !EXPENSE_STATUSES.has(String(status))) {
      return res.status(422).json({ success: false, message: 'Invalid status filter.' });
    }
    if (category && !EXPENSE_CATEGORIES.has(String(category))) {
      return res.status(422).json({ success: false, message: 'Invalid category filter.' });
    }
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { branch: req.branchId, employee: employee._id };
    if (status) filter.status = status;
    if (category) filter.category = category;

    const [rows, total] = await Promise.all([
      Expense.find(filter).sort({ expenseDate: -1, createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Expense.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: rows.map(expenseView),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l, hasMore: p * l < total },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/expenses/stats', requirePermission('sales.executive.app'), async (req, res) => {
  try {
    const employee = await resolveEmployee(req);
    if (!employee) return res.status(404).json({ success: false, message: 'No employee profile is linked to your account.' });
    const match = { branch: req.branchId, employee: employee._id };
    const [rows] = await Promise.all([
      Expense.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]),
    ]);
    const summary = { pending: 0, approved: 0, rejected: 0, reimbursed: 0, cancelled: 0, pendingAmount: 0, reimbursedAmount: 0 };
    for (const row of rows) {
      if (row._id in summary) summary[row._id] = row.count;
      if (row._id === 'pending') summary.pendingAmount = round2(row.amount);
      if (row._id === 'reimbursed') summary.reimbursedAmount = round2(row.amount);
    }
    return res.json({ success: true, data: summary });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/me/expenses', requirePermission('sales.executive.app'), async (req, res) => {
  try {
    const employee = await resolveEmployee(req);
    if (!employee) return res.status(404).json({ success: false, message: 'No employee profile is linked to your account.' });

    const category = String(req.body?.category || '').trim();
    if (!EXPENSE_CATEGORIES.has(category)) {
      return res.status(422).json({ success: false, message: 'A valid expense category is required.' });
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(422).json({ success: false, message: 'Amount must be greater than zero.' });
    }
    const description = String(req.body?.description || '').trim();
    if (!description) {
      return res.status(422).json({ success: false, message: 'A description is required.' });
    }
    const expenseDate = req.body?.expenseDate ? new Date(req.body.expenseDate) : new Date();
    if (Number.isNaN(expenseDate.getTime())) {
      return res.status(422).json({ success: false, message: 'expenseDate is invalid.' });
    }
    // Reject future-dated claims (allow a day of timezone slack).
    if (expenseDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      return res.status(422).json({ success: false, message: 'expenseDate cannot be in the future.' });
    }

    const location = normalizeLocation(req.body?.gpsLocation);
    const billUpload = Array.isArray(req.body?.billUpload) ? req.body.billUpload.filter((s) => typeof s === 'string') : [];
    const photoUpload = Array.isArray(req.body?.photoUpload) ? req.body.photoUpload.filter((s) => typeof s === 'string') : [];

    const expense = await Expense.create({
      branch: req.branchId,
      employee: employee._id,
      employeeName: employee.name,
      department: employee.department,
      category,
      amount: round2(amount),
      expenseDate,
      description,
      dealerRef: String(req.body?.dealerRef || '').trim(),
      tripRef: String(req.body?.tripRef || '').trim(),
      billUpload,
      photoUpload,
      ...(location ? { gpsLocation: { lat: location.lat, lng: location.lng } } : {}),
      status: 'pending',
      createdBy: req.user._id,
      expenseNumber: await generateBranchNumber(req.branchId, 'expense', expenseDate),
    });
    return res.status(201).json({ success: true, message: `Expense ${expense.expenseNumber} submitted.`, data: expenseView(expense.toObject()) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Duplicate expense number, please retry.' });
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Self-service collections (SOW 18.6)
//
// A field collection is recorded as a PENDING, unallocated dealer receipt with
// NO accounting side effects. Posting to the ledger / dealer outstanding happens
// only when a finance user confirms it through the existing payments module
// (applyPaymentEffects, gated on the 'payment' permission). This route never
// calls applyPaymentEffects and always forces status:'pending'.
// ---------------------------------------------------------------------------

const COLLECTION_MODES = new Set(['cash', 'cheque', 'upi', 'neft', 'rtgs']);

const collectionView = (payment) => ({
  _id: payment._id,
  paymentNumber: payment.paymentNumber,
  paymentDate: payment.paymentDate,
  dealer: payment.dealer,
  partyName: payment.partyName || '',
  amount: payment.amount,
  paymentMode: payment.paymentMode,
  status: payment.status,
  bankName: payment.bankName || '',
  chequeNumber: payment.chequeNumber || '',
  chequeDate: payment.chequeDate || null,
  transactionRef: payment.transactionRef || '',
  collectionLocation: payment.collectionLocation || null,
  receiptImage: payment.receiptImage || '',
  remarks: payment.remarks || '',
  createdAt: payment.createdAt,
});

// Confirm the dealer belongs to the signed-in executive (Dealer is global).
async function assertMyDealer(userId, dealerId) {
  if (!mongoose.isValidObjectId(dealerId)) return null;
  return Dealer.findOne({ _id: dealerId, assignedSalesExecutive: userId })
    .select('_id businessName dealerCode mobile creditLimit currentOutstanding').lean();
}

router.get('/me/collections', requirePermission('se.collections.view'), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { branch: req.branchId, isFieldCollection: true, collectedBy: req.user._id };
    if (status && ['pending', 'confirmed', 'bounced', 'cancelled'].includes(String(status))) filter.status = status;

    const [rows, total] = await Promise.all([
      Payment.find(filter).sort({ paymentDate: -1, createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode').lean(),
      Payment.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: rows.map(collectionView),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l, hasMore: p * l < total },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/collections/stats', requirePermission('se.collections.view'), async (req, res) => {
  try {
    const rows = await Payment.aggregate([
      { $match: { branch: req.branchId, isFieldCollection: true, collectedBy: req.user._id } },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);
    const summary = { pending: 0, confirmed: 0, bounced: 0, cancelled: 0, pendingAmount: 0, confirmedAmount: 0 };
    for (const row of rows) {
      if (row._id in summary) summary[row._id] = row.count;
      if (row._id === 'pending') summary.pendingAmount = round2(row.amount);
      if (row._id === 'confirmed') summary.confirmedAmount = round2(row.amount);
    }
    return res.json({ success: true, data: summary });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/dealers/:id/outstanding', requirePermission('se.collections.view'), async (req, res) => {
  try {
    const dealer = await assertMyDealer(req.user._id, req.params.id);
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found or not assigned to you.' });
    const invoices = await Invoice.find({
      branch: req.branchId,
      dealer: dealer._id,
      status: { $ne: 'cancelled' },
      paymentStatus: { $in: ['pending', 'partial'] },
      balanceAmount: { $gt: 0 },
    }).select('invoiceNumber invoiceDate orderNumber grandTotal paidAmount balanceAmount paymentStatus')
      .sort({ invoiceDate: 1, createdAt: 1 }).lean();
    const totalOutstanding = round2(invoices.reduce((sum, inv) => sum + Number(inv.balanceAmount || 0), 0));
    return res.json({
      success: true,
      data: {
        dealer: { _id: dealer._id, businessName: dealer.businessName, dealerCode: dealer.dealerCode },
        totalOutstanding,
        invoices,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/me/collections', requirePermission('se.collections.view'), async (req, res) => {
  // Optional idempotency: a retried request with the same key returns the
  // already-created collection instead of creating a duplicate.
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim().slice(0, 200);
  const sourceKey = idempotencyKey ? `${String(req.branchId)}:se-collection:${idempotencyKey}` : undefined;
  try {
    const dealer = await assertMyDealer(req.user._id, req.body?.dealer);
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found or not assigned to you.' });

    if (sourceKey) {
      const existing = await Payment.findOne({ branch: req.branchId, sourceKey }).lean();
      if (existing) return res.json({ success: true, message: 'Collection already recorded.', data: collectionView(existing) });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(422).json({ success: false, message: 'Amount must be greater than zero.' });
    }
    const paymentMode = String(req.body?.paymentMode || '').trim();
    if (!COLLECTION_MODES.has(paymentMode)) {
      return res.status(422).json({ success: false, message: 'A valid payment mode is required (cash, cheque, upi, neft, rtgs).' });
    }
    if (paymentMode === 'cheque' && !String(req.body?.chequeNumber || '').trim()) {
      return res.status(422).json({ success: false, message: 'Cheque number is required for cheque collections.' });
    }
    if (['upi', 'neft', 'rtgs'].includes(paymentMode) && !String(req.body?.transactionRef || '').trim()) {
      return res.status(422).json({ success: false, message: 'A transaction reference is required for online transfers.' });
    }

    const paymentDate = req.body?.paymentDate ? new Date(req.body.paymentDate) : new Date();
    if (Number.isNaN(paymentDate.getTime()) || paymentDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      return res.status(422).json({ success: false, message: 'paymentDate is invalid or in the future.' });
    }
    const location = normalizeLocation(req.body?.collectionLocation);
    const receiptImage = typeof req.body?.receiptImage === 'string' ? req.body.receiptImage : '';

    // Always pending + unallocated + accounting-inert. No applyPaymentEffects.
    const payment = await Payment.create({
      branch: req.branchId,
      paymentType: 'dealer_receipt',
      paymentDate,
      dealer: dealer._id,
      partyName: dealer.businessName,
      amount: round2(amount),
      paymentMode,
      bankName: String(req.body?.bankName || '').trim(),
      chequeNumber: paymentMode === 'cheque' ? String(req.body?.chequeNumber || '').trim() : undefined,
      chequeDate: paymentMode === 'cheque' && req.body?.chequeDate ? new Date(req.body.chequeDate) : undefined,
      transactionRef: ['upi', 'neft', 'rtgs'].includes(paymentMode) ? String(req.body?.transactionRef || '').trim() : undefined,
      remarks: String(req.body?.remarks || '').trim(),
      isFieldCollection: true,
      collectedBy: req.user._id,
      ...(location ? { collectionLocation: { lat: location.lat, lng: location.lng } } : {}),
      ...(sourceKey ? { sourceKey } : {}),
      receiptImage,
      status: 'pending',
      confirmedAt: null,
      tallySyncStatus: 'not_synced',
      createdBy: req.user._id,
      paymentNumber: await generateBranchNumber(req.branchId, 'payment', paymentDate),
    });
    return res.status(201).json({
      success: true,
      message: `Collection ${payment.paymentNumber} recorded and sent for verification.`,
      data: collectionView(payment.toObject()),
    });
  } catch (error) {
    if (error.code === 11000) {
      // A concurrent retry with the same idempotency key: return the winner.
      if (sourceKey) {
        const existing = await Payment.findOne({ branch: req.branchId, sourceKey }).lean();
        if (existing) return res.json({ success: true, message: 'Collection already recorded.', data: collectionView(existing) });
      }
      return res.status(409).json({ success: false, message: 'Duplicate collection number, please retry.' });
    }
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Self-service dealer visits / route execution (SOW 18.2)
// ---------------------------------------------------------------------------

const VISIT_PURPOSES = new Set(['sales', 'collection', 'follow_up', 'complaint', 'relationship', 'new_business', 'other']);

const visitView = (visit) => ({
  _id: visit._id,
  dealer: visit.dealer,
  dealerName: visit.dealerName || (visit.dealer && typeof visit.dealer === 'object' ? visit.dealer.businessName : '') || '',
  status: visit.status,
  purpose: visit.purpose,
  checkInAt: visit.checkInAt,
  checkOutAt: visit.checkOutAt || null,
  checkInLocation: visit.checkInLocation || null,
  checkOutLocation: visit.checkOutLocation || null,
  durationMinutes: visit.durationMinutes || 0,
  notes: visit.notes || '',
  outcome: visit.outcome || '',
  nextFollowUpDate: visit.nextFollowUpDate || null,
  createdAt: visit.createdAt,
});

router.get('/me/visits', requirePermission('se.route.plan'), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { branch: req.branchId, salesExecutive: req.user._id };
    if (status && ['checked_in', 'completed', 'cancelled'].includes(String(status))) filter.status = status;

    const [rows, total] = await Promise.all([
      DealerVisit.find(filter).sort({ checkInAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode').lean(),
      DealerVisit.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: rows.map(visitView),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l, hasMore: p * l < total },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/me/visits/active', requirePermission('se.route.plan'), async (req, res) => {
  try {
    const visit = await DealerVisit.findOne({ salesExecutive: req.user._id, status: 'checked_in' })
      .sort({ checkInAt: -1 }).populate('dealer', 'businessName dealerCode').lean();
    return res.json({ success: true, data: visit ? visitView(visit) : null });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/me/dealers/:id/visits/check-in', requirePermission('se.route.plan'), async (req, res) => {
  try {
    const dealer = await assertMyDealer(req.user._id, req.params.id);
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found or not assigned to you.' });

    // One open visit at a time per executive.
    const open = await DealerVisit.findOne({ salesExecutive: req.user._id, status: 'checked_in' })
      .populate('dealer', 'businessName').lean();
    if (open) {
      return res.status(409).json({
        success: false,
        code: 'VISIT_IN_PROGRESS',
        message: `You are already checked in at ${open.dealer?.businessName || 'a dealer'}. Check out first.`,
        data: visitView(open),
      });
    }

    const purpose = String(req.body?.purpose || 'sales').trim();
    if (!VISIT_PURPOSES.has(purpose)) {
      return res.status(422).json({ success: false, message: 'A valid visit purpose is required.' });
    }
    const location = normalizeLocation(req.body?.location);
    if (!location) return res.status(422).json({ success: false, message: 'A valid GPS location (lat, lng) is required to check in.' });

    const now = new Date();
    const visit = await DealerVisit.create({
      branch: req.branchId,
      dealer: dealer._id,
      dealerName: dealer.businessName,
      salesExecutive: req.user._id,
      status: 'checked_in',
      purpose,
      checkInAt: now,
      checkInLocation: { lat: location.lat, lng: location.lng },
      createdBy: req.user._id,
      transitions: [{ to: 'checked_in', at: now, by: req.user._id, byName: req.user.name || '' }],
    });
    return res.status(201).json({ success: true, message: `Checked in at ${dealer.businessName}.`, data: visitView(visit.toObject()) });
  } catch (error) {
    // The partial unique index closes the read-then-write race: a concurrent
    // check-in that loses returns the existing open visit as VISIT_IN_PROGRESS.
    if (error.code === 11000) {
      const open = await DealerVisit.findOne({ salesExecutive: req.user._id, status: 'checked_in' })
        .populate('dealer', 'businessName').lean();
      return res.status(409).json({
        success: false,
        code: 'VISIT_IN_PROGRESS',
        message: `You are already checked in at ${open?.dealer?.businessName || 'a dealer'}. Check out first.`,
        ...(open ? { data: visitView(open) } : {}),
      });
    }
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

router.patch('/me/visits/:id/check-out', requirePermission('se.route.plan'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(422).json({ success: false, message: 'Invalid visit id.' });
    }
    const visit = await DealerVisit.findOne({ _id: req.params.id, salesExecutive: req.user._id });
    if (!visit) return res.status(404).json({ success: false, message: 'Visit not found.' });
    if (visit.status !== 'checked_in') {
      return res.status(409).json({ success: false, message: `This visit is already ${visit.status}.` });
    }

    const location = normalizeLocation(req.body?.location);
    const notes = String(req.body?.notes || '').trim();
    const outcome = String(req.body?.outcome || '').trim();
    let nextFollowUpDate;
    if (req.body?.nextFollowUpDate) {
      nextFollowUpDate = new Date(req.body.nextFollowUpDate);
      if (Number.isNaN(nextFollowUpDate.getTime())) {
        return res.status(422).json({ success: false, message: 'nextFollowUpDate is invalid.' });
      }
    }

    const now = new Date();
    visit.status = 'completed';
    visit.checkOutAt = now;
    if (location) visit.checkOutLocation = { lat: location.lat, lng: location.lng };
    visit.durationMinutes = Math.max(0, Math.round((now.getTime() - new Date(visit.checkInAt).getTime()) / 60000));
    if (notes) visit.notes = notes;
    if (outcome) visit.outcome = outcome;
    if (nextFollowUpDate) visit.nextFollowUpDate = nextFollowUpDate;
    visit.transitions.push({ from: 'checked_in', to: 'completed', at: now, by: req.user._id, byName: req.user.name || '' });
    await visit.save();
    return res.json({ success: true, message: 'Checked out.', data: visitView(visit.toObject()) });
  } catch (error) {
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

// ── Dealer chat, executive side (SOW 17.8) ───────────────────────────────────
// Mirrors the dealer app's /dealer-app/messages endpoints so the conversation is
// two-way. Gated on permissions sales executives already hold, so no migration
// is needed to roll this out.
const CHAT_PERMISSIONS = ['se.dealer.insights', 'sales.executive.app'];

// GET /api/v1/sales-executive/me/messages/threads
// One row per dealer that has a conversation, newest activity first.
router.get('/me/messages/threads', requireAnyPermission(...CHAT_PERMISSIONS), async (req, res) => {
  try {
    const dealerIds = await myDealerIds(req.user._id);
    if (!dealerIds.length) return res.json({ success: true, data: [] });

    const rows = await DealerMessage.aggregate([
      { $match: { dealer: { $in: dealerIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$dealer',
          lastMessage: { $first: '$body' },
          lastSenderRole: { $first: '$senderRole' },
          lastAt: { $first: '$createdAt' },
          unread: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$senderRole', 'dealer'] }, { $eq: ['$readByExecutiveAt', null] }] },
                1,
                0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
      { $sort: { lastAt: -1 } },
      {
        $lookup: {
          from: 'dealers',
          localField: '_id',
          foreignField: '_id',
          as: 'dealer',
        },
      },
      { $unwind: '$dealer' },
      {
        $project: {
          _id: 0,
          dealerId: '$_id',
          businessName: '$dealer.businessName',
          dealerCode: '$dealer.dealerCode',
          mobile: '$dealer.mobile',
          lastMessage: 1,
          lastSenderRole: 1,
          lastAt: 1,
          unread: 1,
          total: 1,
        },
      },
    ]);

    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/sales-executive/me/messages/unread-count
// Declared before /me/messages/:dealerId so it is not captured as a dealer id.
router.get('/me/messages/unread-count', requireAnyPermission(...CHAT_PERMISSIONS), async (req, res) => {
  try {
    const dealerIds = await myDealerIds(req.user._id);
    const count = dealerIds.length
      ? await DealerMessage.countDocuments({
        dealer: { $in: dealerIds }, senderRole: 'dealer', readByExecutiveAt: null,
      })
      : 0;
    return res.json({ success: true, data: { count } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/sales-executive/me/messages/:dealerId
router.get('/me/messages/:dealerId', requireAnyPermission(...CHAT_PERMISSIONS), async (req, res) => {
  try {
    const dealer = await assertMyDealer(req.user._id, req.params.dealerId);
    if (!dealer) {
      return res.status(404).json({ success: false, message: 'Dealer not found in your assignments.' });
    }

    const filter = { dealer: dealer._id };
    if (mongoose.isValidObjectId(req.query.complaint)) filter.complaint = req.query.complaint;

    const data = await DealerMessage.find(filter)
      .sort({ createdAt: 1 }).limit(300)
      .select('senderRole senderName body attachments createdAt readByDealerAt readByExecutiveAt complaint')
      .lean();

    // Opening the thread marks the dealer's messages as read.
    await DealerMessage.updateMany(
      { dealer: dealer._id, senderRole: 'dealer', readByExecutiveAt: null },
      { $set: { readByExecutiveAt: new Date() } },
    );

    return res.json({
      success: true,
      data,
      dealer: {
        _id: dealer._id,
        businessName: dealer.businessName,
        dealerCode: dealer.dealerCode,
        mobile: dealer.mobile,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/sales-executive/me/messages/:dealerId  { body, complaint? }
router.post('/me/messages/:dealerId', requireAnyPermission(...CHAT_PERMISSIONS), async (req, res) => {
  try {
    const dealer = await assertMyDealer(req.user._id, req.params.dealerId);
    if (!dealer) {
      return res.status(404).json({ success: false, message: 'Dealer not found in your assignments.' });
    }
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(422).json({ success: false, message: 'Type a message to send.' });
    if (body.length > 2000) {
      return res.status(422).json({ success: false, message: 'Message is too long (2000 characters max).' });
    }

    const message = await DealerMessage.create({
      branch: req.branchId,
      dealer: dealer._id,
      senderRole: 'executive',
      salesExecutive: req.user._id,
      senderName: req.user.name || 'Sales Executive',
      body,
      complaint: mongoose.isValidObjectId(req.body?.complaint) ? req.body.complaint : undefined,
      readByExecutiveAt: new Date(),
    });

    return res.status(201).json({ success: true, data: message });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
