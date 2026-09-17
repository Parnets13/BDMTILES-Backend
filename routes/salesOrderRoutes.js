import { Router } from 'express';
import mongoose from 'mongoose';
import SalesOrder from '../models/SalesOrder.js';
import Branch from '../models/Branch.js';
import Dealer from '../models/Dealer.js';
import DealerLedger from '../models/DealerLedger.js';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import DealerType from '../models/DealerType.js';
import Delivery from '../models/Delivery.js';
import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { deriveOrderPricing, addCreditApproval } from '../services/orderPricingService.js';
import { getDealerCreditExposure } from '../services/dealerCreditService.js';
import { resolvePricing } from '../services/pricingResolver.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, getAssignedBranchIds, hasGlobalBranchAccess, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';
import { syncAutomaticApprovalRequest, approvalExposureFingerprint } from '../services/approvalRequestService.js';
import { releaseSalesOrderInventory, reserveSalesOrderInventory, refreshSalesOrderLine, QUANTITY_TOLERANCE } from '../utils/salesOrderInventory.js';
import { applyStockMovement, stockOperationKey } from '../services/stockMovementService.js';
import { stableUomSnapshot } from '../services/stockUomService.js';
import { actionSalesOrderRemainingCancellation } from '../services/salesOrderRemainingCancellationService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const requireSalesOrderStatusPermission = (req, res, next) =>
  requireAnyPermission(['sales.order.create', 'sales.order.dashboard', 'dispatch.management'])(req, res, next);

const SALES_ORDER_STATUSES = new Set([
  'draft', 'confirmed', 'approved', 'processing', 'partial_dispatch', 'partially_closed',
  'dispatched', 'delivered', 'cancelled', 'expired',
]);
const DIRECT_STATUS_FLOW = [
  'draft', 'confirmed', 'approved', 'processing',
  'partial_dispatch', 'dispatched', 'delivered',
];
// MERGE NOTE (integration of origin/main):
// origin/main allowed free-form status jumps here (confirmed -> dispatched, etc.).
// That path is kept CLOSED deliberately: every transition past `confirmed` also has
// to move stock, reservations and dispatch records, which only the dedicated
// endpoints do. Allowing a generic PATCH to set `status` would skip that and leave
// inventory out of step with the order. Transitions therefore go through their own
// endpoints, and this map stays locked.
const USER_STATUS_TRANSITIONS = {
  draft: new Set(['confirmed', 'cancelled']), confirmed: new Set([]),
  approved: new Set([]), processing: new Set([]),
  partial_dispatch: new Set([]), partially_closed: new Set([]), dispatched: new Set([]), delivered: new Set([]),
  cancelled: new Set([]), expired: new Set([]),
};
const SERVER_MANAGED_ORDER_FIELDS = new Set([
  'orderNumber', 'branch', 'legacyBranch', 'createdBy', 'status', 'paymentStatus',
  'subtotal', 'totalDiscount', 'totalSchemeDiscount', 'totalTax', 'roundOff', 'grandTotal', 'balanceAmount',
  'dealerTypeSnapshot', 'dealerName', 'dealerCode', 'creditLimitExceeded', 'approvalStatus', 'approvalReasons',
  'approvedBy', 'approvalDate', 'approvalRemarks', 'confirmationRequested', 'reservationStatus', 'reservedAt',
  'reservationReleasedAt', 'reservationConsumedAt', 'reservationExpiresAt', 'reservationExpiryVersion', 'reservationExpiryState',
  'reservationExpiredAt', 'reservationExpiryReason', 'reservationExtensions', 'cancellationRequestStatus', 'cancellationApprovalRequest',
  'cancellationRequestedAt', 'cancellationRequestedBy', 'remainingCancellationStatus', 'remainingCancellationApprovalRequest',
  'remainingCancellationRequestedAt', 'remainingCancellationRequestedBy', 'remainingCancellationReviewedAt', 'remainingCancellationReviewedBy',
  'remainingCancellationReason', 'remainingCancellationVersion', 'closureFinancialSummary', 'sourceQuotation', 'sourceKey', 'requestFingerprint', 'cancellationReason', 'modificationLogs',
  'tallySyncStatus', 'tallyVoucherNumber', 'tallyGUID', 'tallySyncDate', 'tallySyncError',
  'createdAt', 'updatedAt', '_id', '__v',
]);
const CONVERTED_ORDER_OPERATIONAL_FIELDS = new Set([
  'deliveryAddress', 'expectedDeliveryDate', 'deliveryPriority', 'salesExecutive', 'remarks', 'internalNotes',
]);
const validationError = (message) => Object.assign(new Error(message), { status: 422 });
const salesOrderActorScope = req => req.user.role === 'sales_executive'
  ? { $or: [{ salesExecutive: req.user._id }, { createdBy: req.user._id }] }
  : {};
