import SalesOrder from '../models/SalesOrder.js';
import SalesReturn from '../models/SalesReturn.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import PurchaseReturn from '../models/PurchaseReturn.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import Payment from '../models/Payment.js';
import DealerLedger from '../models/DealerLedger.js';
import SupplierLedger from '../models/SupplierLedger.js';
import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import Delivery from '../models/Delivery.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import Lead from '../models/Lead.js';
import Complaint from '../models/Complaint.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import ActivityLog from '../models/ActivityLog.js';
import { userHasPermission } from '../middleware/auth.js';

const DASHBOARD_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_SALES_STATUSES = { $nin: ['draft', 'cancelled', 'expired'] };

const SECTION_PERMISSIONS = Object.freeze({
  sales: ['reports.sales', 'sales.order.dashboard'],
  collections: ['reports.finance', 'finance.management', 'payment', 'dealer.ledger'],
  inventory: ['reports.inventory', 'stock.view'],
  purchase: ['reports.purchase', 'po.management', 'grn.entry', 'debit.note', 'supplier.ledger'],
  crm: ['lead.management', 'followup.management', 'complaint.management'],
  hr: ['reports.hr', 'hrms.management', 'attendance.master', 'leave.management'],
  warehouseDelivery: ['picking.management', 'sorting.management', 'dispatch.management', 'delivery.management', 'delivery.tracking'],
  profitability: ['reports.profit'],
  activity: ['activity.logs'],
});

const APPROVAL_TYPE_PERMISSIONS = Object.freeze({
  sales_order: 'sales.order.approve',
  purchase_order: 'po.management',
  credit_limit: 'finance.management',
  rate_override: 'dealer.discounts',
  debit_note: 'debit.note',
  credit_note: 'credit.note',
  discount: 'dealer.discounts',
  other: 'system.management',
});

const hasAnyPermission = (user, permissions) => permissions.some((permission) => userHasPermission(user, permission));
const calendarBoundary = (year, month, day) => new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
const addDays = (date, days) => new Date(date.getTime() + (days * DAY_MS));
const dateKey = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const countById = (rows = []) => Object.fromEntries(rows.map((row) => [row._id, row.count]));
const sumMetric = (row, field = 'total') => row?.[0]?.[field] || 0;
const periodMatch = (field, from, to) => ({ [field]: { $gte: from, $lt: to } });

const getPeriods = () => {
  const now = new Date();
  const indianNow = new Date(now.getTime() + IST_OFFSET_MS);
  const year = indianNow.getUTCFullYear();
  const month = indianNow.getUTCMonth();
  const day = indianNow.getUTCDate();
  const today = calendarBoundary(year, month, day);
  return {
    now,
    today,
    tomorrow: addDays(today, 1),
    yesterday: addDays(today, -1),
    weekStart: addDays(today, -6),
    monthStart: calendarBoundary(year, month, 1),
    nextMonthStart: calendarBoundary(year, month + 1, 1),
    previousMonthStart: calendarBoundary(year, month - 1, 1),
    yearStart: calendarBoundary(year, 0, 1),
    nextYearStart: calendarBoundary(year + 1, 0, 1),
  };
};

