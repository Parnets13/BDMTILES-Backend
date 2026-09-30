import { Router } from 'express';
import mongoose from 'mongoose';
import Dealer from '../models/Dealer.js';
import DealerLedger from '../models/DealerLedger.js';
import SalesOrder from '../models/SalesOrder.js';
import Quotation from '../models/Quotation.js';
import Complaint from '../models/Complaint.js';
import Route from '../models/Route.js';
import DealerOrderRequest from '../models/DealerOrderRequest.js';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import HrmsSettings from '../models/HrmsSettings.js';
import Expense from '../models/Expense.js';
import Payment from '../models/Payment.js';
import Invoice from '../models/Invoice.js';
import DealerVisit from '../models/DealerVisit.js';
import DealerMessage from '../models/DealerMessage.js';
import TrackingPing from '../models/TrackingPing.js';
import User from '../models/User.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { uploadSEFieldImages } from '../middleware/upload.js';
import { requireBranch } from '../utils/branchScope.js';
import { getDealerCreditExposure } from '../services/dealerCreditService.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { listMyTargetProgress } from '../services/targetService.js';
import { reverseGeocode, geocodeStatus } from '../services/geoService.js';
import { emitTrackingUpdate } from '../services/socketService.js';
import { dealerOrderStockPlan, processDealerOrderRequest } from '../services/dealerOrderProcessingService.js';

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

/**
 * One upload endpoint for every field capture the SE app makes — attendance selfie,
 * dealer-visit photo, collection receipt.
 *
 * The app's convention elsewhere (complaint evidence) is upload-then-store-the-URL, so
 * this returns `{ url }` and the caller sends that string on. It exists because
 * punch-in already accepted a `selfie` string, DealerVisit already had `attachments`,
 * and Payment already had `receiptImage` — the app simply had no way to produce a URL
 * to put in them.
 */
router.post('/me/uploads', requirePermission('sales.executive.app'), (req, res) => {
  uploadSEFieldImages(req, res, (error) => {
    if (error) return res.status(400).json({ success: false, message: error.message });
    if (!req.files?.length) {
      return res.status(400).json({ success: false, message: 'At least one image is required.' });
    }
    return res.json({
      success: true,
      message: `${req.files.length} image(s) uploaded.`,
      data: req.files.map((file) => ({
        url: `/uploads/se/${file.filename}`,
        originalName: file.originalname,
        size: file.size,
      })),
    });
  });
});

/**
 * The branch's sales executives, as a name/id directory.
 *
 * Exists because the admin-side `/se-app/*` viewers each fetched `/users?role=...`
 * purely to fill a filter dropdown, and `/users` is gated on `users.manage` — a
 * permission none of those pages' own guards imply. So every viewer loaded and then
 * failed on its very first request. This returns only what a dropdown needs: no
 * contact details, no role internals, no permissions.
 *
 * Gated on `sales.executive.app` — the permission that means "may work with the SE
 * app surface" — so anyone who can open the SE-app section can populate the filter.
 *
 * Returns `name` and `username` only. No phone, email, role, or permissions: a
 * filter dropdown needs a label and a value, and nothing else belongs in a payload
 * that is readable by every SE-app user.
 */