function withoutServerManagedFields(body = {}) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SERVER_MANAGED_ORDER_FIELDS.has(key)));
}
async function findDealer(dealerId, session = null) {
  if (!dealerId || !mongoose.isValidObjectId(dealerId)) return null;
  let query = Dealer.findById(dealerId).populate('dealerType', 'name pricingTier status');
  if (session) query = query.session(session);
  const dealer = await query.lean();
  if (dealer && dealer.status !== 'active') throw validationError('Dealer is not active.');
  if (dealer?.dealerType && dealer.dealerType.status !== 'active') throw validationError('DealerType is not active.');
  return dealer;
}
async function getBranchOutstanding(branchId, dealerId, session = null) {
  let aggregate = DealerLedger.aggregate([
    { $match: { branch: branchId, dealer: dealerId } },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  if (session) aggregate = aggregate.session(session);
  const [branchLedger] = await aggregate;
  return Number((branchLedger?.debit || 0) - (branchLedger?.credit || 0));
}
function pricingContext(data, dealer) {
  if (dealer) {
    return {
      dealerId: dealer._id,
      dealerTypeId: dealer.dealerType?._id,
      scope: 'dealer',
      orderType: data.orderType || 'dealer',
    };
  }
  if (data.dealerType) {
    return { dealerTypeId: data.dealerType, scope: 'dealer_type', orderType: data.orderType || 'retail' };
  }
  return { scope: 'walk_in', orderType: data.orderType === 'online' ? 'online' : 'retail' };
}
async function authoritativeOrderData(data, dealer, branchOutstanding, branchId, session, existingReasons = []) {
  const context = pricingContext(data, dealer);
  const priced = await deriveOrderPricing({
    branchId, ...context, pricingDate: data.orderDate || new Date(), items: data.items,
    freightCharges: data.freightCharges, loadingCharges: data.loadingCharges,
    installationCharges: data.installationCharges, otherCharges: data.otherCharges,
    advanceAmount: data.advanceAmount, existingApprovalReasons: existingReasons,
    preserveBelowMinimumApprovals: existingReasons.length > 0, session,
  });
  const creditExposure = dealer ? await getDealerCreditExposure({
    branchId, dealer, asOf: data.orderDate || new Date(), session,
  }) : null;
  const credit = addCreditApproval(priced, dealer, branchOutstanding, existingReasons, {
    preserveBelowMinimum: existingReasons.length > 0,
    creditExposure,
  });
  return {
    ...priced,
    dealerType: dealer?.dealerType?._id || priced.dealerType,
    dealerTypeSnapshot: dealer?.dealerType
      ? { name: dealer.dealerType.name, pricingTier: dealer.dealerType.pricingTier }
      : priced.dealerTypeSnapshot,
    ...credit,
    resolutions: undefined,
  };
}

async function authorizedOrderBranches(req) {
  const requested = req.query.branch || req.query.branchId;
  if (!requested) return [req.branchId];
  const assigned = getAssignedBranchIds(req.user);
  const globalAccess = hasGlobalBranchAccess(req.user);
  const canCrossBranch = globalAccess || (req.user.permissions || []).includes('*');
  const requestedIds = String(requested).toLowerCase() === 'all'
    ? globalAccess
      ? (await Branch.find({ status: 'active' }).distinct('_id')).map(String)
      : assigned
    : [...new Set(String(requested).split(',').map(value => value.trim()).filter(Boolean))];
  if (!requestedIds.length || requestedIds.some(id => !mongoose.isValidObjectId(id))) {
    throw Object.assign(new Error('One or more branch filters are invalid.'), { status: 422 });
  }
  const activeBranchCount = await Branch.countDocuments({ _id: { $in: requestedIds }, status: 'active' });
  if (activeBranchCount !== requestedIds.length) {
    throw Object.assign(new Error('One or more Sales Order branches are unavailable.'), { status: 422 });
  }
  const activeBranch = String(req.branchId);
  const isCrossBranch = requestedIds.length !== 1 || requestedIds[0] !== activeBranch;
  if (isCrossBranch && !canCrossBranch) throw Object.assign(new Error('Cross-branch Sales Order access is not permitted.'), { status: 403 });
  if (!globalAccess && requestedIds.some(id => !assigned.includes(String(id)))) {
    throw Object.assign(new Error('Sales Order branch filter exceeds assigned branches.'), { status: 403 });
  }
  return requestedIds.map(id => new mongoose.Types.ObjectId(id));
}

router.get('/', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const {
      page = 1, limit = 20, search, status, dealer, dealerType, customerName, customer,
      product, category, region, deliveryStatus, paymentStatus, approvalStatus, reservationStatus,
      orderType, deliveryPriority, cancellationRequestStatus, tallySyncStatus,
      dateFrom, dateTo, expectedDeliveryFrom, expectedDeliveryTo, salesExecutive,
      sourceQuotation, source, amountMin, amountMax, sortBy = 'createdAt', sortOrder = 'desc',
    } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const enumFilter = (value, allowed, field) => {
      if (value === undefined || value === null || value === '') return null;
      const values = String(value).split(',').map(entry => entry.trim()).filter(Boolean);
      if (!values.length || values.some(entry => !allowed.includes(entry))) {
        throw validationError(`${field} contains an unsupported value.`);
      }
      return values.length === 1 ? values[0] : { $in: values };
    };
    const objectIdFilter = (value, field) => {
      if (value && !mongoose.isValidObjectId(value)) throw validationError(`${field} is invalid.`);
      return value;
    };
    const dateRange = (from, to, field) => {
      if (!from && !to) return null;
      const range = {};
      if (from) {
        const start = new Date(from);
        if (Number.isNaN(start.getTime())) throw validationError(`${field} from date is invalid.`);
        range.$gte = start;
      }
      if (to) {
        const end = new Date(to);
        if (Number.isNaN(end.getTime())) throw validationError(`${field} to date is invalid.`);
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) end.setUTCHours(23, 59, 59, 999);
        range.$lte = end;
      }
      if (range.$gte && range.$lte && range.$gte.getTime() > range.$lte.getTime()) {
        throw validationError(`${field} from date cannot be after to date.`);
      }
      return range;
    };
    const amountRange = (minimumValue, maximumValue) => {
      const hasMinimum = minimumValue !== undefined && String(minimumValue).trim() !== '';
      const hasMaximum = maximumValue !== undefined && String(maximumValue).trim() !== '';
      if (!hasMinimum && !hasMaximum) return null;
      const minimum = hasMinimum ? Number(minimumValue) : null;
      const maximum = hasMaximum ? Number(maximumValue) : null;
      if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0)) throw validationError('amountMin is invalid.');
      if (maximum !== null && (!Number.isFinite(maximum) || maximum < 0)) throw validationError('amountMax is invalid.');
      if (minimum !== null && maximum !== null && minimum > maximum) {
        throw validationError('amountMin cannot be greater than amountMax.');
      }
      return {
        ...(minimum !== null ? { $gte: minimum } : {}),
        ...(maximum !== null ? { $lte: maximum } : {}),
      };
    };
    [dealer, dealerType, product, category, region, salesExecutive, sourceQuotation].forEach((value, index) => {
      objectIdFilter(value, ['dealer', 'dealerType', 'product', 'category', 'region', 'salesExecutive', 'sourceQuotation'][index]);
    });
    const allowedSorts = ['createdAt', 'updatedAt', 'orderDate', 'expectedDeliveryDate', 'orderNumber', 'grandTotal'];
    if (!allowedSorts.includes(sortBy)) throw validationError('Unsupported Sales Order sort field.');
    if (!['asc', 'desc'].includes(sortOrder)) throw validationError('sortOrder must be asc or desc.');
    const branchIds = await authorizedOrderBranches(req);
    const filter = {
      branch: branchIds.length === 1 ? branchIds[0] : { $in: branchIds },
      ...salesOrderActorScope(req),
    };
    const conditions = [];
    const addTextCondition = (value, fields) => {
      if (!value) return;
      const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      conditions.push({ $or: fields.map(field => ({ [field]: regex })) });
    };
    addTextCondition(search, ['orderNumber', 'dealerName', 'dealerCode', 'customerName']);
    addTextCondition(customerName, ['customerName', 'dealerName']);
    addTextCondition(customer, ['customerName', 'dealerName', 'dealerCode']);
    const statusValue = enumFilter(status, [...SALES_ORDER_STATUSES], 'status');
    if (statusValue) filter.status = statusValue;
    if (dealer) conditions.push({ dealer });
    if (dealerType) filter.dealerType = dealerType;
    const paymentValue = enumFilter(paymentStatus, ['pending', 'partial', 'paid', 'overdue'], 'paymentStatus');
    if (paymentValue) filter.paymentStatus = paymentValue;
    const approvalValue = enumFilter(approvalStatus, ['not_required', 'pending', 'approved', 'rejected'], 'approvalStatus');
    if (approvalValue) filter.approvalStatus = approvalValue;
    const reservationValue = enumFilter(reservationStatus, ['none', 'reserving', 'reserved', 'partial', 'released', 'consumed'], 'reservationStatus');
    if (reservationValue) filter.reservationStatus = reservationValue;
    const orderTypeValue = enumFilter(orderType, ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', 'online', 'project'], 'orderType');
    if (orderTypeValue === 'online') {
      // From origin/main: storefront orders are those explicitly marked 'online',
      // plus legacy rows written before the field existed — retail/unset orderType
      // carrying a customer name and no dealer. Kept behind enum validation.
      conditions.push({
        $or: [
          { orderType: 'online' },
          {
            orderType: { $in: [null, 'retail'] },
            customerName: { $exists: true, $ne: '' },
            dealer: { $in: [null, undefined] },
          },
        ],
      });
    } else if (orderTypeValue) {
      filter.orderType = orderTypeValue;
    }
    const priorityValue = enumFilter(deliveryPriority, ['normal', 'urgent', 'vip'], 'deliveryPriority');
    if (priorityValue) filter.deliveryPriority = priorityValue;
    const cancellationValue = enumFilter(cancellationRequestStatus, ['none', 'pending', 'approved', 'rejected'], 'cancellationRequestStatus');
    if (cancellationValue) filter.cancellationRequestStatus = cancellationValue;
    const tallyValue = enumFilter(tallySyncStatus, ['not_synced', 'pending', 'synced', 'failed'], 'tallySyncStatus');
    if (tallyValue) filter.tallySyncStatus = tallyValue;
    if (salesExecutive) filter.salesExecutive = salesExecutive;
    if (sourceQuotation && source === 'legacy_direct') {
      throw validationError('sourceQuotation cannot be combined with source=legacy_direct.');
    }
    if (sourceQuotation) filter.sourceQuotation = sourceQuotation;
    if (source === 'quotation' && !sourceQuotation) filter.sourceQuotation = { $type: 'objectId' };
    else if (source === 'legacy_direct') conditions.push({ $or: [{ sourceQuotation: null }, { sourceQuotation: { $exists: false } }] });
    else if (source && source !== 'quotation') throw validationError('source must be quotation or legacy_direct.');
    if (product) conditions.push({ 'items.product': product });
    if (category) {
      const productIds = await Product.find({ category }).distinct('_id');
      conditions.push({ 'items.product': { $in: productIds } });
    }
    if (region) {
      const dealerIds = await Dealer.find({ assignedRegion: region }).distinct('_id');
      conditions.push({ dealer: { $in: dealerIds } });
    }
    if (deliveryStatus) {
      const deliveryStatusValue = enumFilter(
        deliveryStatus,
        ['assigned', 'in_transit', 'reached', 'delivered', 'partially_delivered', 'failed', 'rescheduled', 'returned'],
        'deliveryStatus',
      );
      const deliveryOrderIds = await Delivery.find({
        branch: filter.branch,
        status: deliveryStatusValue,
      }).distinct('salesOrder');
      filter._id = { $in: deliveryOrderIds };
    }
    if (conditions.length) filter.$and = conditions;
    const orderDateRange = dateRange(dateFrom, dateTo, 'orderDate');
    if (orderDateRange) filter.orderDate = orderDateRange;
    const deliveryDateRange = dateRange(expectedDeliveryFrom, expectedDeliveryTo, 'expectedDeliveryDate');
    if (deliveryDateRange) filter.expectedDeliveryDate = deliveryDateRange;
    const totals = amountRange(amountMin, amountMax);
    if (totals) filter.grandTotal = totals;
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortDirection, _id: sortDirection };
    const [orders, total] = await Promise.all([
      SalesOrder.find(filter).sort(sort).skip((p - 1) * l).limit(l)
        .populate('branch', 'branchCode name city state').populate('dealer', 'businessName dealerCode mobile city assignedRegion')
        .populate('dealerType', 'name pricingTier').populate('salesExecutive', 'name email phone')
        .populate('sourceQuotation', 'quotationNumber quotationDate validUntil status conversionState validityVersion convertedAt').lean(),
      SalesOrder.countDocuments(filter),
    ]);
    return res.json({ success: true, data: orders, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

router.get('/stats', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const branchIds = await authorizedOrderBranches(req);
    const scope = {
      branch: branchIds.length === 1 ? branchIds[0] : { $in: branchIds },
      ...salesOrderActorScope(req),
    };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const statusCountsPromise = SalesOrder.aggregate([
      { $match: scope },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const todayOrdersPromise = SalesOrder.aggregate([
      {
        $match: {
          ...scope,
          orderDate: { $gte: today, $lt: tomorrow },
          status: { $in: ['confirmed', 'approved', 'processing', 'partial_dispatch', 'dispatched', 'delivered'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    ]);
    const [total, statusRows, todayOrders] = await Promise.all([
      SalesOrder.countDocuments(scope),
      statusCountsPromise,
      todayOrdersPromise,
    ]);
    const counts = Object.fromEntries(statusRows.map(row => [row._id, row.count]));
    return res.json({
      success: true,
      data: {
        total,
        draft: counts.draft || 0,
        confirmed: counts.confirmed || 0,
        approved: counts.approved || 0,
        processing: counts.processing || 0,
        partialDispatch: counts.partial_dispatch || 0,
        dispatched: counts.dispatched || 0,
        delivered: counts.delivered || 0,
        cancelled: counts.cancelled || 0,
        expired: counts.expired || 0,
        todaySales: todayOrders[0]?.total || 0,
        todayCount: todayOrders[0]?.count || 0,
      },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

router.get('/search-dealers', requireAnyPermission('sales.order.create', 'quotation.management'), async (req, res) => {
  try {
    const { q, page = 1, limit = 20, pricingTier, dealerTypeId } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Number.parseInt(limit, 10) || 20);
    const filter = { status: 'active' };
    const assignmentScope = req.user.assignmentScopes || {};
    const broadDealerAccess = ['super_admin', 'owner', 'admin'].includes(req.user.role)
      || assignmentScope.dealers === 'all'
      || assignmentScope.regions === 'all';
    if (!broadDealerAccess) {
      const assignedDealers = (req.user.assignedDealers || []).map(value => value?._id || value).filter(Boolean);
      const assignedRegions = (req.user.assignedRegions || []).map(value => value?._id || value).filter(Boolean);
      filter.$and = [{
        $or: [
          ...(assignedDealers.length ? [{ _id: { $in: assignedDealers } }] : []),
          ...(assignedRegions.length ? [{ assignedRegion: { $in: assignedRegions } }] : []),
          { assignedSalesExecutive: req.user._id },
        ],
      }];
    }
    if (q && q.length >= 2) {
      const regex = new RegExp(q, 'i');
      filter.$or = [{ businessName: regex }, { dealerCode: regex }, { mobile: regex }, { ownerName: regex }];
    }
    if (dealerTypeId) {
      if (!mongoose.isValidObjectId(dealerTypeId)) throw validationError('dealerTypeId is invalid.');
      filter.dealerType = dealerTypeId;
    } else if (pricingTier) {
      const matchingTypes = await DealerType.find({ pricingTier, status: 'active' }).select('_id').lean();
      if (!matchingTypes.length) return res.json({ success: true, data: [] });
      filter.dealerType = { $in: matchingTypes.map((type) => type._id) };
    }
    const dealers = await Dealer.find(filter).sort({ businessName: 1 }).skip((p - 1) * l).limit(l)
      .select('businessName dealerCode ownerName mobile city creditLimit creditDays currentOutstanding priceTier dealerType')
      .populate('dealerType', 'name pricingTier').lean();
    return res.json({ success: true, data: dealers });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.get('/search-products', requireAnyPermission('sales.order.create', 'quotation.management'), async (req, res) => {
  try {
    const { q, brand, category, subcategory, page = 1, limit = 20, dealerId, dealerTypeId, scope } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Number.parseInt(limit, 10) || 20);
    const filter = { status: 'active' };
    if (q && q.length >= 2) {
      const regex = new RegExp(q, 'i');
      filter.$or = [{ itemName: regex }, { productCode: regex }, { aliasName: regex }, { barcode: regex }];
    }
    if (brand) filter.brand = brand;
    if (category) filter.category = category;
    if (subcategory) filter.subcategory = subcategory;
    const products = await Product.find(filter).sort({ itemName: 1 }).skip((p - 1) * l).limit(l)
      .select('productCode itemName tileSize finish colour unit mrp dealerRate wholesaleRate retailRate distributorRate builderRate projectRate minimumSellingRate gst piecesPerBox sqftPerBox images brand category subcategory status')
      .populate('brand', 'name').populate('category', 'name').populate('subcategory', 'name').lean();
    const productIds = products.map((product) => product._id);
    const stockData = await Stock.aggregate([
      { $match: { branch: req.branchId, product: { $in: productIds } } },
      { $group: { _id: '$product', availableQty: { $sum: '$availableQty' } } },
    ]);
    const stockMap = new Map(stockData.map((row) => [String(row._id), row.availableQty]));
    const quantity = req.query.quantity || 1;
    const legacyOrderType = req.query.dealerType && !mongoose.isValidObjectId(req.query.dealerType)
      ? req.query.dealerType : undefined;
    const inferredScope = scope || (dealerId ? 'dealer' : dealerTypeId ? 'dealer_type' : 'walk_in');
    const data = await Promise.all(products.map(async (product) => {
      const pricing = await resolvePricing({
        branchId: req.branchId, dealerId, dealerTypeId, scope: inferredScope, product,
        quantity, pricingDate: req.query.date || new Date(), orderAmount: req.query.orderAmount,
        orderType: legacyOrderType || (inferredScope === 'walk_in' ? 'retail' : 'dealer'),
      });
      return {
        ...product,
        stockAvailable: stockMap.get(String(product._id)) || 0,
        baseTier: pricing.requestedTier,
        rateField: pricing.rateField,
        baseRate: pricing.baseRate,
        effectiveRate: pricing.effectiveRate,
        minimumSellingRate: pricing.minimumSellingRate,
        belowMinimum: pricing.belowMinimum,
        pricingSource: pricing.source,
        overrideScope: pricing.overrideScope,
        discount: {
          regularPerUnit: pricing.regularDiscountPerUnit,
          schemePerUnit: pricing.schemeDiscountPerUnit,
          rule: pricing.rule,
        },
      };
    }));
    return res.json({ success: true, data });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

router.post('/price-preview', requireAnyPermission('sales.order.create', 'quotation.management'), async (req, res) => {
  try {
    const data = withoutServerManagedFields(req.body);
    const dealer = data.dealer ? await findDealer(data.dealer) : null;
    if (data.dealer && !dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });
    if (!dealer && !data.customerName) throw validationError('customerName is required for walk-in sales.');
    const outstanding = dealer ? await getBranchOutstanding(req.branchId, dealer._id) : 0;
    const priced = await authoritativeOrderData(data, dealer, outstanding, req.branchId, null, []);
    return res.json({ success: true, data: priced });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

router.get('/:id', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw validationError('Sales Order id is invalid.');
    const branchIds = await authorizedOrderBranches(req);
    const order = await SalesOrder.findOne({
      _id: req.params.id,
      branch: branchIds.length === 1 ? branchIds[0] : { $in: branchIds },
      ...salesOrderActorScope(req),
    })
      .populate('branch', 'branchCode name city state address phone email gstin')
      .populate('dealer', 'businessName dealerCode ownerName mobile email city state creditLimit creditDays currentOutstanding gstin address assignedRegion')
      .populate('dealerType', 'name pricingTier')
      .populate('salesExecutive createdBy approvedBy cancellationRequestedBy modificationLogs.changedBy', 'name email phone')
      .populate({
        path: 'cancellationApprovalRequest',
        select: 'requestNumber status priority reason requestedBy requestedByName approvedBy approvedAt approvalRemarks createdAt updatedAt',
        populate: [
          { path: 'requestedBy', select: 'name email phone' },
          { path: 'approvedBy', select: 'name email phone' },
        ],
      })
      .populate('sourceQuotation', 'quotationNumber quotationDate validUntil status approvalStatus conversionState validityVersion convertedAt createdAt updatedAt')
      .populate('approvalReasons.product', 'productCode itemName')
      .populate({
        path: 'items.product',
        select: 'productCode itemName tileSize finish colour unit piecesPerBox sqftPerBox images brand category subcategory',
        populate: [
          { path: 'brand', select: 'name' },
          { path: 'category', select: 'name' },
          { path: 'subcategory', select: 'name' },
        ],
      })
      .populate('items.warehouse', 'warehouseCode name status').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: order });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

router.post('/', requirePermission('sales.order.create'), (req, res) => res.status(405).json({
  success: false,
  code: 'QUOTATION_REQUIRED',
  message: 'Direct Sales Order creation is not allowed. Create an approved or accepted quotation, then POST /api/v1/quotations/:id/convert.',
}));

router.put('/:id', requirePermission('sales.order.create'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      order = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId, ...salesOrderActorScope(req) }).session(session);
      if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (order.sourceQuotation) {
        const rejectedFields = Object.keys(req.body || {}).filter((key) => !CONVERTED_ORDER_OPERATIONAL_FIELDS.has(key));
        if (rejectedFields.length) {
          throw Object.assign(new Error(
            `Converted Sales Orders preserve their quotation pricing snapshot. Only operational fields may be updated; rejected: ${rejectedFields.join(', ')}.`
          ), { status: 409, code: 'CONVERTED_ORDER_COMMERCIAL_FIELDS_IMMUTABLE' });
        }
        const updateData = Object.fromEntries(
          Object.entries(req.body || {}).filter(([key]) => CONVERTED_ORDER_OPERATIONAL_FIELDS.has(key))
        );
        const changes = [];
        for (const [key, newValue] of Object.entries(updateData)) {
          const oldValue = order.get(key);
          if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
            changes.push({ field: key, oldValue, newValue, changedBy: req.user._id, changedAt: new Date() });
          }
        }
        Object.assign(order, updateData);
        if (changes.length) order.modificationLogs.push(...changes);
        if (changes.length && order.tallySyncStatus === 'synced') order.tallySyncStatus = 'pending';
        await order.save({ session });
        return;
      }
      if (order.status !== 'draft') throw Object.assign(new Error(`Cannot edit financial details in "${order.status}" status.`), { status: 409 });
      const editable = withoutServerManagedFields(req.body);
      if (editable.orderType === 'walk_in') editable.orderType = 'retail';
      const candidate = { ...order.toObject(), ...editable };
      await assertWarehousesInBranch((candidate.items || []).map((item) => item.warehouse), req.branchId, { session });
      const dealer = candidate.dealer ? await findDealer(candidate.dealer, session) : null;
      if (candidate.dealer && !dealer) throw Object.assign(new Error('Dealer not found.'), { status: 404 });
      if (!dealer && !candidate.customerName) throw validationError('customerName is required for walk-in sales.');
      const previousExposure = approvalExposureFingerprint(order);
      const outstanding = dealer ? await getBranchOutstanding(req.branchId, dealer._id, session) : 0;
      const authoritative = await authoritativeOrderData(candidate, dealer, outstanding, req.branchId, session, order.approvalReasons || []);
      const nextExposure = approvalExposureFingerprint({ ...candidate, ...authoritative });
      if (previousExposure !== nextExposure && authoritative.approvalReasons.length) {
        authoritative.approvalReasons = authoritative.approvalReasons.map((reason) => ({ ...reason, status: 'pending' }));
        authoritative.approvalStatus = 'pending';
      }
      const updateData = {
        ...editable, ...authoritative,
        dealerName: dealer?.businessName || '', dealerCode: dealer?.dealerCode || '',
      };
      const changes = [];
      for (const [key, newValue] of Object.entries(updateData)) {
        const oldValue = order.get(key);
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes.push({ field: key, oldValue, newValue, changedBy: req.user._id, changedAt: new Date() });
        }
      }
      Object.assign(order, updateData);
      if (changes.length) order.modificationLogs.push(...changes);
      if (order.tallySyncStatus === 'synced') order.tallySyncStatus = 'pending';
      await order.save({ session });
      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'sales_order',
        referenceModel: 'SalesOrder',
        referenceId: order._id,
        referenceNumber: order.orderNumber,
        title: `Sales Order ${order.orderNumber} requires approval`,
        reasons: order.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: order.grandTotal,
        document: order,
        session,
      });
    });
    return res.json({ success: true, message: 'Order updated.', data: order });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({
      success: false,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      message: error.message,
    });
  }
  finally { await session.endSession(); }
});

router.post('/:id/request-cancellation', requirePermission('sales.order.create'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(422).json({ success: false, message: 'A cancellation reason is required.' });
  const session = await mongoose.startSession();
  try {
    let approval;
    let order;
    await session.withTransaction(async () => {
      order = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId, ...salesOrderActorScope(req) }).session(session);
      if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (order.status === 'draft') throw Object.assign(new Error('Draft orders can be cancelled directly through the status endpoint.'), { status: 409 });
      if (order.status === 'partial_dispatch' || Number(order.items.reduce((sum, item) => sum + Number(item.dispatchedQuantity || 0), 0)) > 0) {
        throw Object.assign(new Error('A partially dispatched Sales Order cannot be cancelled wholesale.'), { status: 409 });
      }
      if (!['confirmed', 'approved', 'processing'].includes(order.status)) {
        throw Object.assign(new Error(`Cancellation cannot be requested for a Sales Order in "${order.status}" status.`), { status: 409 });
      }
      if (order.cancellationRequestStatus === 'pending' && order.cancellationApprovalRequest) {
        approval = await ApprovalRequest.findOne({ _id: order.cancellationApprovalRequest, branch: req.branchId }).session(session);
        if (approval?.status === 'pending') return;
      }
      const requestNumber = await generateBranchNumber(req.branchId, 'approval', new Date());
      [approval] = await ApprovalRequest.create([{
        requestNumber,
        branch: req.branchId,
        type: 'sales_order_cancellation',
        title: `Cancel Sales Order ${order.orderNumber}`,
        description: reason,
        referenceModel: 'SalesOrder',
        referenceId: order._id,
        referenceNumber: order.orderNumber,
        reason,
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        status: 'pending',
        priority: 'urgent',
      }], { session });
      order.cancellationReason = reason;
      order.cancellationRequestStatus = 'pending';
      order.cancellationApprovalRequest = approval._id;
      order.cancellationRequestedAt = new Date();
      order.cancellationRequestedBy = req.user._id;
      await order.save({ session });
    });
    return res.status(201).json({ success: true, message: 'Cancellation submitted for approval.', data: { order, approval } });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

router.patch('/:id/reservation/extend', requirePermission('sales.order.approve'), async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const extendedTo = new Date(req.body.extendedTo);
  const expectedUpdatedAt = new Date(req.body.expectedUpdatedAt);
  if (!reason || Number.isNaN(extendedTo.getTime()) || extendedTo <= new Date() || Number.isNaN(expectedUpdatedAt.getTime())) {
    return res.status(422).json({ success: false, message: 'reason, a future extendedTo, and expectedUpdatedAt are required.' });
  }
  try {
    const order = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId, approvalStatus: 'pending', updatedAt: expectedUpdatedAt });
    if (!order) return res.status(409).json({ success: false, message: 'Pending Sales Order changed; refresh before extending its reservation.' });
    if (!['reserved', 'partial'].includes(order.reservationStatus)) return res.status(409).json({ success: false, message: 'Only an active pending-approval reservation can be extended.' });
    const version = Number(order.reservationExpiryVersion || 0) + 1;
    order.reservationExtensions.push({ version, previousExpiresAt: order.reservationExpiresAt, extendedTo, reason, extendedBy: req.user._id, extendedAt: new Date() });
    order.reservationExpiresAt = extendedTo;
    order.reservationExpiryVersion = version;
    order.reservationExpiryState = 'extended';
    order.reservationExpiryReason = reason;
    await order.save();
    return res.json({ success: true, message: 'Pending-approval reservation expiry extended.', data: order });
  } catch (error) { return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.message }); }
});

router.post('/:id/remaining-cancellation/request', requirePermission('sales.order.create'), async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(422).json({ success: false, message: 'A reason is required.' });
  const session = await mongoose.startSession();
  try {
    let order; let approval;
    await session.withTransaction(async () => {
      order = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId, ...salesOrderActorScope(req) }).session(session);
      if (!order) throw Object.assign(new Error('Sales Order not found.'), { status: 404 });
      if (!['partial_dispatch'].includes(order.status) || !order.items.some(line => Number(line.dispatchedQuantity || 0) > QUANTITY_TOLERANCE)) {
        throw Object.assign(new Error('Cancel Remaining is available only after a partial dispatch.'), { status: 409 });
      }
      if (!order.items.some(line => Number(line.quantity || 0) - Number(line.dispatchedQuantity || 0) + Number(line.dispatchReversedQuantity || 0) - Number(line.cancelledRemainingQuantity || 0) > QUANTITY_TOLERANCE)) {
        throw Object.assign(new Error('No open quantity remains to cancel.'), { status: 409 });
      }
      if (order.remainingCancellationStatus === 'pending' && order.remainingCancellationApprovalRequest) {
        approval = await ApprovalRequest.findById(order.remainingCancellationApprovalRequest).session(session);
        if (approval?.status === 'pending') return;
      }
      const requestNumber = await generateBranchNumber(req.branchId, 'approval', new Date());
      [approval] = await ApprovalRequest.create([{
        requestNumber, branch: req.branchId, type: 'sales_order_remaining_cancellation', title: `Cancel remaining Sales Order ${order.orderNumber}`,
        description: reason, referenceModel: 'SalesOrder', referenceId: order._id, referenceNumber: order.orderNumber,
        reason, requestedBy: req.user._id, requestedByName: req.user.name || '', status: 'pending', priority: 'urgent',
      }], { session });
      order.remainingCancellationStatus = 'pending';
      order.remainingCancellationApprovalRequest = approval._id;
      order.remainingCancellationRequestedAt = new Date();
      order.remainingCancellationRequestedBy = req.user._id;
      order.remainingCancellationReason = reason;
      await order.save({ session });
    });
    return res.status(201).json({ success: true, message: 'Remaining quantity cancellation submitted for maker-checker approval.', data: { order, approval } });
  } catch (error) { return res.status(error.status || (error.name === 'CastError' ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.patch('/:id/remaining-cancellation/:action', requirePermission('sales.order.approve'), async (req, res) => {
  if (!['approve', 'reject'].includes(req.params.action)) return res.status(404).json({ success: false, message: 'Unknown remaining-cancellation action.' });
  const reviewReason = String(req.body.reason || '').trim();
  if (!reviewReason) return res.status(422).json({ success: false, message: 'A review reason is required.' });
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const order = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId }).session(session).select('remainingCancellationApprovalRequest');
      if (!order) throw Object.assign(new Error('Sales Order not found.'), { status: 404 });
      result = await actionSalesOrderRemainingCancellation({
        branchId: req.branchId,
        orderId: order._id,
        approvalRequestId: order.remainingCancellationApprovalRequest,
        actorId: req.user._id,
        nextStatus: req.params.action === 'approve' ? 'approved' : 'rejected',
        remarks: reviewReason,
        session,
      });
    });
    return res.json({ success: true, message: req.params.action === 'approve' ? 'Remaining quantity closed; reserved stock and confirmation receivable were reconciled.' : 'Remaining cancellation rejected.', data: result.order });
  } catch (error) { return res.status(error.status || (error.name === 'CastError' ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.patch('/:id/status', requireSalesOrderStatusPermission, async (req, res) => {
  const { status, cancellationReason } = req.body;
  if (!SALES_ORDER_STATUSES.has(status)) return res.status(422).json({ success: false, message: 'Unknown sales order status.' });
  const session = await mongoose.startSession();
  try {
    let order;
    let alreadyUpdated = false;
    await session.withTransaction(async () => {
      const current = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId, ...salesOrderActorScope(req) }).session(session);
      if (!current) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (current.status === status) { order = current; alreadyUpdated = true; return; }
      if (!USER_STATUS_TRANSITIONS[current.status]?.has(status)) {
        throw Object.assign(new Error(`Cannot change Sales Order from "${current.status}" to "${status}" manually. Warehouse and delivery transitions are system-managed.`), { status: 409 });
      }
      if (status === 'confirmed' && ['pending', 'rejected'].includes(current.approvalStatus)) {
        throw Object.assign(new Error(`Sales Order cannot be confirmed while approval is ${current.approvalStatus}.`), { status: 409 });
      }
      const oldStatus = current.status;
      if (status === 'confirmed') {
        current.confirmationRequested = true;
        await reserveSalesOrderInventory(current, { session, actor: req.user._id });
      }
      if (status === 'cancelled') await releaseSalesOrderInventory(current, { session, actor: req.user._id, reason: cancellationReason || 'Sales Order cancelled' });
      const setFields = { status };
      if (status === 'confirmed') setFields.confirmationRequested = true;
      if (status === 'cancelled') setFields.cancellationReason = cancellationReason || '';
      if (current.tallySyncStatus === 'synced') setFields.tallySyncStatus = 'pending';
      order = await SalesOrder.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: oldStatus, ...salesOrderActorScope(req) },
        { $set: setFields, $push: { modificationLogs: { field: 'status', oldValue: oldStatus, newValue: status, changedBy: req.user._id, changedAt: new Date(), reason: status === 'cancelled' ? cancellationReason : undefined } } },
        { new: true, runValidators: true, session }
      );
      if (!order) throw Object.assign(new Error('Sales Order status changed before the update could be applied.'), { status: 409 });
      if (status === 'cancelled') {
        await syncAutomaticApprovalRequest({
          branchId: req.branchId,
          type: 'sales_order',
          referenceModel: 'SalesOrder',
          referenceId: order._id,
          reasons: [],
          session,
        });
      }
      if (status === 'confirmed' && order.dealer && order.grandTotal > 0) {
        await postSubledgerEntry({
          session, branch: req.branchId, partyType: 'dealer', partyId: order.dealer,
          amount: order.grandTotal, side: 'debit', postingKey: `sales-order:${order._id}:confirmed`,
          entryType: 'invoice', entryDate: order.orderDate,
          description: `Receivable for Sales Order ${order.orderNumber}`,
          referenceNumber: order.orderNumber, referenceModel: 'SalesOrder', referenceId: order._id, createdBy: req.user._id,
        });
      }
    });
    return res.json({ success: true, message: alreadyUpdated ? `Order is already in "${status}" status.` : `Order status updated to "${status}".`, data: order });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.delete('/:id', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const existing = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId, ...salesOrderActorScope(req) }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (existing.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft Sales Orders can be deleted.' });
    if (existing.reservationStatus === 'reserved' || (existing.items || []).some(item => Number(item.reservedQuantity || 0) > 0.0001)) {
      return res.status(409).json({ success: false, message: 'This Sales Order owns reserved stock. Cancel it to release inventory before deletion.' });
    }
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(SalesOrder, req.params.id, {
      user: req.user, module: 'sales_order', titleField: 'dealerName', codeField: 'orderNumber', scope: { branch: req.branchId, ...salesOrderActorScope(req) },
    });
    return res.status(result.status || 200).json(result);
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

export default router;