const buildSales = async (scopeMatch, periods, user) => {
  const canReadReturns = hasAnyPermission(user, ['reports.sales', 'credit.note']);
  const [facets = {}] = await SalesOrder.aggregate([
    { $match: { ...scopeMatch, status: LIVE_SALES_STATUSES } },
    { $facet: {
      today: [{ $match: periodMatch('orderDate', periods.today, periods.tomorrow) }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }],
      yesterday: [{ $match: periodMatch('orderDate', periods.yesterday, periods.today) }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }],
      week: [{ $match: periodMatch('orderDate', periods.weekStart, periods.tomorrow) }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }],
      month: [{ $match: periodMatch('orderDate', periods.monthStart, periods.nextMonthStart) }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 }, average: { $avg: '$grandTotal' } } }],
      previousMonth: [{ $match: periodMatch('orderDate', periods.previousMonthStart, periods.monthStart) }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }],
      year: [{ $match: periodMatch('orderDate', periods.yearStart, periods.nextYearStart) }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }],
      trend: [
        { $match: periodMatch('orderDate', periods.weekStart, periods.tomorrow) },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$orderDate', timezone: DASHBOARD_TIMEZONE } }, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
      branchWise: [
        { $match: periodMatch('orderDate', periods.monthStart, periods.nextMonthStart) },
        { $group: { _id: '$branch', total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
        { $lookup: { from: 'branches', localField: '_id', foreignField: '_id', as: 'branchInfo' } },
        { $project: { total: 1, count: 1, name: { $ifNull: [{ $first: '$branchInfo.name' }, 'Unknown branch'] } } },
        { $sort: { total: -1 } },
      ],
      dealerWise: [
        { $match: periodMatch('orderDate', periods.monthStart, periods.nextMonthStart) },
        { $group: { _id: { $ifNull: ['$dealer', '$customerName'] }, name: { $first: { $ifNull: ['$dealerName', '$customerName'] } }, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } }, { $limit: 8 },
      ],
      channelWise: [
        { $match: periodMatch('orderDate', periods.monthStart, periods.nextMonthStart) },
        { $group: { _id: '$orderType', total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ],
      pending: [{ $match: { status: { $in: ['confirmed', 'approved', 'processing', 'partial_dispatch'] } } }, { $count: 'count' }],
    } },
  ]);

  const [returns, cancelledOrders] = await Promise.all([
    canReadReturns ? SalesReturn.aggregate([
      { $match: { ...scopeMatch, status: { $nin: ['draft', 'cancelled'] }, ...periodMatch('returnDate', periods.monthStart, periods.nextMonthStart) } },
      { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    ]) : Promise.resolve([]),
    SalesOrder.countDocuments({ ...scopeMatch, status: 'cancelled', ...periodMatch('orderDate', periods.monthStart, periods.nextMonthStart) }),
  ]);

  const trendMap = new Map((facets.trend || []).map((row) => [row._id, row]));
  const weeklyTrend = Array.from({ length: 7 }, (_, index) => {
    const key = dateKey(addDays(periods.weekStart, index));
    return trendMap.get(key) || { _id: key, total: 0, count: 0 };
  });
  const monthSales = sumMetric(facets.month);
  const previousMonthSales = sumMetric(facets.previousMonth);

  return {
    available: true,
    todaySales: sumMetric(facets.today),
    todayOrders: facets.today?.[0]?.count || 0,
    yesterdaySales: sumMetric(facets.yesterday),
    weekSales: sumMetric(facets.week),
    monthSales,
    monthOrders: facets.month?.[0]?.count || 0,
    yearSales: sumMetric(facets.year),
    pendingOrders: facets.pending?.[0]?.count || 0,
    cancelledOrders,
    salesReturns: canReadReturns ? sumMetric(returns) : null,
    salesReturnCount: canReadReturns ? returns[0]?.count || 0 : null,
    averageOrderValue: facets.month?.[0]?.average || 0,
    monthGrowth: previousMonthSales > 0 ? Number((((monthSales - previousMonthSales) / previousMonthSales) * 100).toFixed(1)) : null,
    weeklyTrend,
    branchWise: facets.branchWise || [],
    dealerWise: facets.dealerWise || [],
    channelWise: facets.channelWise || [],
    warnings: canReadReturns ? [] : ['Sales-return totals are hidden because sales-report or credit-note permission is required.'],
  };
};

const buildCollections = async (scopeMatch, periods, user) => {
  const canReadPayments = hasAnyPermission(user, ['payment', 'reports.finance', 'finance.management']);
  const canReadOutstanding = hasAnyPermission(user, ['dealer.ledger', 'reports.finance', 'finance.management']);
  const [paymentRows, balances, orderAging, customerBalances] = await Promise.all([
    canReadPayments ? Payment.aggregate([
      { $match: { ...scopeMatch, paymentType: 'dealer_receipt', status: 'confirmed' } },
      { $facet: {
        today: [
          { $match: periodMatch('paymentDate', periods.today, periods.tomorrow) },
          { $group: { _id: '$paymentMode', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        month: [
          { $match: periodMatch('paymentDate', periods.monthStart, periods.nextMonthStart) },
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        ],
      } },
    ]) : Promise.resolve([]),
    canReadOutstanding ? DealerLedger.aggregate([
      { $match: scopeMatch },
      { $group: { _id: '$dealer', name: { $last: '$dealerName' }, code: { $last: '$dealerCode' }, outstanding: { $sum: { $subtract: [{ $ifNull: ['$debit', 0] }, { $ifNull: ['$credit', 0] }] } } } },
      { $match: { outstanding: { $gt: 0 } } },
      { $sort: { outstanding: -1 } },
    ]) : Promise.resolve([]),
    canReadOutstanding ? SalesOrder.aggregate([
      { $match: { ...scopeMatch, status: LIVE_SALES_STATUSES, paymentStatus: { $in: ['pending', 'partial', 'overdue'] }, balanceAmount: { $gt: 0 } } },
      { $project: { balanceAmount: 1, paymentStatus: 1, ageDays: { $dateDiff: { startDate: '$orderDate', endDate: periods.now, unit: 'day' } } } },
      { $group: {
        _id: null,
        pendingOrders: { $sum: 1 },
        current: { $sum: { $cond: [{ $lte: ['$ageDays', 30] }, '$balanceAmount', 0] } },
        days31To60: { $sum: { $cond: [{ $and: [{ $gt: ['$ageDays', 30] }, { $lte: ['$ageDays', 60] }] }, '$balanceAmount', 0] } },
        days61To90: { $sum: { $cond: [{ $and: [{ $gt: ['$ageDays', 60] }, { $lte: ['$ageDays', 90] }] }, '$balanceAmount', 0] } },
        over90: { $sum: { $cond: [{ $gt: ['$ageDays', 90] }, '$balanceAmount', 0] } },
      } },
    ]) : Promise.resolve([]),
    canReadOutstanding ? SalesOrder.aggregate([
      { $match: {
        ...scopeMatch,
        status: LIVE_SALES_STATUSES,
        paymentStatus: { $in: ['pending', 'partial', 'overdue'] },
        balanceAmount: { $gt: 0 },
        customerName: { $exists: true, $nin: [null, ''] },
        $or: [{ dealer: null }, { dealer: { $exists: false } }],
      } },
      { $group: { _id: '$customerName', name: { $first: '$customerName' }, outstanding: { $sum: '$balanceAmount' }, count: { $sum: 1 } } },
      { $sort: { outstanding: -1 } }, { $limit: 8 },
    ]) : Promise.resolve([]),
  ]);

  const paymentFacets = paymentRows[0] || {};
  const modes = paymentFacets.today || [];
  const modeTotal = (selectedModes) => modes.filter((row) => selectedModes.includes(row._id)).reduce((sum, row) => sum + row.total, 0);
  const warnings = ['Overdue collection and credit-day alerts are unavailable because orders do not persist a reliable due date or maintained overdue state. Sales-executive collection is also unavailable because receipts do not store that branch-safe attribute.'];
  if (!canReadPayments) warnings.push('Collection receipts are hidden because payment or finance-report permission is required.');
  if (!canReadOutstanding) warnings.push('Outstanding balances and ageing are hidden because dealer-ledger or finance-report permission is required.');
  return {
    available: true,
    todayCollection: canReadPayments ? modes.reduce((sum, row) => sum + row.total, 0) : null,
    monthCollection: canReadPayments ? paymentFacets.month?.[0]?.total || 0 : null,
    cashCollection: canReadPayments ? modeTotal(['cash']) : null,
    chequeCollection: canReadPayments ? modeTotal(['cheque']) : null,
    bankCollection: canReadPayments ? modeTotal(['upi', 'neft', 'rtgs', 'card', 'adjustment']) : null,
    pendingCollection: canReadOutstanding ? balances.reduce((sum, row) => sum + row.outstanding, 0) : null,
    overdueCollection: null,
    pendingOrders: canReadOutstanding ? orderAging[0]?.pendingOrders || 0 : null,
    overdueOrders: null,
    dealerOutstanding: canReadOutstanding ? balances.slice(0, 8) : null,
    customerOutstanding: canReadOutstanding ? customerBalances : null,
    paymentModes: canReadPayments ? modes : null,
    billAging: canReadOutstanding ? {
      current: orderAging[0]?.current || 0,
      days31To60: orderAging[0]?.days31To60 || 0,
      days61To90: orderAging[0]?.days61To90 || 0,
      over90: orderAging[0]?.over90 || 0,
    } : null,
    salesExecutiveCollection: null,
    creditDaysExceededAlerts: null,
    warnings,
  };
};

const buildInventory = async (scopeMatch, periods) => {
  const valuationRate = { $cond: [{ $gt: ['$landingCost', 0] }, '$landingCost', '$purchaseRate'] };
  const [summary, productBalances, byWarehouse, aging] = await Promise.all([
    Stock.aggregate([
      { $match: scopeMatch },
      { $group: {
        _id: null,
        totalQty: { $sum: '$totalQty' }, availableQty: { $sum: '$availableQty' }, reservedQty: { $sum: '$reservedQty' },
        blockedQty: { $sum: '$blockedQty' }, transitQty: { $sum: '$transitQty' }, damagedQty: { $sum: '$damagedQty' }, sampleQty: { $sum: '$sampleQty' },
        stockValue: { $sum: { $multiply: ['$availableQty', valuationRate] } },
      } },
    ]),
    Stock.aggregate([
      { $match: scopeMatch },
      { $group: { _id: '$product', availableQty: { $sum: '$availableQty' } } },
      { $group: {
        _id: null,
        products: { $sum: 1 },
        lowStockProducts: { $sum: { $cond: [{ $and: [{ $gt: ['$availableQty', 0] }, { $lte: ['$availableQty', 10] }] }, 1, 0] } },
        outOfStockProducts: { $sum: { $cond: [{ $lte: ['$availableQty', 0] }, 1, 0] } },
      } },
    ]),
    Stock.aggregate([
      { $match: scopeMatch },
      { $group: { _id: '$warehouse', availableQty: { $sum: '$availableQty' }, stockValue: { $sum: { $multiply: ['$availableQty', valuationRate] } } } },
      { $lookup: { from: 'warehouses', localField: '_id', foreignField: '_id', as: 'warehouseInfo' } },
      { $project: { availableQty: 1, stockValue: 1, name: { $ifNull: [{ $first: '$warehouseInfo.name' }, 'Unknown warehouse'] } } },
      { $sort: { stockValue: -1 } },
    ]),
    Stock.aggregate([
      { $match: scopeMatch },
      { $project: { availableQty: 1, lastMovement: { $ifNull: ['$lastSaleDate', { $ifNull: ['$lastGRNDate', '$createdAt'] }] } } },
      { $project: { availableQty: 1, ageDays: { $dateDiff: { startDate: '$lastMovement', endDate: periods.now, unit: 'day' } } } },
      { $group: {
        _id: null,
        under30: { $sum: { $cond: [{ $lte: ['$ageDays', 30] }, '$availableQty', 0] } },
        days31To90: { $sum: { $cond: [{ $and: [{ $gt: ['$ageDays', 30] }, { $lte: ['$ageDays', 90] }] }, '$availableQty', 0] } },
        days91To180: { $sum: { $cond: [{ $and: [{ $gt: ['$ageDays', 90] }, { $lte: ['$ageDays', 180] }] }, '$availableQty', 0] } },
        over180: { $sum: { $cond: [{ $gt: ['$ageDays', 180] }, '$availableQty', 0] } },
      } },
    ]),
  ]);

  return {
    available: true,
    ...(summary[0] || { totalQty: 0, availableQty: 0, reservedQty: 0, blockedQty: 0, transitQty: 0, damagedQty: 0, sampleQty: 0, stockValue: 0 }),
    products: productBalances[0]?.products || 0,
    lowStockProducts: productBalances[0]?.lowStockProducts || 0,
    outOfStockProducts: productBalances[0]?.outOfStockProducts || 0,
    byWarehouse,
    aging: aging[0] || { under30: 0, days31To90: 0, days91To180: 0, over180: 0 },
    warnings: ['Fast/slow-moving classifications are unavailable without branch-safe stock movement velocity history; ageing uses the latest recorded sale or GRN date.'],
  };
};

const buildPurchase = async (scopeMatch, periods, user) => {
  const canReadPurchaseOrders = hasAnyPermission(user, ['po.management', 'reports.purchase']);
  const canReadGrn = hasAnyPermission(user, ['grn.entry', 'reports.purchase']);
  const canReadReturns = hasAnyPermission(user, ['debit.note', 'reports.purchase']);
  const canReadSupplierLedger = hasAnyPermission(user, ['supplier.ledger', 'reports.purchase']);
  const [poStatuses, grnStatuses, returns, supplierBalances] = await Promise.all([
    canReadPurchaseOrders ? PurchaseOrder.aggregate([{ $match: scopeMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : Promise.resolve([]),
    canReadGrn ? GRN.aggregate([{ $match: scopeMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : Promise.resolve([]),
    canReadReturns ? PurchaseReturn.aggregate([
      { $match: { ...scopeMatch, status: { $nin: ['draft', 'cancelled'] }, ...periodMatch('returnDate', periods.monthStart, periods.nextMonthStart) } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$grandTotal' } } },
    ]) : Promise.resolve([]),
    canReadSupplierLedger ? SupplierLedger.aggregate([
      { $match: scopeMatch },
      { $group: { _id: '$supplier', name: { $last: '$supplierName' }, outstanding: { $sum: { $subtract: [{ $ifNull: ['$credit', 0] }, { $ifNull: ['$debit', 0] }] } } } },
      { $match: { outstanding: { $gt: 0 } } },
      { $sort: { outstanding: -1 } },
    ]) : Promise.resolve([]),
  ]);
  const po = countById(poStatuses);
  const grn = countById(grnStatuses);
  const warnings = ['Supplier invoice and scheme-due KPIs are unavailable because no dashboard-safe branch-owned source exists for those legacy features.'];
  if (!canReadPurchaseOrders) warnings.push('Purchase-order metrics are hidden because PO or purchase-report permission is required.');
  if (!canReadGrn) warnings.push('GRN metrics are hidden because GRN or purchase-report permission is required.');
  if (!canReadSupplierLedger) warnings.push('Supplier outstanding is hidden because supplier-ledger or purchase-report permission is required.');
  return {
    available: true,
    pendingPurchaseOrders: canReadPurchaseOrders ? (po.draft || 0) + (po.pending_approval || 0) : null,
    approvedPurchaseOrders: canReadPurchaseOrders ? po.approved || 0 : null,
    goodsInTransit: canReadPurchaseOrders ? (po.sent || 0) + (po.partial_received || 0) : null,
    grnPending: canReadGrn ? (grn.draft || 0) + (grn.verified || 0) : null,
    purchaseReturns: canReadReturns ? returns[0]?.count || 0 : null,
    purchaseReturnValue: canReadReturns ? returns[0]?.total || 0 : null,
    supplierOutstanding: canReadSupplierLedger ? supplierBalances.reduce((sum, row) => sum + row.outstanding, 0) : null,
    topSupplierOutstanding: canReadSupplierLedger ? supplierBalances.slice(0, 8) : null,
    supplierInvoicesPending: null,
    supplierSchemeDue: null,
    warnings,
  };
};

const buildWarehouseDelivery = async (scopeMatch, periods, user) => {
  const canReadPicking = hasAnyPermission(user, ['picking.management']);
  const canReadSorting = hasAnyPermission(user, ['sorting.management']);
  const canReadDispatch = hasAnyPermission(user, ['dispatch.management']);
  const canReadDelivery = hasAnyPermission(user, ['delivery.management', 'delivery.tracking']);
  const canReadPickLists = canReadPicking || canReadSorting || canReadDispatch;
  const [pickRows, tripRows, deliveryRows, deliveredToday, pendingPod] = await Promise.all([
    canReadPickLists ? PickList.aggregate([{ $match: { ...scopeMatch, status: { $ne: 'cancelled' } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : Promise.resolve([]),
    canReadDispatch ? DispatchTrip.aggregate([{ $match: { ...scopeMatch, status: { $ne: 'cancelled' } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : Promise.resolve([]),
    canReadDelivery ? Delivery.aggregate([{ $match: scopeMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]) : Promise.resolve([]),
    canReadDelivery ? Delivery.countDocuments({ ...scopeMatch, status: { $in: ['delivered', 'partially_delivered'] }, ...periodMatch('completionTime', periods.today, periods.tomorrow) }) : Promise.resolve(0),
    canReadDelivery ? Delivery.countDocuments({ ...scopeMatch, status: { $in: ['delivered', 'partially_delivered'] }, $or: [{ podImage: '' }, { podImage: { $exists: false } }] }) : Promise.resolve(0),
  ]);
  const picks = countById(pickRows);
  const trips = countById(tripRows);
  const deliveries = countById(deliveryRows);
  return {
    available: true,
    awaitingPicking: canReadPicking ? (picks.generated || 0) + (picks.assigned || 0) : null,
    underPicking: canReadPicking ? picks.in_progress || 0 : null,
    underSorting: canReadSorting ? (picks.picked || 0) + (picks.verified || 0) + (picks.sorted || 0) : null,
    readyForDispatch: canReadSorting || canReadDispatch ? (picks.packed || 0) + (picks.ready_for_dispatch || 0) : null,
    vehiclesUnderLoading: canReadDispatch ? trips.loading || 0 : null,
    deliveriesInProgress: canReadDelivery ? (deliveries.assigned || 0) + (deliveries.in_transit || 0) + (deliveries.reached || 0) : null,
    deliveredToday: canReadDelivery ? deliveredToday : null,
    failedDeliveries: canReadDelivery ? deliveries.failed || 0 : null,
    rescheduledDeliveries: canReadDelivery ? deliveries.rescheduled || 0 : null,
    pendingPod: canReadDelivery ? pendingPod : null,
  };
};

const buildCrm = async (scopeMatch, periods, user) => {
  const canReadLeads = hasAnyPermission(user, ['lead.management', 'followup.management']);
  const canReadComplaints = userHasPermission(user, 'complaint.management');
  const activeLeadStatuses = ['won', 'lost'];
  const terminalComplaintStatuses = ['resolved', 'closed', 'rejected'];

  const [leadRows, recentLeads, complaintRows, recentComplaints] = await Promise.all([
    canReadLeads ? Lead.aggregate([
      { $match: scopeMatch },
      { $facet: {
        totals: [{ $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $in: ['$status', activeLeadStatuses] }, 0, 1] } },
          won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
          hot: { $sum: { $cond: [{ $and: [{ $eq: ['$priority', 'hot'] }, { $not: [{ $in: ['$status', activeLeadStatuses] }] }] }, 1, 0] } },
          unassigned: { $sum: { $cond: [{ $and: [{ $eq: ['$assignmentStatus', 'unassigned'] }, { $not: [{ $in: ['$status', activeLeadStatuses] }] }] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $and: [{ $eq: ['$assignmentStatus', 'pending'] }, { $not: [{ $in: ['$status', activeLeadStatuses] }] }] }, 1, 0] } },
        } }],
        today: [{ $match: periodMatch('createdAt', periods.today, periods.tomorrow) }, { $count: 'count' }],
        month: [{ $match: periodMatch('createdAt', periods.monthStart, periods.nextMonthStart) }, { $count: 'count' }],
        followupsToday: [{ $match: { status: { $nin: activeLeadStatuses }, ...periodMatch('nextFollowupDate', periods.today, periods.tomorrow) } }, { $count: 'count' }],
        overdueFollowups: [{ $match: { status: { $nin: activeLeadStatuses }, nextFollowupDate: { $lt: periods.today } } }, { $count: 'count' }],
        trend: [
          { $match: periodMatch('createdAt', periods.monthStart, periods.nextMonthStart) },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: DASHBOARD_TIMEZONE } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      } },
    ]) : Promise.resolve([]),
    canReadLeads ? Lead.find(scopeMatch)
      .select('leadNumber name businessName city priority status assignmentStatus assignedToName nextFollowupDate createdAt')
      .sort({ createdAt: -1 }).limit(8).lean() : Promise.resolve(null),
    canReadComplaints ? Complaint.aggregate([
      { $match: scopeMatch },
      { $facet: {
        totals: [{ $group: {
          _id: null,
          total: { $sum: 1 },
          open: { $sum: { $cond: [{ $in: ['$status', terminalComplaintStatuses] }, 0, 1] } },
          critical: { $sum: { $cond: [{ $and: [{ $eq: ['$priority', 'critical'] }, { $not: [{ $in: ['$status', terminalComplaintStatuses] }] }] }, 1, 0] } },
        } }],
        today: [{ $match: periodMatch('complaintDate', periods.today, periods.tomorrow) }, { $count: 'count' }],
        month: [{ $match: periodMatch('complaintDate', periods.monthStart, periods.nextMonthStart) }, { $count: 'count' }],
        trend: [
          { $match: periodMatch('complaintDate', periods.monthStart, periods.nextMonthStart) },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$complaintDate', timezone: DASHBOARD_TIMEZONE } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      } },
    ]) : Promise.resolve([]),
    canReadComplaints ? Complaint.find(scopeMatch)
      .select('complaintNumber dealerName category priority status assignedToName complaintDate createdAt')
      .sort({ complaintDate: -1, createdAt: -1 }).limit(8).lean() : Promise.resolve(null),
  ]);

  const lead = leadRows[0] || {};
  const leadTotals = lead.totals?.[0] || {};
  const complaints = complaintRows[0] || {};
  const complaintTotals = complaints.totals?.[0] || {};
  const warnings = [];
  if (!canReadLeads) warnings.push('Lead and follow-up metrics are hidden because lead-management permission is required.');
  if (!canReadComplaints) warnings.push('Complaint metrics are hidden because complaint-management permission is required.');

  return {
    available: true,
    totalLeads: canReadLeads ? leadTotals.total || 0 : null,
    todayLeads: canReadLeads ? lead.today?.[0]?.count || 0 : null,
    monthLeads: canReadLeads ? lead.month?.[0]?.count || 0 : null,
    activeLeads: canReadLeads ? leadTotals.active || 0 : null,
    wonLeads: canReadLeads ? leadTotals.won || 0 : null,
    lostLeads: canReadLeads ? leadTotals.lost || 0 : null,
    hotLeads: canReadLeads ? leadTotals.hot || 0 : null,
    unassignedLeads: canReadLeads ? leadTotals.unassigned || 0 : null,
    pendingLeads: canReadLeads ? leadTotals.pending || 0 : null,
    followupsToday: canReadLeads ? lead.followupsToday?.[0]?.count || 0 : null,
    overdueFollowups: canReadLeads ? lead.overdueFollowups?.[0]?.count || 0 : null,
    leadTrend: canReadLeads ? lead.trend || [] : null,
    recentLeads,
    totalComplaints: canReadComplaints ? complaintTotals.total || 0 : null,
    todayComplaints: canReadComplaints ? complaints.today?.[0]?.count || 0 : null,
    monthComplaints: canReadComplaints ? complaints.month?.[0]?.count || 0 : null,
    openComplaints: canReadComplaints ? complaintTotals.open || 0 : null,
    criticalComplaints: canReadComplaints ? complaintTotals.critical || 0 : null,
    complaintTrend: canReadComplaints ? complaints.trend || [] : null,
    recentComplaints,
    warnings,
  };
};

const buildHr = async (scopeMatch, employeeScopeMatch, periods, user) => {
  const canReadEmployees = hasAnyPermission(user, ['reports.hr', 'hrms.management', 'employee.registration']);
  const canReadAttendance = hasAnyPermission(user, ['reports.hr', 'hrms.management', 'attendance.master']);
  const canReadLeaves = hasAnyPermission(user, ['reports.hr', 'hrms.management', 'attendance.master', 'leave.management']);

  const [employeeRows, attendanceRows, pendingLeaves, upcomingLeaves, pendingLeaveRows, upcomingLeaveRows] = await Promise.all([
    canReadEmployees ? Employee.aggregate([
      { $match: employeeScopeMatch },
      { $facet: {
        totals: [{ $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
          inactive: { $sum: { $cond: [{ $eq: ['$status', 'Inactive'] }, 1, 0] } },
          onNotice: { $sum: { $cond: [{ $eq: ['$status', 'On Notice'] }, 1, 0] } },
          terminated: { $sum: { $cond: [{ $eq: ['$status', 'Terminated'] }, 1, 0] } },
        } }],
        departments: [{ $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
      } },
    ]) : Promise.resolve([]),
    canReadAttendance ? Attendance.aggregate([
      { $match: { ...scopeMatch, ...periodMatch('date', periods.today, periods.tomorrow) } },
      { $group: { _id: '$status', count: { $sum: 1 }, totalHours: { $sum: { $ifNull: ['$totalHours', 0] } } } },
      { $sort: { count: -1, _id: 1 } },
    ]) : Promise.resolve(null),
    canReadLeaves ? Leave.countDocuments({ ...scopeMatch, status: 'Pending' }) : Promise.resolve(null),
    canReadLeaves ? Leave.countDocuments({ ...scopeMatch, status: 'Approved', toDate: { $gte: periods.today } }) : Promise.resolve(null),
    canReadLeaves ? Leave.find({ ...scopeMatch, status: 'Pending' })
      .select('employee leaveType fromDate toDate days reason createdAt').populate('employee', 'name empId department')
      .sort({ createdAt: -1 }).limit(6).lean() : Promise.resolve(null),
    canReadLeaves ? Leave.find({ ...scopeMatch, status: 'Approved', toDate: { $gte: periods.today } })
      .select('employee leaveType fromDate toDate days').populate('employee', 'name empId department')
      .sort({ fromDate: 1 }).limit(6).lean() : Promise.resolve(null),
  ]);

  const employees = employeeRows[0] || {};
  const employeeTotals = employees.totals?.[0] || {};
  const warnings = [];
  if (!canReadEmployees) warnings.push('Employee metrics are hidden because employee or HR-report permission is required.');
  if (!canReadAttendance) warnings.push('Attendance metrics are hidden because attendance or HR-report permission is required.');
  if (!canReadLeaves) warnings.push('Leave metrics are hidden because leave or HR-report permission is required.');

  return {
    available: true,
    totalEmployees: canReadEmployees ? employeeTotals.total || 0 : null,
    activeEmployees: canReadEmployees ? employeeTotals.active || 0 : null,
    inactiveEmployees: canReadEmployees ? employeeTotals.inactive || 0 : null,
    onNoticeEmployees: canReadEmployees ? employeeTotals.onNotice || 0 : null,
    terminatedEmployees: canReadEmployees ? employeeTotals.terminated || 0 : null,
    departments: canReadEmployees ? employees.departments || [] : null,
    attendanceToday: canReadAttendance ? attendanceRows.reduce((sum, row) => sum + row.count, 0) : null,
    attendanceByStatus: attendanceRows,
    pendingLeaves,
    upcomingLeaves,
    pendingLeaveRows,
    upcomingLeaveRows,
    warnings,
  };
};

const buildActivity = async (scopeMatch, periods) => {
  const [rows = {}, recentLogs] = await Promise.all([
    ActivityLog.aggregate([
      { $match: scopeMatch },
      { $facet: {
        today: [{ $match: periodMatch('timestamp', periods.today, periods.tomorrow) }, { $count: 'count' }],
        period: [{ $match: periodMatch('timestamp', periods.weekStart, periods.tomorrow) }, { $count: 'count' }],
        actions: [
          { $match: periodMatch('timestamp', periods.weekStart, periods.tomorrow) },
          { $group: { _id: '$action', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } },
        ],
        modules: [
          { $match: periodMatch('timestamp', periods.weekStart, periods.tomorrow) },
          { $group: { _id: '$module', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 10 },
        ],
      } },
    ]),
    ActivityLog.find(scopeMatch)
      .select('userName userRole action module recordTitle description device timestamp branch')
      .sort({ timestamp: -1 }).limit(10).lean(),
  ]);

  return {
    available: true,
    todayCount: rows.today?.[0]?.count || 0,
    periodCount: rows.period?.[0]?.count || 0,
    periodLabel: 'Last 7 days',
    actionDistribution: rows.actions || [],
    moduleDistribution: rows.modules || [],
    recentLogs,
    warnings: [],
  };
};

const buildProfitability = async (scopeMatch, periods) => {
  const [sales, returns] = await Promise.all([
    SalesOrder.aggregate([
      { $match: { ...scopeMatch, status: LIVE_SALES_STATUSES, ...periodMatch('orderDate', periods.monthStart, periods.nextMonthStart) } },
      { $group: { _id: null, grossSales: { $sum: '$grandTotal' }, discounts: { $sum: '$totalDiscount' }, tax: { $sum: '$totalTax' } } },
    ]),
    SalesReturn.aggregate([
      { $match: { ...scopeMatch, status: { $nin: ['draft', 'cancelled'] }, ...periodMatch('returnDate', periods.monthStart, periods.nextMonthStart) } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]),
  ]);
  const grossSales = sales[0]?.grossSales || 0;
  const salesReturns = returns[0]?.total || 0;
  return {
    available: true,
    grossSales,
    salesReturns,
    netSales: grossSales - salesReturns,
    discounts: sales[0]?.discounts || 0,
    tax: sales[0]?.tax || 0,
    grossProfit: null,
    estimatedNetProfit: null,
    categoryMargin: null,
    productMargin: null,
    dealerProfitability: null,
    warnings: ['Profit and margin KPIs are unavailable: sales lines do not retain immutable historical COGS. Revenue is live, but current stock rates are not presented as audited profit.'],
  };
};

export const getDashboardReport = async (req, res) => {
  const requestedScope = req.query.scope || 'branch';
  if (!['branch', 'all'].includes(requestedScope)) {
    return res.status(400).json({ success: false, message: 'scope must be branch or all.' });
  }
  if (requestedScope === 'all' && !req.hasGlobalBranchAccess) {
    return res.status(403).json({ success: false, message: 'All-branch dashboard access is limited to owners and super administrators.' });
  }

  const branchIds = requestedScope === 'all'
    ? (req.user.assignedBranches || []).map((branch) => branch?._id || branch).filter(Boolean)
    : [req.branchId];
  if (!branchIds.length) {
    return res.status(428).json({ success: false, code: 'BRANCH_REQUIRED', message: 'No active branches are available for this dashboard scope.' });
  }

  const scopeMatch = requestedScope === 'all' ? { branch: { $in: branchIds } } : { branch: req.branchId };
  const employeeScopeMatch = requestedScope === 'all' ? { branchId: { $in: branchIds } } : { branchId: req.branchId };
  const periods = getPeriods();
  const tasks = [];
  const queue = (name, permissions, builder) => {
    if (hasAnyPermission(req.user, permissions)) tasks.push(builder().then((value) => ({ name, value })));
  };

  queue('sales', SECTION_PERMISSIONS.sales, () => buildSales(scopeMatch, periods, req.user));
  queue('collections', SECTION_PERMISSIONS.collections, () => buildCollections(scopeMatch, periods, req.user));
  queue('inventory', SECTION_PERMISSIONS.inventory, () => buildInventory(scopeMatch, periods));
  queue('purchase', SECTION_PERMISSIONS.purchase, () => buildPurchase(scopeMatch, periods, req.user));
  queue('crm', SECTION_PERMISSIONS.crm, () => buildCrm(scopeMatch, periods, req.user));
  queue('hr', SECTION_PERMISSIONS.hr, () => buildHr(scopeMatch, employeeScopeMatch, periods, req.user));
  queue('warehouseDelivery', SECTION_PERMISSIONS.warehouseDelivery, () => buildWarehouseDelivery(scopeMatch, periods, req.user));
  queue('profitability', SECTION_PERMISSIONS.profitability, () => buildProfitability(scopeMatch, periods));
  queue('activity', SECTION_PERMISSIONS.activity, () => buildActivity(scopeMatch, periods));

  const allowedApprovalTypes = Object.entries(APPROVAL_TYPE_PERMISSIONS)
    .filter(([, permission]) => userHasPermission(req.user, permission))
    .map(([type]) => type);
  if (allowedApprovalTypes.length) {
    tasks.push(Promise.all([
      ApprovalRequest.countDocuments({ ...scopeMatch, type: { $in: allowedApprovalTypes }, status: 'pending' }),
      ApprovalRequest.find({ ...scopeMatch, type: { $in: allowedApprovalTypes }, status: 'pending' })
        .select('requestNumber type title priority requestedByName referenceNumber createdAt')
        .sort({ priority: -1, createdAt: -1 }).limit(8).lean(),
    ]).then(([pending, recent]) => ({ name: 'approvals', value: { available: true, pending, recent } })));
  }

  const unavailable = [];
  if (hasAnyPermission(req.user, SECTION_PERMISSIONS.crm)) {
    const warning = 'CRM dashboard data is unavailable because Lead and embedded follow-ups have no branch ownership.';
    unavailable.push({ name: 'crm', value: { available: false, data: null, warnings: [warning] } });
  }
  if (hasAnyPermission(req.user, SECTION_PERMISSIONS.hr)) {
    const warning = 'HR dashboard data is unavailable because Attendance and Leave have no branch ownership and Employee uses a legacy text branch.';
    unavailable.push({ name: 'hr', value: { available: false, data: null, warnings: [warning] } });
  }
  if (hasAnyPermission(req.user, SECTION_PERMISSIONS.activity)) {
    const warning = 'Recent activity is unavailable because ActivityLog does not store an attributable branch.';
    unavailable.push({ name: 'activity', value: { available: false, data: null, warnings: [warning] } });
  }

  const resolved = [...await Promise.all(tasks), ...unavailable];
  const sections = Object.fromEntries(resolved.map(({ name, value }) => [name, value]));
  const warnings = resolved.flatMap(({ name, value }) => (value.warnings || []).map((message) => ({ section: name, message })));
  const metadata = {
    branch: req.branch ? { _id: req.branch._id, branchCode: req.branch.branchCode, name: req.branch.name } : null,
    scope: requestedScope,
    branchCount: branchIds.length,
    timezone: DASHBOARD_TIMEZONE,
    generatedAt: new Date().toISOString(),
    warnings,
  };

  const compatibility = {};
  if (sections.sales) Object.assign(compatibility, {
    todaySales: sections.sales.todaySales,
    todayOrders: sections.sales.todayOrders,
    monthSales: sections.sales.monthSales,
    monthOrders: sections.sales.monthOrders,
    monthGrowth: sections.sales.monthGrowth,
    pendingOrders: sections.sales.pendingOrders,
    weeklySalesTrend: sections.sales.weeklyTrend,
  });
  if (sections.inventory) Object.assign(compatibility, { totalStock: sections.inventory.availableQty, stockValue: sections.inventory.stockValue });
  if (sections.collections) Object.assign(compatibility, { pendingPayments: sections.collections.pendingCollection, pendingPaymentsCount: sections.collections.pendingOrders });

  return res.json({ success: true, data: { metadata, sections, ...compatibility } });
};