router.get('/directory/executives', requirePermission('sales.executive.app'), async (req, res) => {
  try {
    // `User.status` is capitalised ('Active'/'Inactive') — a lowercase 'active' here
    // matches nothing and would leave every filter dropdown empty.
    const filter = { role: 'sales_executive', status: 'Active' };
    // Scope to the caller's branch unless they hold global access. The SE app is a
    // branch tool; a branch manager should not see another branch's roster.
    if (!req.hasGlobalBranchAccess) {
      filter.$or = [
        { defaultBranch: req.branchId },
        { assignedBranches: req.branchId },
      ];
    }
    const rows = await User.find(filter)
      .select('name username')
      .sort({ name: 1 })
      .limit(200)
      .lean();

    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

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

// Reads the same target rules the admin authors through /api/v1/targets, via the
// shared targetService — so the figure here always matches the admin screen.
// Unlike the earlier version this covers order-count, visit and collection
// targets too, not just sales value.
router.get('/me/target-progress', requirePermission('se.targets.view'), async (req, res) => {
  try {
    const targets = await listMyTargetProgress({
      branchId: req.branchId,
      executiveId: req.user._id,
    });
    return res.json({ success: true, data: { targets } });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
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
  // The human-readable address, when the device could resolve one. DealerVisit's
  // location schema has carried an `address` field all along and this function was
  // dropping it, which is why attendance and visits only ever stored bare coordinates.
  // Deliberately provider-agnostic: whatever the device (or a later geocoder) supplies
  // is what gets stored, so swapping map providers does not invalidate existing rows.
  const address = String(location.address || '').trim();
  // Android reports whether the fix came from a mock provider. Recording the flag is the
  // honest half of "fake GPS detection" — you can detect a mocked fix, not the intent
  // behind it, so this must never be presented as proof.
  const mocked = location.mocked === true;
  return {
    lat,
    lng,
    ...(Number.isFinite(accuracy) ? { accuracy } : {}),
    ...(address ? { address } : {}),
    ...(mocked ? { mocked: true } : {}),
  };
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
  attachments: visit.attachments || [],
  checklist: visit.checklist || [],
  missedReason: visit.missedReason || '',
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
      checkInLocation: location,
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
    // SOW 18.2 "Visit photo" — already-uploaded URLs from /me/uploads. DealerVisit has
    // carried an `attachments` array all along; nothing ever wrote to it.
    const attachments = Array.isArray(req.body?.attachments)
      ? req.body.attachments.filter((url) => typeof url === 'string' && url.trim()).map((url) => url.trim()).slice(0, 5)
      : [];
    // SOW 18.2 "Dealer visit checklist" — [{ label, done }] snapshot from the device.
    const checklist = Array.isArray(req.body?.checklist)
      ? req.body.checklist
          .filter((row) => row && typeof row.label === 'string' && row.label.trim())
          .map((row) => ({ label: row.label.trim(), done: row.done === true }))
          .slice(0, 30)
      : [];
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
    if (location) visit.checkOutLocation = location;
    visit.durationMinutes = Math.max(0, Math.round((now.getTime() - new Date(visit.checkInAt).getTime()) / 60000));
    if (notes) visit.notes = notes;
    if (outcome) visit.outcome = outcome;
    if (nextFollowUpDate) visit.nextFollowUpDate = nextFollowUpDate;
    if (attachments.length) visit.attachments = attachments;
    if (checklist.length) visit.checklist = checklist;
    visit.transitions.push({ from: 'checked_in', to: 'completed', at: now, by: req.user._id, byName: req.user.name || '' });
    await visit.save();
    return res.json({ success: true, message: 'Checked out.', data: visitView(visit.toObject()) });
  } catch (error) {
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

/**
 * SOW 18.2 "Missed visit reason".
 *
 * A visit that never happened has nothing to check out of, so it cannot go through the
 * check-out route. `cancelled` was the only alternative and it discards the reason —
 * which is the one thing a manager actually needs from a missed visit.
 */
router.patch('/me/visits/:id/miss', requirePermission('se.route.plan'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(422).json({ success: false, message: 'Invalid visit id.' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(422).json({ success: false, message: 'A reason is required for a missed visit.' });
    }
    const visit = await DealerVisit.findOne({ _id: req.params.id, salesExecutive: req.user._id });
    if (!visit) return res.status(404).json({ success: false, message: 'Visit not found.' });
    if (visit.status !== 'checked_in') {
      return res.status(409).json({ success: false, message: `This visit is already ${visit.status}.` });
    }

    const now = new Date();
    visit.status = 'missed';
    visit.missedReason = reason;
    visit.missedAt = now;
    visit.transitions.push({ from: 'checked_in', to: 'missed', at: now, by: req.user._id, byName: req.user.name || '' });
    await visit.save();
    return res.json({ success: true, message: 'Visit marked as missed.', data: visitView(visit.toObject()) });
  } catch (error) {
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

// ── Dealer visits, admin monitoring view (SOW 18.10) ─────────────────────────
// The /me/visits endpoints above are scoped to the signed-in executive, so back
// office staff see nothing through them. These give a branch-wide log of the
// visits the app records. Read-only by design: a visit is field evidence and is
// only ever written by the executive who made it.

const VISIT_STATUSES = ['checked_in', 'completed', 'cancelled', 'missed'];

/** Inclusive day window from optional from/to query dates, in local time. */
function visitDateWindow({ from, to }) {
  const window = {};
  if (from) {
    const start = new Date(from);
    if (!Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      window.$gte = start;
    }
  }
  if (to) {
    const end = new Date(to);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      window.$lte = end;
    }
  }
  return Object.keys(window).length ? window : null;
}

/**
 * Ids are cast explicitly here because this filter is fed to `aggregate()` as
 * well as `find()`. Query helpers cast strings against the schema; the aggregation
 * pipeline does not, so a raw string id in `$match` silently matches nothing.
 */
const asObjectId = (value) => new mongoose.Types.ObjectId(String(value));

function buildVisitFilter(req) {
  const filter = { branch: asObjectId(req.branchId) };
  if (mongoose.isValidObjectId(req.query.salesExecutive)) filter.salesExecutive = asObjectId(req.query.salesExecutive);
  if (mongoose.isValidObjectId(req.query.dealer)) filter.dealer = asObjectId(req.query.dealer);
  if (VISIT_STATUSES.includes(String(req.query.status))) filter.status = req.query.status;
  if (VISIT_PURPOSES.has(String(req.query.purpose))) filter.purpose = req.query.purpose;
  const window = visitDateWindow(req.query);
  if (window) filter.checkInAt = window;
  return filter;
}

router.get('/visits', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const p = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const l = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const filter = buildVisitFilter(req);

    const [rows, total] = await Promise.all([
      DealerVisit.find(filter).sort({ checkInAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode city mobile')
        .populate('salesExecutive', 'name phone')
        .lean(),
      DealerVisit.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: rows.map((visit) => ({
        ...visitView(visit),
        salesExecutive: visit.salesExecutive || null,
        dealerCode: visit.dealer?.dealerCode || '',
        dealerCity: visit.dealer?.city || '',
        dealerMobile: visit.dealer?.mobile || '',
      })),
      pagination: {
        currentPage: p, totalPages: Math.ceil(total / l), totalItems: total,
        itemsPerPage: l, hasMore: p * l < total,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/visits/summary', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const filter = buildVisitFilter(req);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [byStatus, byPurpose, today, duration, executives] = await Promise.all([
      DealerVisit.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      DealerVisit.aggregate([{ $match: filter }, { $group: { _id: '$purpose', count: { $sum: 1 } } }]),
      DealerVisit.countDocuments({ ...filter, checkInAt: { ...(filter.checkInAt || {}), $gte: startOfToday } }),
      DealerVisit.aggregate([
        { $match: { ...filter, status: 'completed' } },
        { $group: { _id: null, avgMinutes: { $avg: '$durationMinutes' } } },
      ]),
      DealerVisit.distinct('salesExecutive', filter),
    ]);

    const statusCounts = Object.fromEntries(byStatus.map((row) => [row._id, row.count]));
    return res.json({
      success: true,
      data: {
        total: byStatus.reduce((sum, row) => sum + row.count, 0),
        checkedIn: statusCounts.checked_in || 0,
        completed: statusCounts.completed || 0,
        cancelled: statusCounts.cancelled || 0,
        missed: statusCounts.missed || 0,
        today,
        activeExecutives: executives.filter(Boolean).length,
        avgDurationMinutes: Math.round(duration[0]?.avgMinutes || 0),
        byPurpose: Object.fromEntries(byPurpose.map((row) => [row._id, row.count])),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ── Admin monitoring (SOW 18.10) ─────────────────────────────────────────────
//
// Deliberately map-agnostic. Everything below returns coordinates, addresses and
// timestamps rather than tiles, so these views work today and a map layer can be drawn
// over them later without touching any of this. That matters while no compliant map
// provider is wired up — and it means "attendance with address" needs no provider at all
// once the device supplies one.

const MONITOR_PERMISSION = 'se.attendance.view';

/**
 * Where each executive was last seen.
 *
 * An active check-in is the best answer — they are standing at a dealer right now.
 * Failing that, the day's latest punch, which at least says where the day started.
 *
 * Attendance keys on Employee and DealerVisit on User, so the two are joined through
 * Employee.userId. Assuming one id space here would have silently dropped every row.
 */
router.get('/monitoring/live', requirePermission(MONITOR_PERMISSION), async (req, res) => {
  try {
    const branch = new mongoose.Types.ObjectId(String(req.branchId));
    const [activeVisits, employees, punches, latestFixes] = await Promise.all([
      DealerVisit.find({ branch, status: 'checked_in' })
        .select('salesExecutive dealerName checkInAt checkInLocation purpose')
        .populate('salesExecutive', 'name phone')
        .lean(),
      Employee.find({ branchId: req.branchId }).select('_id name empId userId').lean(),
      Attendance.find({ branch, date: { $gte: startOfToday() } })
        .select('employee punchIn punchOut punchInLocation punchOutLocation status')
        .lean(),
      // Newest tracking row per executive. Aggregated rather than queried per person
      // so this stays one round trip however many executives a branch has.
      TrackingPing.aggregate([
        { $match: { branch } },
        { $sort: { at: -1 } },
        { $group: { _id: '$executive', doc: { $first: '$$ROOT' } } },
      ]),
    ]);

    const employeeById = new Map(employees.map((row) => [String(row._id), row]));
    const rows = new Map();

    // Punches first — they cover everyone who turned up, visited or not.
    for (const punch of punches) {
      const employee = employeeById.get(String(punch.employee));
      if (!employee) continue;
      const key = String(employee.userId || employee._id);
      const place = punch.punchOut ? punch.punchOutLocation : punch.punchInLocation;
      rows.set(key, {
        executiveId: employee.userId || null,
        employeeId: employee._id,
        name: employee.name || '',
        empId: employee.empId || '',
        status: punch.status || '',
        lastSeenAt: punch.punchOut || punch.punchIn || null,
        location: place || null,
        onSite: false,
        dealerName: '',
        purpose: '',
        checkedInAt: null,
      });
    }

    // An active visit overrides it: that is where they actually are.
    for (const visit of activeVisits) {
      const executive = visit.salesExecutive;
      const key = String(executive?._id || visit.salesExecutive);
      const existing = rows.get(key) || {};
      rows.set(key, {
        ...existing,
        executiveId: executive?._id || visit.salesExecutive,
        name: executive?.name || existing.name || '',
        phone: executive?.phone || '',
        lastSeenAt: visit.checkInAt,
        location: visit.checkInLocation || existing.location || null,
        onSite: true,
        dealerName: visit.dealerName || '',
        purpose: visit.purpose || '',
        checkedInAt: visit.checkInAt,
      });
    }

    // The tracking fix is the freshest source, so it wins where it exists. A stale fix
    // is still shown but flagged — a phone that died at 11am must not read "at Dealer X"
    // at 6pm as though it were current.
    const staleAfterMs = staleMinutes() * 60000;
    for (const row of latestFixes) {
      const key = String(row._id);
      const existing = rows.get(key) || {};
      const fix = row.doc || {};
      rows.set(key, {
        ...existing,
        executiveId: row._id,
        name: existing.name || fix.executiveName || '',
        lastSeenAt: fix.at,
        location: fix.lat != null
          ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, address: fix.address, mocked: fix.mocked }
          : existing.location || null,
        trackingStatus: fix.status || 'active',
        battery: fix.battery ?? null,
        charging: fix.charging === true,
        stale: !fix.at || Date.now() - new Date(fix.at).getTime() > staleAfterMs,
        // Reported by the device. Surfaced as information to check, never as an
        // accusation — see the productivity view.
        mocked: fix.mocked === true,
      });
    }

    const data = [...rows.values()].sort((a, b) => {
      if (a.onSite !== b.onSite) return a.onSite ? -1 : 1;
      return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/** One executive's day in order — every visit with its times, place and duration. */
router.get('/monitoring/route-history', requirePermission(MONITOR_PERMISSION), async (req, res) => {
  try {
    const filter = { branch: req.branchId };
    if (req.query.executive) filter.salesExecutive = req.query.executive;
    const window = visitDateWindow(req.query);
    if (window) filter.checkInAt = window;

    const visits = await DealerVisit.find(filter)
      .select('dealer dealerName salesExecutive status purpose checkInAt checkOutAt durationMinutes checkInLocation checkOutLocation notes outcome attachments checklist missedReason')
      .populate('dealer', 'businessName dealerCode')
      .populate('salesExecutive', 'name')
      .sort({ checkInAt: 1 })
      .limit(500)
      .lean();

    return res.json({
      success: true,
      data: visits.map((visit) => ({
        _id: visit._id,
        dealerName: visit.dealerName || visit.dealer?.businessName || '',
        dealerCode: visit.dealer?.dealerCode || '',
        executiveName: visit.salesExecutive?.name || '',
        status: visit.status,
        purpose: visit.purpose,
        checkInAt: visit.checkInAt,
        checkOutAt: visit.checkOutAt || null,
        durationMinutes: visit.durationMinutes || 0,
        checkInLocation: visit.checkInLocation || null,
        checkOutLocation: visit.checkOutLocation || null,
        notes: visit.notes || '',
        outcome: visit.outcome || '',
        photoCount: (visit.attachments || []).length,
        checklist: visit.checklist || [],
        missedReason: visit.missedReason || '',
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/** Visits that were closed as missed, with the reason the executive gave. */
router.get('/monitoring/missed-visits', requirePermission(MONITOR_PERMISSION), async (req, res) => {
  try {
    const filter = { branch: req.branchId, status: 'missed' };
    const window = visitDateWindow(req.query);
    if (window) filter.checkInAt = window;

    const visits = await DealerVisit.find(filter)
      .select('dealerName salesExecutive missedReason missedAt checkInAt purpose')
      .populate('salesExecutive', 'name')
      .sort({ missedAt: -1 })
      .limit(200)
      .lean();

    return res.json({
      success: true,
      data: visits.map((visit) => ({
        _id: visit._id,
        dealerName: visit.dealerName || '',
        executiveName: visit.salesExecutive?.name || '',
        purpose: visit.purpose,
        missedReason: visit.missedReason || '',
        missedAt: visit.missedAt || visit.checkInAt || null,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Per-executive productivity for a window: visits, time at dealers, outcomes, and how
 * much of it was verified (a photo, a checklist, a non-mocked fix).
 */
router.get('/monitoring/productivity', requirePermission(MONITOR_PERMISSION), async (req, res) => {
  try {
    const filter = { branch: req.branchId };
    const window = visitDateWindow(req.query);
    if (window) filter.checkInAt = window;

    const [rows] = await Promise.all([
      DealerVisit.aggregate([
        { $match: { ...filter, branch: new mongoose.Types.ObjectId(String(req.branchId)) } },
        {
          $group: {
            _id: '$salesExecutive',
            visits: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ['$status', 'checked_in'] }, 1, 0] } },
            totalMinutes: { $sum: '$durationMinutes' },
            withPhoto: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$attachments', []] } }, 0] }, 1, 0] } },
            mockedFixes: {
              $sum: { $cond: [{ $eq: ['$checkInLocation.mocked', true] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    const executives = await User.find({ _id: { $in: rows.map((row) => row._id).filter(Boolean) } })
      .select('name phone')
      .lean();
    const nameById = new Map(executives.map((row) => [String(row._id), row]));

    const data = rows
      .map((row) => ({
        executiveId: row._id,
        name: nameById.get(String(row._id))?.name || 'Unknown',
        phone: nameById.get(String(row._id))?.phone || '',
        visits: row.visits,
        completed: row.completed,
        missed: row.missed,
        inProgress: row.inProgress,
        totalMinutes: row.totalMinutes,
        avgMinutes: row.completed ? Math.round(row.totalMinutes / row.completed) : 0,
        withPhoto: row.withPhoto,
        // Surfaced as a count to look into, never as an accusation — a mocked fix is
        // evidence that the device reported one, not proof of intent.
        mockedFixes: row.mockedFixes,
      }))
      .sort((a, b) => b.completed - a.completed || b.visits - a.visits);

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ── Field tracking (SOW 18.10 "Live GPS tracking") ───────────────────────────
//
// Privacy-first, following the pattern the client's reference app already uses:
// an executive is tracked ONLY between check-in and check-out, and never after
// 23:59 business time. The gate is enforced here on every write, not just in the
// app, so a modified client cannot keep reporting after hours.
//
// No Firebase, no second vendor. The client already runs socket.io, so the live
// view is pushed over that and the trail is stored in MongoDB.

const BUSINESS_OFFSET_MINUTES = 330; // IST (UTC+5:30)
const businessNow = () => new Date(Date.now() + BUSINESS_OFFSET_MINUTES * 60000);
const businessDayKey = (date = new Date()) =>
  new Date(date.getTime() + BUSINESS_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
const isPastBusinessMidnight = () => {
  const now = businessNow();
  return now.getUTCHours() >= 23 && now.getUTCMinutes() >= 59;
};

const staleMinutes = () => {
  const parsed = Number.parseInt(process.env.TRACKING_STALE_MINUTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
};
const retentionDays = () => {
  const parsed = Number.parseInt(process.env.TRACKING_HISTORY_RETENTION_DAYS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 90;
};
const minPingSeconds = () => {
  const parsed = Number.parseInt(process.env.TRACKING_MIN_PING_SECONDS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
};

/** Metres between two fixes — used to skip storing a stationary phone's jitter. */
const distanceMeters = (a, b) => {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Whether this executive may be tracked right now — and why not, when not.
 *
 * Returns a reason rather than a bare boolean so the app can tell the user something
 * useful ("you have checked out") instead of silently stopping.
 */
async function trackingDecision(req) {
  const employee = await resolveEmployee(req);
  if (!employee) return { shouldTrack: false, reason: 'no_employee_profile' };
  const attendance = await Attendance.findOne({
    branch: req.branchId,
    employee: employee._id,
    date: startOfToday(),
  }).lean();
  if (!attendance?.punchIn) return { shouldTrack: false, reason: 'not_checked_in' };
  if (attendance.punchOut) return { shouldTrack: false, reason: 'checked_out' };
  if (isPastBusinessMidnight()) return { shouldTrack: false, reason: 'past_midnight' };
  return { shouldTrack: true, reason: 'active', employee, attendance };
}

router.get('/me/tracking/status', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const decision = await trackingDecision(req);
    return res.json({
      success: true,
      data: {
        shouldTrack: decision.shouldTrack,
        reason: decision.reason,
        minPingSeconds: minPingSeconds(),
        geocoding: geocodeStatus(),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Record a fix, or a status change with no fix.
 *
 * `status: 'gps_off'` is a first-class report, not an error — when an executive's dot
 * stops moving, "location is switched off" and "the phone is dead" are very different
 * answers for whoever is watching.
 */
router.post('/me/tracking/ping', requirePermission('se.attendance.view'), async (req, res) => {
  try {
    const decision = await trackingDecision(req);
    if (!decision.shouldTrack) {
      return res.status(409).json({
        success: false,
        code: 'TRACKING_NOT_ALLOWED',
        message: `Tracking is not active (${decision.reason}).`,
        data: { reason: decision.reason },
      });
    }

    const status = req.body?.status === 'gps_off' ? 'gps_off' : 'active';
    const location = status === 'active' ? normalizeLocation(req.body?.location) : undefined;
    if (status === 'active' && !location) {
      return res.status(422).json({ success: false, message: 'A valid location is required to report a fix.' });
    }

    const previous = await TrackingPing.findOne({ executive: req.user._id })
      .sort({ at: -1 })
      .select('at lat lng status')
      .lean();

    // Throttle server-side as well as in the app. The app's own throttle is a courtesy;
    // this is the one a modified client cannot skip.
    const moved = distanceMeters(previous, location);
    const sinceMs = previous ? Date.now() - new Date(previous.at).getTime() : Infinity;
    const statusChanged = !previous || previous.status !== status;
    if (!statusChanged && moved < 20 && sinceMs < minPingSeconds() * 1000) {
      return res.json({ success: true, message: 'Throttled.', data: { stored: false, reason: 'active' } });
    }

    // Reverse geocoded once per distinct spot (the service caches), so repeated pings
    // from a dealer's yard do not spend provider quota.
    const address = location ? await reverseGeocode(location) : '';

    const days = retentionDays();
    const ping = await TrackingPing.create({
      branch: req.branchId,
      executive: req.user._id,
      employee: decision.employee?._id,
      executiveName: req.user.name || '',
      at: new Date(),
      day: businessDayKey(),
      status,
      lat: location?.lat,
      lng: location?.lng,
      accuracy: location?.accuracy,
      speed: Number.isFinite(Number(req.body?.speed)) ? Number(req.body.speed) : undefined,
      address,
      mocked: location?.mocked === true,
      battery: Number.isFinite(Number(req.body?.battery)) ? Number(req.body.battery) : undefined,
      charging: req.body?.charging === true,
      context: req.body?.context === 'visit' ? 'visit' : 'duty',
      dealer: req.body?.dealer || undefined,
      // TTL handles pruning; a cron job is one more thing that can silently stop.
      expiresAt: days > 0 ? new Date(Date.now() + days * 86400000) : undefined,
    });

    emitTrackingUpdate({
      branch: String(req.branchId),
      executiveId: String(req.user._id),
      name: req.user.name || '',
      status,
      at: ping.at,
      lat: ping.lat,
      lng: ping.lng,
      address: ping.address,
      battery: ping.battery,
      charging: ping.charging,
      context: ping.context,
      dealer: ping.dealer ? String(ping.dealer) : null,
      mocked: ping.mocked,
    });

    return res.json({ success: true, data: { stored: true, reason: 'active' } });
  } catch (error) {
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

/** One executive's breadcrumb trail for a day — what the route replay is drawn from. */
router.get('/monitoring/trail', requirePermission(MONITOR_PERMISSION), async (req, res) => {
  try {
    const executive = req.query.executive;
    if (!executive || !mongoose.isValidObjectId(executive)) {
      return res.status(422).json({ success: false, message: 'A valid executive is required.' });
    }
    const day = String(req.query.day || businessDayKey()).slice(0, 10);
    const points = await TrackingPing.find({
      branch: req.branchId,
      executive,
      day,
      status: 'active',
      lat: { $ne: null },
    })
      .select('at lat lng accuracy speed address battery charging mocked context')
      .sort({ at: 1 })
      .limit(2000)
      .lean();
    return res.json({ success: true, data: { day, points } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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

// ─────────────────────────────────────────────────────────────────────────────
// SE-scoped dealer order request: stock-plan and process.
//
// The web's /dealer-order-requests/:id/process requires `sales.order.approve` —
// a manager-level permission for dispatch and cancellation approval. The SE
// should not have it globally, but should still be able to turn their own dealer's
// approved request into a sales order. These endpoints call the same service
// functions, but first verify the request belongs to this SE before delegating.
// That ownership check is the only difference from the web handler.
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors populateRequest in dealerOrderRequestRoutes — same populates so the
// app gets the same shape whether it reads from /mine or from here.
function populateRequest(query) {
  return query
    .populate('dealer', 'businessName dealerCode ownerName mobile city status dealerType')
    .populate('salesExecutive', 'name mobile email')
    .populate('approvedBy rejectedBy linkedBy processedBy', 'name')
    .populate('sourceQuotation', 'quotationNumber status grandTotal splitRole splitGroupId')
    .populate('availableQuotation pendingStockQuotation', 'quotationNumber status grandTotal holdStatus holdExpiresAt splitRole')
    .populate('sourceSalesOrder', 'orderNumber status approvalStatus reservationStatus grandTotal')
    .populate('outcomes.quotation', 'quotationNumber status grandTotal splitRole')
    .populate('outcomes.salesOrder', 'orderNumber status approvalStatus reservationStatus grandTotal');
}

async function loadOwnRequest(req, res) {
  const request = await populateRequest(
    DealerOrderRequest.findOne({ _id: req.params.id, branch: req.branchId, salesExecutive: req.user._id })
  ).lean();
  if (!request) {
  res.status(404).json({ success: false, message: 'Order request not found or not yours.' });
  return null;
  }
  return request;
}

const seError = (err) => err.status || 500;

// POST /sales-executive/me/order-requests/:id/stock-plan
// Checks stock availability for an approved request, returns a plan the SE
// confirms before processing. The service function does the real work.
router.post('/me/order-requests/:id/stock-plan',
  requirePermission('dealer.order_request.review'),
  requirePermission('quotation.management'),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      let payload;
      await session.withTransaction(async () => {
        const own = await loadOwnRequest(req, res);
        if (!own) return;
        const { request, quotation, plan } = await dealerOrderStockPlan({
          requestId: req.params.id,
          branchId: req.branchId,
          actor: req.user,
          session,
        });
        payload = {
          request: { _id: request._id, requestNumber: request.requestNumber, revision: request.revision, status: request.status },
          quotation: { _id: quotation._id, quotationNumber: quotation.quotationNumber, status: quotation.status, grandTotal: quotation.grandTotal },
          plan: { planHash: plan.planHash, willSplit: plan.willSplit, canHold: plan.canHold, checkedAt: plan.checkedAt, totals: plan.totals, lines: plan.lines || [] },
        };
      });
      if (!payload) return; // loadOwnRequest already sent 404
      return res.json({
        success: true,
        message: payload.plan.willSplit
          ? 'Part of this request can be reserved now. Give an expected date for the short lines to continue.'
          : payload.plan.canHold
            ? 'Everything requested is available and can be reserved now.'
            : 'None of the requested quantity is available. Give the dealer an expected date or mark the lines unavailable.',
        data: payload,
      });
    } catch (error) {
      return res.status(seError(error)).json({ success: false, message: error.message });
    } finally { await session.endSession(); }
  },
);

// POST /sales-executive/me/order-requests/:id/process
// Reserves available stock into a Sales Order and puts the rest to the dealer
// as a shortfall question. The SE-scoped version of the web endpoint — the
// only difference is loadOwnRequest instead of the branch-wide loadProcessableRequest.
router.post('/me/order-requests/:id/process',
  requirePermission('dealer.order_request.review'),
  requirePermission('quotation.management'),
  requirePermission('sales.order.create'),
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      let result;
      const answers = Array.isArray(req.body?.shortfall) ? req.body.shortfall : [];
      await session.withTransaction(async () => {
        result = await processDealerOrderRequest({
          requestId: req.params.id,
          branchId: req.branchId,
          actor: req.user,
          planHash: req.body?.planHash,
          shortfallInput: answers,
          offerRemark: req.body?.offerRemark,
          session,
        });
      });
      // The service returns the raw Mongoose doc; re-populate for the response.
      const request = await populateRequest(
        DealerOrderRequest.findById(result.request._id)
      ).lean();
      const shortfallCount = result.shortfallLines.length;
      return res.status(201).json({
        success: true,
        message: result.salesOrder
          ? shortfallCount
            ? `${result.salesOrder.orderNumber} created and reserved for the available quantity. ${shortfallCount} line${shortfallCount === 1 ? '' : 's'} sent to the dealer.`
            : `${result.salesOrder.orderNumber} created and reserved for the full requested quantity.`
          : `No stock could be reserved. ${shortfallCount} line${shortfallCount === 1 ? '' : 's'} sent to the dealer.`,
        data: {
          request,
          salesOrder: result.salesOrder || null,
          availableQuotation: result.availableQuotation
            ? { _id: result.availableQuotation._id, quotationNumber: result.availableQuotation.quotationNumber }
            : null,
          pendingStockQuotation: result.pendingStockQuotation
            ? { _id: result.pendingStockQuotation._id, quotationNumber: result.pendingStockQuotation.quotationNumber }
            : null,
          plan: result.plan,
        },
      });
    } catch (error) {
      return res.status(seError(error)).json({ success: false, message: error.message });
    } finally { await session.endSession(); }
  },
);

export default router;
