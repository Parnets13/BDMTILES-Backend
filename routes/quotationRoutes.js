import { Router } from 'express';
import mongoose from 'mongoose';
import Quotation from '../models/Quotation.js';
import QuotationConversion from '../models/QuotationConversion.js';
import DealerOrderRequest from '../models/DealerOrderRequest.js';
import SalesOrder from '../models/SalesOrder.js';
import Dealer from '../models/Dealer.js';
import DealerType from '../models/DealerType.js';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import Brand from '../models/Brand.js';
import Category from '../models/Category.js';
import Subcategory from '../models/Subcategory.js';
import { resolvePricing } from '../services/pricingResolver.js';
import { findActiveDealer, priceQuotation } from '../services/quotationPricingService.js';
import { convertQuotationCore, conversionFingerprint, conversionSourceKey, findConversionReplay } from '../services/quotationConversionService.js';
import { assertQuotationMatchesRequest, refreshAndFingerprintRequest } from '../services/dealerOrderRequestService.js';
import { syncAutomaticApprovalRequest } from '../services/approvalRequestService.js';
import { protect, requireAnyPermission, requirePermission, userHasPermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { computeSplitPlan, executeSplit, loadSplitFamily } from '../services/quotationSplitService.js';
import {
  holdTtlHours,
  placeQuotationHold,
  releaseQuotationHold,
  totalHeldQuantity,
} from '../services/quotationHoldService.js';
import {
  applyQuotationStockSnapshot,
  applyQuotationUomSnapshots,
  getQuotationReadiness,
  getQuotationReadinessMap,
  quotationStockEligibility,
  withQuotationReadiness,
} from '../services/quotationStockService.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { effectiveValidUntil, parseValidityDate, quotationValidity, withQuotationValidity } from '../utils/quotationValidity.js';
import { resolveStockUom } from '../services/stockUomService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);
// Quotation readiness and lifecycle fields are live and must never be served
// from browser, proxy, or intermediary caches.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(422).json({ success: false, message: 'Quotation id is invalid.' });
  }
  return next();
});
router.param('conversionId', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(422).json({ success: false, message: 'Quotation conversion id is invalid.' });
  }
  return next();
});

const SERVER_MANAGED_FIELDS = new Set([
  'quotationNumber', 'branch', 'legacyBranch', 'createdBy', 'dealerName', 'dealerCode', 'dealerTypeSnapshot',
  'subtotal', 'totalDiscount', 'totalSchemeDiscount', 'totalTax', 'roundOff', 'grandTotal',
  'status', 'approvalRequired', 'approvalStatus', 'approvalReasons', 'approvedBy', 'approvalDate', 'approvalRemarks',
  'convertedToSO', 'convertedAt', 'convertedSalesOrders', 'conversionState', 'conversionVersion',
  'firstConvertedAt', 'lastConvertedAt', 'fullyConvertedAt', 'sourceDealerOrderRequest', 'dealerOrderRequestId', 'version', 'previousVersion',
  'stockSnapshotAt', 'snapshotCaptured', 'stockQueuedAt', 'validityVersion', 'validityHistory', 'tallySyncStatus', 'createdAt', 'updatedAt', '_id', '__v',
  // Stock holds and split lineage are server-owned: a client must never be able
  // to claim held stock or forge a split relationship through the edit endpoint.
  'holdStatus', 'heldAt', 'heldBy', 'holdExpiresAt', 'holdExpiryState', 'holdExpiryVersion',
  'holdExpiredAt', 'holdReleasedAt', 'holdConsumedAt', 'holdExpiryReason', 'holdExtensions',
  'splitGroupId', 'splitRole', 'splitFromQuotation', 'splitQuotations', 'splitAt', 'splitBy', 'splitPlanHash',
]);
const STATUS_TRANSITIONS = {
  draft: new Set(['sent', 'cancelled']),
  pending_approval: new Set(['cancelled']),
  approved: new Set(['sent', 'accepted', 'cancelled']),
  sent: new Set(['accepted', 'cancelled']),
  accepted: new Set(['cancelled']),
  // A shortfall child is not a firm offer. It cannot be sent or accepted while it
  // has no stock; POST /:id/confirm-stock is the only way out of pending_stock,
  // and it requires stock to actually be available.
  pending_stock: new Set(['cancelled']),
  // A split parent is an immutable record of the original request.
  split: new Set([]),
  converted: new Set([]), expired: new Set([]), cancelled: new Set([]),
};
// Statuses that represent stock the business has genuinely committed to hold.
const HOLD_ELIGIBLE_STATUSES = new Set(['approved', 'accepted']);
const routeError = (status, message, code, details) => Object.assign(
  new Error(message),
  { status, ...(code ? { code } : {}), ...(details ? { details } : {}) },
);
const quotationActorScope = req => req.user.role === 'sales_executive' ? { createdBy: req.user._id } : {};
function editableBody(body = {}) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SERVER_MANAGED_FIELDS.has(key)));
}
function normalizeQuotationValidity(data) {
  const quotationDate = new Date(data.quotationDate || new Date());
  if (Number.isNaN(quotationDate.getTime())) throw routeError(422, 'quotationDate is invalid.');
  let validUntil = parseValidityDate(data.validUntil);
  if (!validUntil) {
    validUntil = new Date(quotationDate);
    validUntil.setUTCDate(validUntil.getUTCDate() + 30);
    validUntil.setUTCHours(23, 59, 59, 999);
  } else {
    validUntil = effectiveValidUntil(validUntil);
  }
  if (validUntil.getTime() < quotationDate.getTime()) {
    throw routeError(422, 'validUntil cannot be before quotationDate.');
  }
  data.quotationDate = quotationDate;
  data.validUntil = validUntil;
  return data;
}
async function findLinkedConvertedOrder(quotation, branchId, session = null) {
  if (!quotation?.convertedToSO) return null;
  let query = SalesOrder.findOne({
    _id: quotation.convertedToSO,
    branch: branchId,
    sourceQuotation: quotation._id,
  });
  if (session) query = query.session(session);
  return query;
}
function conversionSuccess(quotation, salesOrder, idempotent = false) {
  return {
    success: true,
    idempotent,
    message: idempotent
      ? `Quotation was already converted to ${salesOrder.orderNumber}.`
      : salesOrder.status === 'draft'
        ? `Converted to ${salesOrder.orderNumber} as draft pending approval.`
        : `Converted to ${salesOrder.orderNumber}.`,
    data: { quotation, salesOrder },
  };
}
async function getConversionHistory(quotationId, branchId, session = null) {
  let query = QuotationConversion.find({ quotation: quotationId, branch: branchId })
    .sort({ createdAt: 1 })
    .populate('salesOrder', 'orderNumber orderDate status approvalStatus reservationStatus grandTotal paymentStatus')
    .populate('createdBy reversedBy', 'name email');
  if (session) query = query.session(session);
  return query.lean();
}
async function quotationDto(quotation, options = {}) {
  if (!quotation) return quotation;
  const stockReadiness = options.stockReadiness || await getQuotationReadiness(quotation, {
    session: options.session || null,
  });
  return {
    ...withQuotationReadiness(quotation, stockReadiness),
    ...(options.conversionHistory ? { conversionHistory: options.conversionHistory } : {}),
  };
}

router.get('/', requirePermission('quotation.management'), async (req, res) => {
  try {
    const {
      page = 1, limit = 20, search, status, dealer, dealerType, customer, customerType,
      approvalStatus, conversionState, converted, createdBy, dateFrom, dateTo,
      validityStatus, expiringWithinDays = 30, stockStatus, amountMin, amountMax,
      sortBy = 'createdAt', sortOrder = 'desc',
    } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const allowedSorts = new Set(['createdAt', 'updatedAt', 'quotationDate', 'validUntil', 'quotationNumber', 'grandTotal']);
    if (!allowedSorts.has(sortBy)) throw routeError(422, 'Unsupported quotation sort field.');
    if (!['asc', 'desc'].includes(sortOrder)) throw routeError(422, 'sortOrder must be asc or desc.');
    const enumValues = (value, allowed, field) => {
      if (!value) return [];
      const values = String(value).split(',').map(entry => entry.trim()).filter(Boolean);
      if (values.some(entry => !allowed.has(entry))) throw routeError(422, `${field} contains an unsupported value.`);
      return values;
    };
    const objectIdFilter = (value, field) => {
      if (value && !mongoose.isValidObjectId(value)) throw routeError(422, `${field} is invalid.`);
      return value;
    };
    const dateRange = (from, to, field) => {
      if (!from && !to) return null;
      const range = {};
      if (from) {
        const start = new Date(from);
        if (Number.isNaN(start.getTime())) throw routeError(422, `${field} from date is invalid.`);
        range.$gte = start;
      }
      if (to) {
        const end = new Date(to);
        if (Number.isNaN(end.getTime())) throw routeError(422, `${field} to date is invalid.`);
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) end.setUTCHours(23, 59, 59, 999);
        range.$lte = end;
      }
      if (range.$gte && range.$lte && range.$gte.getTime() > range.$lte.getTime()) {
        throw routeError(422, `${field} from date cannot be after to date.`);
      }
      return range;
    };
    const statuses = enumValues(status, new Set(Object.keys(STATUS_TRANSITIONS)), 'status');
    const includesEffectiveExpired = statuses.includes('expired');
    const persistedStatuses = statuses.filter(value => value !== 'expired');
    const approvalStatuses = enumValues(approvalStatus, new Set(['not_required', 'pending', 'approved', 'rejected']), 'approvalStatus');
    const conversionStates = enumValues(conversionState, new Set(['none', 'partial', 'full']), 'conversionState');
    const customerTypes = enumValues(customerType, new Set(['dealer', 'wholesaler', 'retail', 'distributor', 'builder']), 'customerType');
    const validityStatuses = enumValues(validityStatus, new Set(['active', 'expired', 'expiring_soon', 'no_expiry']), 'validityStatus');
    const stockStatuses = enumValues(stockStatus, new Set(['available', 'partial', 'out_of_stock', 'fully_converted']), 'stockStatus');
    if (converted !== undefined && converted !== '' && !['true', 'false'].includes(String(converted))) {
      throw routeError(422, 'converted must be true or false.');
    }
    const soonDaysText = String(expiringWithinDays).trim();
    if (!/^\d+$/.test(soonDaysText)) throw routeError(422, 'expiringWithinDays must be an integer from 1 to 365.');
    const soonDays = Number(soonDaysText);
    if (soonDays < 1 || soonDays > 365) throw routeError(422, 'expiringWithinDays must be an integer from 1 to 365.');
    [dealer, dealerType, createdBy].forEach((value, index) => objectIdFilter(value, ['dealer', 'dealerType', 'createdBy'][index]));
    if (createdBy && req.user.role === 'sales_executive' && String(createdBy) !== String(req.user._id)) {
      throw routeError(403, 'Sales executives can only list their own quotations.');
    }
    const filter = { branch: req.branchId, ...quotationActorScope(req) };
    const conditions = [];
    const addTextCondition = (value, fields) => {
      if (!value) return;
      const regex = new RegExp(escapeRegex(String(value).trim()), 'i');
      conditions.push({ $or: fields.map(field => ({ [field]: regex })) });
    };
    addTextCondition(search, ['quotationNumber', 'dealerName', 'dealerCode', 'customerName', 'customerPhone']);
    addTextCondition(customer, ['dealerName', 'dealerCode', 'customerName', 'customerPhone']);
    if (!includesEffectiveExpired && persistedStatuses.length) {
      filter.status = persistedStatuses.length === 1 ? persistedStatuses[0] : { $in: persistedStatuses };
    }
    if (approvalStatuses.length) filter.approvalStatus = approvalStatuses.length === 1 ? approvalStatuses[0] : { $in: approvalStatuses };
    if (customerTypes.length) filter.customerType = customerTypes.length === 1 ? customerTypes[0] : { $in: customerTypes };
    if (dealer) filter.dealer = dealer;
    if (dealerType) filter.dealerType = dealerType;
    if (createdBy && req.user.role !== 'sales_executive') filter.createdBy = createdBy;
    const quotationDateRange = dateRange(dateFrom, dateTo, 'quotationDate');
    if (quotationDateRange) filter.quotationDate = quotationDateRange;
    const hasMinimum = amountMin !== undefined && String(amountMin).trim() !== '';
    const hasMaximum = amountMax !== undefined && String(amountMax).trim() !== '';
    const minimum = hasMinimum ? Number(amountMin) : null;
    const maximum = hasMaximum ? Number(amountMax) : null;
    if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0)) throw routeError(422, 'amountMin is invalid.');
    if (maximum !== null && (!Number.isFinite(maximum) || maximum < 0)) throw routeError(422, 'amountMax is invalid.');
    if (minimum !== null && maximum !== null && minimum > maximum) {
      throw routeError(422, 'amountMin cannot be greater than amountMax.');
    }
    if (minimum !== null || maximum !== null) {
      filter.grandTotal = {};
      if (minimum !== null) filter.grandTotal.$gte = minimum;
      if (maximum !== null) filter.grandTotal.$lte = maximum;
    }
    if (conditions.length) filter.$and = conditions;
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortDirection, _id: sortDirection };
    const needsDerivedFiltering = includesEffectiveExpired || validityStatuses.length > 0
      || stockStatuses.length > 0 || conversionStates.length > 0
      || converted === 'true' || converted === 'false';
    let data;
    let total;
    let readinessByQuotation = null;
    if (needsDerivedFiltering) {
      let candidates = await Quotation.find(filter).sort(sort)
        .populate('dealer', 'businessName dealerCode mobile city')
        .populate('dealerType', 'name pricingTier').lean();
      candidates = candidates.map(value => withQuotationReadiness(value, null));
      if (includesEffectiveExpired) {
        candidates = candidates.filter(value => value.effectiveStatus === 'expired' || persistedStatuses.includes(value.status));
      }
      if (validityStatuses.length) {
        candidates = candidates.filter((value) => validityStatuses.some((bucket) => {
          if (bucket === 'no_expiry') return !value.validUntil;
          if (bucket === 'expired') return value.isExpired;
          if (bucket === 'active') return !value.isExpired;
          return !value.isExpired && value.validUntil && value.expiresInDays >= 0 && value.expiresInDays <= soonDays;
        }));
      }
      if (conversionStates.length) {
        candidates = candidates.filter(value => conversionStates.includes(value.conversionState));
      }
      if (converted === 'true') candidates = candidates.filter(value => value.conversionState !== 'none');
      if (converted === 'false') candidates = candidates.filter(value => value.conversionState === 'none');
      if (stockStatuses.length) {
        readinessByQuotation = await getQuotationReadinessMap({ branchId: req.branchId, quotations: candidates });
        candidates = candidates.filter(value => stockStatuses.includes(readinessByQuotation.get(String(value._id))?.overallStatus));
      }
      total = candidates.length;
      data = candidates.slice((p - 1) * l, p * l);
    } else {
      [data, total] = await Promise.all([
        Quotation.find(filter).sort(sort).skip((p - 1) * l).limit(l)
          .populate('dealer', 'businessName dealerCode mobile city')
          .populate('dealerType', 'name pricingTier').lean(),
        Quotation.countDocuments(filter),
      ]);
      data = data.map(value => withQuotationValidity(value));
    }
    if (!readinessByQuotation) readinessByQuotation = await getQuotationReadinessMap({ branchId: req.branchId, quotations: data });
    const enriched = data.map(quotation => withQuotationReadiness(
      quotation,
      readinessByQuotation.get(String(quotation._id)),
    ));
    return res.json({
      success: true,
      data: enriched,
      pagination: {
        currentPage: p,
        totalPages: Math.ceil(total / l),
        totalItems: total,
        itemsPerPage: l,
        hasMore: p * l < total,
      },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

router.get('/stats', requirePermission('quotation.management'), async (req, res) => {
  try {
    const scope = { branch: req.branchId, ...quotationActorScope(req) };
    const quotations = await Quotation.find(scope)
      .select('_id branch items status approvalRequired approvalStatus approvalReasons approvalDate stockQueuedAt validUntil conversionState conversionVersion convertedToSO convertedSalesOrders createdAt grandTotal')
      .lean();
    const readinessCandidates = quotations
      .map(value => withQuotationValidity(value))
      .filter(value => value.status !== 'cancelled' && value.effectiveStatus !== 'expired');
    const readinessMap = await getQuotationReadinessMap({
      branchId: req.branchId,
      quotations: readinessCandidates,
    });
    const statusCounts = Object.fromEntries(Object.keys(STATUS_TRANSITIONS).map(status => [status, 0]));
    const conversionCounts = { none: 0, partial: 0, full: 0 };
    let totalValue = 0;
    for (const quotation of quotations) {
      statusCounts[quotation.status] = Number(statusCounts[quotation.status] || 0) + 1;
      const dto = withQuotationReadiness(quotation, null);
      conversionCounts[dto.conversionState] += 1;
      if (quotation.status !== 'cancelled') totalValue += Number(quotation.grandTotal || 0);
    }
    const dynamicallyExpired = quotations.filter(value =>
      value.status !== 'expired' && quotationValidity(value).isExpired
    ).length;
    const readinessCounts = {
      available: 0,
      partial: 0,
      outOfStock: 0,
      fullyConverted: 0,
      queued: { total: 0, available: 0, partial: 0, outOfStock: 0, fullyConverted: 0 },
      physicalOnly: { total: 0, available: 0, partial: 0, outOfStock: 0, fullyConverted: 0 },
    };
    const stockKey = status => status === 'out_of_stock' ? 'outOfStock'
      : status === 'fully_converted' ? 'fullyConverted' : status;
    for (const quotation of readinessCandidates) {
      const readiness = readinessMap.get(String(quotation._id));
      const key = stockKey(readiness?.overallStatus);
      if (!Object.hasOwn(readinessCounts, key)) continue;
      readinessCounts[key] += 1;
      const modeCounts = readiness?.queued ? readinessCounts.queued : readinessCounts.physicalOnly;
      modeCounts.total += 1;
      modeCounts[key] += 1;
    }
    return res.json({
      success: true,
      data: {
        total: quotations.length,
        draft: statusCounts.draft,
        pendingApproval: statusCounts.pending_approval,
        approved: statusCounts.approved,
        sent: statusCounts.sent,
        accepted: statusCounts.accepted,
        converted: statusCounts.converted,
        expired: statusCounts.expired + dynamicallyExpired,
        cancelled: statusCounts.cancelled,
        totalValue,
        stockReadiness: readinessCounts,
        conversionState: conversionCounts,
        checkedAt: new Date(),
      },
    });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validObjectId = (value, field) => {
  if (value && !mongoose.isValidObjectId(value)) throw routeError(422, `${field} is invalid.`);
};
async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

router.get('/product-browser', requireAnyPermission('sales.order.create', 'quotation.management'), async (req, res) => {
  try {
    const {
      search, q, brand, category, subcategory, page = 1, limit = 50,
      dealer: dealerQuery, dealerId: dealerIdQuery,
      dealerType: dealerTypeQuery, dealerTypeId: dealerTypeIdQuery,
      scope: requestedScope, quantity = 1, pricingDate, includeFilterOptions,
    } = req.query;
    const dealerId = dealerQuery || dealerIdQuery;
    const dealerTypeId = dealerTypeQuery || dealerTypeIdQuery;
    const scope = requestedScope || (dealerId ? 'dealer' : dealerTypeId ? 'dealer_type' : 'walk_in');
    const allowedScopes = new Set(['dealer', 'dealer_type', 'walk_in']);
    if (!allowedScopes.has(scope)) throw routeError(422, 'scope must be dealer, dealer_type, or walk_in.');
    [brand, category, subcategory, dealerId, dealerTypeId].forEach((value, index) => {
      validObjectId(value, ['brand', 'category', 'subcategory', 'dealer', 'dealerType'][index]);
    });
    if (scope === 'dealer' && !dealerId) throw routeError(422, 'dealer is required for dealer scope.');
    if (scope === 'dealer_type' && !dealerTypeId) throw routeError(422, 'dealerType is required for dealer_type scope.');
    if (scope === 'dealer_type' && dealerId) throw routeError(422, 'dealer_type scope cannot include dealer.');
    if (scope === 'walk_in' && (dealerId || dealerTypeId)) throw routeError(422, 'walk_in scope cannot include dealer or dealerType.');

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw routeError(422, 'quantity must be greater than zero.');
    const at = pricingDate ? new Date(pricingDate) : new Date();
    if (Number.isNaN(at.getTime())) throw routeError(422, 'pricingDate is invalid.');
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 50));

    let dealer = null;
    if (scope === 'dealer') {
      dealer = await findActiveDealer(dealerId);
      if (!dealer) throw routeError(404, 'Dealer not found.');
      if (dealerTypeId && String(dealer.dealerType?._id || '') !== String(dealerTypeId)) {
        throw routeError(422, 'Dealer does not belong to the selected Dealer Type.');
      }
    } else if (scope === 'dealer_type') {
      const dealerType = await DealerType.findOne({ _id: dealerTypeId, status: 'active' }).select('_id').lean();
      if (!dealerType) throw routeError(404, 'Dealer Type not found or inactive.');
    }

    const filter = { status: 'active' };
    const term = String(search || q || '').trim();
    if (term) {
      const regex = new RegExp(escapeRegex(term), 'i');
      filter.$or = [{ itemName: regex }, { productCode: regex }, { aliasName: regex }, { barcode: regex }];
    }
    if (brand) filter.brand = brand;
    if (category) filter.category = category;
    if (subcategory) filter.subcategory = subcategory;

    const [products, totalItems] = await Promise.all([
      Product.find(filter).sort({ itemName: 1, _id: 1 }).skip((p - 1) * l).limit(l)
        .select('productCode itemName aliasName description hsnCode gst brand category subcategory tileSize thickness finish surface colour design grade collection tileType applicationArea unit inventoryBaseUom inventoryUomVersion uomConversions piecesPerBox sqftPerBox weightPerBox mrp retailRate dealerRate wholesaleRate distributorRate projectRate builderRate minimumSellingRate images isNewArrival isFeatured status')
        .populate('brand', 'name').populate('category', 'name brand').populate('subcategory', 'name category brand').lean(),
      Product.countDocuments(filter),
    ]);
    const productIds = products.map((product) => product._id);
    const stockRows = productIds.length ? await Stock.aggregate([
      { $match: { branch: req.branchId, product: { $in: productIds } } },
      { $group: {
        _id: '$product', totalQty: { $sum: '$totalQty' }, availableQty: { $sum: '$availableQty' },
        reservedQty: { $sum: '$reservedQty' }, blockedQty: { $sum: '$blockedQty' },
        // Held for an approved quotation. availableQty is already net of this, so
        // it is surfaced only to explain why free stock is lower than total.
        quotedQty: { $sum: '$quotedQty' },
        damagedQty: { $sum: '$damagedQty' },
      } },
    ]) : [];
    const stockByProduct = new Map(stockRows.map((row) => [String(row._id), row]));
    const data = await mapWithConcurrency(products, 6, async (product) => {
      const pricing = await resolvePricing({
        branchId: req.branchId, dealerId: scope === 'dealer' ? dealerId : undefined,
        dealerTypeId: scope === 'dealer_type' ? dealerTypeId : undefined,
        scope, product, quantity: qty, pricingDate: at,
        orderType: scope === 'walk_in' ? 'retail' : 'dealer',
      });
      const baseStock = stockByProduct.get(String(product._id)) || {
        totalQty: 0, availableQty: 0, reservedQty: 0, quotedQty: 0, blockedQty: 0, damagedQty: 0,
      };
      const displayUom = await resolveStockUom({
        product,
        enteredQuantity: 1,
        enteredUnit: product.unit,
        at,
      });
      const display = value => Math.round((Number(value || 0) / displayUom.conversionFactor + Number.EPSILON) * 1e6) / 1e6;
      const stock = {
        totalQty: display(baseStock.totalQty),
        availableQty: display(baseStock.availableQty),
        reservedQty: display(baseStock.reservedQty),
        quotedQty: display(baseStock.quotedQty),
        blockedQty: display(baseStock.blockedQty),
        damagedQty: display(baseStock.damagedQty),
      };
      return {
        ...product,
        stockAvailable: stock.availableQty,
        stock: {
          ...stock,
          baseTotalQty: Number(baseStock.totalQty || 0),
          baseAvailableQty: Number(baseStock.availableQty || 0),
          baseReservedQty: Number(baseStock.reservedQty || 0),
          baseQuotedQty: Number(baseStock.quotedQty || 0),
          baseBlockedQty: Number(baseStock.blockedQty || 0),
          baseDamagedQty: Number(baseStock.damagedQty || 0),
          displayUnit: displayUom.enteredUnit,
          baseUnit: displayUom.baseUnit,
          conversionFactor: displayUom.conversionFactor,
          uomVersion: displayUom.uomVersion,
          scope: 'branch_snapshot',
        },
        requestedTier: pricing.requestedTier, rateField: pricing.rateField,
        baseRate: pricing.baseRate, pricingRate: pricing.pricingRate, effectiveRate: pricing.effectiveRate,
        minimumSellingRate: pricing.minimumSellingRate, belowMinimum: pricing.belowMinimum,
        fallbackApplied: pricing.fallbackApplied, source: pricing.source, sourceName: pricing.sourceName,
        overrideScope: pricing.overrideScope,
        discount: {
          regularPerUnit: pricing.regularDiscountPerUnit,
          schemePerUnit: pricing.schemeDiscountPerUnit,
          rule: pricing.rule,
        },
      };
    });

    const wantsFilterOptions = p === 1 && ['true', '1'].includes(String(includeFilterOptions).toLowerCase());
    let filterOptions;
    if (wantsFilterOptions) {
      const [brands, categories, subcategories] = await Promise.all([
        Brand.find({ status: 'active' }).sort({ name: 1 }).select('name').lean(),
        Category.find({ status: 'active' }).sort({ name: 1 }).select('name brand').lean(),
        Subcategory.find({ status: 'active' }).sort({ name: 1 }).select('name brand category').lean(),
      ]);
      filterOptions = { brands, categories, subcategories };
    }
    const totalPages = Math.ceil(totalItems / l);
    return res.json({
      success: true, data,
      pagination: {
        currentPage: p, totalPages, totalItems, itemsPerPage: l,
        hasMore: p * l < totalItems,
      },
      ...(filterOptions ? { filterOptions } : {}),
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

router.post('/price-preview', requireAnyPermission('sales.order.create', 'quotation.management'), async (req, res) => {
  try {
    const data = editableBody(req.body);
    const dealer = data.dealer ? await findActiveDealer(data.dealer) : null;
    if (data.dealer && !dealer) throw routeError(404, 'Dealer not found.');
    if (!dealer && !data.customerName) throw routeError(422, 'customerName is required for walk-in quotations.');
    await assertWarehousesInBranch((data.items || []).map(item => item.warehouse), req.branchId);
    const { fields } = await priceQuotation(data, dealer, req.branchId);
    fields.items = await applyQuotationUomSnapshots(fields.items, { at: data.quotationDate || new Date() });
    return res.json({ success: true, data: fields });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

router.get('/:id', requirePermission('quotation.management'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw routeError(422, 'Quotation id is invalid.');
    const quotation = await Quotation.findOne({
      _id: req.params.id,
      branch: req.branchId,
      ...quotationActorScope(req),
    })
      .populate('branch', 'branchCode name city state address phone email gstin')
      .populate('dealer', 'businessName dealerCode ownerName mobile email city state gstin address creditLimit creditDays currentOutstanding assignedRegion')
      .populate('dealerType', 'name pricingTier')
      .populate('createdBy approvedBy validityHistory.changedBy', 'name email phone')
      .populate('previousVersion', 'quotationNumber version status createdAt')
      .populate('sourceDealerOrderRequest', 'requestNumber status submittedAt approvedAt linkedAt createdAt')
      .populate('convertedToSO', 'orderNumber orderDate status approvalStatus reservationStatus paymentStatus grandTotal')
      .populate('convertedSalesOrders', 'orderNumber orderDate status approvalStatus reservationStatus paymentStatus grandTotal')
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
    if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found.' });
    const [stockReadiness, conversionHistory] = await Promise.all([
      getQuotationReadiness(quotation),
      getConversionHistory(quotation._id, req.branchId),
    ]);
    return res.json({
      success: true,
      data: await quotationDto(quotation, { stockReadiness, conversionHistory }),
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

router.post('/', requirePermission('quotation.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let quotation;
    let idempotent = false;
    await session.withTransaction(async () => {
      const sourceRequestId = req.body?.sourceDealerOrderRequest || req.body?.dealerOrderRequestId;
      const data = normalizeQuotationValidity(editableBody(req.body));
      if (data.customerType === 'walk_in') data.customerType = 'retail';

      let sourceRequest = null;
      if (sourceRequestId) {
        if (!userHasPermission(req.user, 'dealer.order_request.review')) {
          throw routeError(403, 'Dealer order request review permission is required to create its quotation.');
        }
        if (!mongoose.isValidObjectId(sourceRequestId)) throw routeError(422, 'sourceDealerOrderRequest must be valid.');
        sourceRequest = await DealerOrderRequest.findOne({ _id: sourceRequestId, branch: req.branchId }).session(session);
        if (!sourceRequest) throw routeError(404, 'Dealer order request not found.');
        if (sourceRequest.status === 'quotation_linked' || sourceRequest.sourceQuotation) {
          const existing = sourceRequest.sourceQuotation
            ? await Quotation.findOne({
              _id: sourceRequest.sourceQuotation,
              branch: req.branchId,
              sourceDealerOrderRequest: sourceRequest._id,
            }).session(session)
            : null;
          if (!existing) throw routeError(409, 'This dealer order request is linked, but its quotation could not be verified.');
          quotation = existing;
          idempotent = true;
          return;
        }
        if (sourceRequest.status !== 'approved') {
          throw routeError(409, 'Only an approved dealer order request can create a quotation.');
        }
        const refreshed = await refreshAndFingerprintRequest(sourceRequest, session);
        if (refreshed.fingerprint !== sourceRequest.approvedFingerprint) {
          throw routeError(409, 'Approved request details changed. Review the request again.');
        }
        await assertQuotationMatchesRequest(sourceRequest, data.dealer, data.items, session);
      }

      const dealer = data.dealer ? await findActiveDealer(data.dealer, session) : null;
      if (data.dealer && !dealer) throw routeError(404, 'Dealer not found.');
      if (!dealer && !data.customerName) throw routeError(422, 'customerName is required for walk-in quotations.');
      await assertWarehousesInBranch((data.items || []).map(item => item.warehouse), req.branchId, { session });
      const { fields } = await priceQuotation(data, dealer, req.branchId, session);
      const stockSnapshotAt = new Date();
      fields.items = await applyQuotationUomSnapshots(fields.items, { session, at: data.quotationDate });
      fields.items = await applyQuotationStockSnapshot(fields.items, req.branchId, { session });
      Object.assign(data, fields, {
        branch: req.branchId,
        createdBy: req.user._id,
        snapshotCaptured: true,
        stockSnapshotAt,
        quotationNumber: await generateBranchNumber(req.branchId, 'quotation', data.quotationDate || new Date(), { session }),
        dealerName: dealer?.businessName || '',
        dealerCode: dealer?.dealerCode || '',
        tallySyncStatus: 'not_synced',
        ...(sourceRequest ? { sourceDealerOrderRequest: sourceRequest._id } : {}),
      });
      data.status = fields.approvalRequired ? 'pending_approval' : (req.body.status === 'sent' ? 'sent' : 'draft');
      [quotation] = await Quotation.create([data], { session });

      if (sourceRequest) {
        const linked = await DealerOrderRequest.findOneAndUpdate(
          {
            _id: sourceRequest._id,
            branch: req.branchId,
            status: 'approved',
            revision: sourceRequest.revision,
            sourceQuotation: { $exists: false },
          },
          {
            $set: {
              status: 'quotation_linked',
              sourceQuotation: quotation._id,
              linkedAt: new Date(),
              linkedBy: req.user._id,
            },
            $inc: { revision: 1 },
          },
          { new: true, session },
        );
        if (!linked) throw routeError(409, 'The dealer order request was linked or changed by another user.');
      }

      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'quotation',
        referenceModel: 'Quotation',
        referenceId: quotation._id,
        referenceNumber: quotation.quotationNumber,
        title: `Quotation ${quotation.quotationNumber} requires pricing approval`,
        reasons: quotation.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: quotation.grandTotal,
        document: quotation,
        session,
      });
    });
    const status = idempotent ? 200 : 201;
    const responseQuotation = await quotationDto(quotation);
    return res.status(status).json({
      success: true,
      idempotent,
      message: idempotent ? `Quotation ${quotation.quotationNumber} was already created.` : `Quotation ${quotation.quotationNumber} created.`,
      data: responseQuotation,
    });
  } catch (error) { return res.status(error.status || (error.code === 11000 ? 409 : ['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.put('/:id', requirePermission('quotation.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let quotation;
    await session.withTransaction(async () => {
      quotation = await Quotation.findOne({ _id: req.params.id, branch: req.branchId, ...quotationActorScope(req) }).session(session);
      if (!quotation) throw routeError(404, 'Quotation not found.');
      if (!['draft', 'pending_approval'].includes(quotation.status)) throw routeError(409, `Cannot edit quotation in "${quotation.status}" status.`);
      const updates = editableBody(req.body);
      if (updates.customerType === 'walk_in') updates.customerType = 'retail';
      const data = normalizeQuotationValidity({ ...quotation.toObject(), ...updates });
      updates.quotationDate = data.quotationDate;
      updates.validUntil = data.validUntil;
      if (quotation.sourceDealerOrderRequest) {
        const sourceRequest = await DealerOrderRequest.findOne({
          _id: quotation.sourceDealerOrderRequest,
          branch: req.branchId,
          status: 'quotation_linked',
          sourceQuotation: quotation._id,
        }).session(session);
        if (!sourceRequest) throw routeError(409, 'Linked dealer order request could not be verified.');
        const refreshed = await refreshAndFingerprintRequest(sourceRequest, session);
        if (refreshed.fingerprint !== sourceRequest.approvedFingerprint) {
          throw routeError(409, 'Approved request details changed. The linked quotation cannot be edited.');
        }
        await assertQuotationMatchesRequest(sourceRequest, data.dealer, data.items, session);
      }
      const dealer = data.dealer ? await findActiveDealer(data.dealer, session) : null;
      if (data.dealer && !dealer) throw routeError(404, 'Dealer not found.');
      if (!dealer && !data.customerName) throw routeError(422, 'customerName is required for walk-in quotations.');
      await assertWarehousesInBranch((data.items || []).map(item => item.warehouse), req.branchId, { session });
      const { fields } = await priceQuotation(data, dealer, req.branchId, session, quotation.approvalReasons || []);
      fields.items = await applyQuotationUomSnapshots(fields.items, { session, at: data.quotationDate });
      fields.items = await applyQuotationStockSnapshot(fields.items, req.branchId, { session });
      Object.assign(quotation, updates, fields, {
        dealerName: dealer?.businessName || '', dealerCode: dealer?.dealerCode || '',
        snapshotCaptured: true,
        stockSnapshotAt: new Date(),
        stockQueuedAt: null,
        status: fields.approvalRequired ? 'pending_approval' : 'draft',
      });
      if (quotation.tallySyncStatus === 'synced') quotation.tallySyncStatus = 'pending';
      await quotation.save({ session });
      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'quotation',
        referenceModel: 'Quotation',
        referenceId: quotation._id,
        referenceNumber: quotation.quotationNumber,
        title: `Quotation ${quotation.quotationNumber} requires pricing approval`,
        reasons: quotation.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: quotation.grandTotal,
        document: quotation,
        session,
      });
    });
    return res.json({ success: true, message: 'Quotation updated.', data: await quotationDto(quotation) });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.patch('/:id/validity', requirePermission('quotation.management'), async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    const expectedUpdatedAt = new Date(req.body?.expectedUpdatedAt);
    const requestedValidUntil = parseValidityDate(req.body?.validUntil);
    if (!reason) throw routeError(422, 'A reason is required to change quotation validity.');
    if (reason.length > 1000) throw routeError(422, 'Validity reason cannot exceed 1000 characters.');
    if (!requestedValidUntil) throw routeError(422, 'validUntil is required.');
    if (Number.isNaN(expectedUpdatedAt.getTime())) throw routeError(422, 'expectedUpdatedAt is required and must be valid.');
    const newValidUntil = effectiveValidUntil(requestedValidUntil);
    const current = await Quotation.findOne({
      _id: req.params.id,
      branch: req.branchId,
      ...quotationActorScope(req),
    });
    if (!current) throw routeError(404, 'Quotation not found.');
    if (['converted', 'cancelled', 'expired'].includes(current.status) || current.conversionState === 'full') {
      throw routeError(409, `Validity cannot be changed for a ${current.status} quotation.`);
    }
    if (newValidUntil.getTime() < new Date(current.quotationDate).getTime()) {
      throw routeError(422, 'validUntil cannot be before quotationDate.');
    }
    const now = new Date();
    if (current.conversionState === 'partial' && newValidUntil.getTime() <= now.getTime()) {
      throw routeError(409, 'A partially converted quotation cannot be expired while remaining demand is in the FIFO queue.');
    }
    const wasExpired = quotationValidity(current, now).isExpired;
    const wouldBeQueueEligible = quotationStockEligibility({
      ...current.toObject(),
      validUntil: newValidUntil,
    }, now).queueEligible;
    const requeued = wasExpired && newValidUntil.getTime() > now.getTime() && wouldBeQueueEligible;
    const update = {
      $set: {
        validUntil: newValidUntil,
        ...(requeued ? { stockQueuedAt: now } : {}),
        ...(current.tallySyncStatus === 'synced' ? { tallySyncStatus: 'pending' } : {}),
      },
      $inc: { validityVersion: 1 },
      $push: {
        validityHistory: {
          previousValidUntil: current.validUntil,
          newValidUntil,
          reason,
          changedBy: req.user._id,
          changedAt: now,
          requeued,
        },
      },
    };
    const quotation = await Quotation.findOneAndUpdate(
      {
        _id: current._id,
        branch: req.branchId,
        updatedAt: expectedUpdatedAt,
        ...quotationActorScope(req),
      },
      update,
      { new: true, runValidators: true },
    ).populate('validityHistory.changedBy', 'name email');
    if (!quotation) throw routeError(409, 'Quotation changed before validity was updated. Refresh and retry.');
    return res.json({
      success: true,
      message: requeued
        ? 'Quotation validity extended and quotation requeued behind currently valid FIFO demand.'
        : 'Quotation validity updated.',
      data: await quotationDto(quotation),
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

router.patch('/:id/status', requirePermission('quotation.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { status } = req.body;
    let quotation;
    await session.withTransaction(async () => {
      const current = await Quotation.findOne({ _id: req.params.id, branch: req.branchId, ...quotationActorScope(req) }).session(session);
      if (!current) throw routeError(404, 'Quotation not found.');
      if (current.conversionState === 'partial' && status !== 'cancelled') {
        throw routeError(409, 'A partially converted quotation must remain in its FIFO queue until fully converted or explicitly cancelled.');
      }
      if (status === 'cancelled' && current.sourceDealerOrderRequest) {
        throw routeError(409, 'A quotation linked to an approved dealer order request cannot be cancelled.');
      }
      if (!STATUS_TRANSITIONS[current.status]?.has(status)) throw routeError(409, `Cannot change quotation from "${current.status}" to "${status}".`);
      const acceptanceEligibility = status === 'accepted'
        ? quotationStockEligibility({ ...current.toObject(), status: 'accepted' })
        : null;
      if (status === 'accepted' && acceptanceEligibility.isExpired) {
        throw routeError(409, 'Expired quotation cannot be accepted. Extend its validity first.');
      }
      if (status === 'accepted' && !acceptanceEligibility.pricingApprovalSatisfied) {
        throw routeError(409, 'Quotation cannot be accepted before pricing approval.');
      }
      const statusFields = { status };
      if (['approved', 'accepted'].includes(status) && !current.stockQueuedAt) statusFields.stockQueuedAt = new Date();
      quotation = await Quotation.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: current.status, updatedAt: current.updatedAt, ...quotationActorScope(req) },
        { $set: statusFields },
        { new: true, runValidators: true, session }
      );
      if (!quotation) throw routeError(409, 'Quotation changed before the status update could be applied.');
      if (status === 'cancelled') {
        // A cancelled quotation must not keep holding stock, or the quantity stays
        // unsellable until the TTL sweeper happens to notice it.
        if (['held', 'partial'].includes(quotation.holdStatus)) {
          await releaseQuotationHold(quotation, {
            session,
            actor: req.user._id,
            reason: `Quotation ${quotation.quotationNumber} cancelled`,
            expiryState: 'released',
          });
        }
        await syncAutomaticApprovalRequest({
          branchId: req.branchId,
          type: 'quotation',
          referenceModel: 'Quotation',
          referenceId: quotation._id,
          reasons: [],
          session,
        });
      }
    });
    return res.json({
      success: true,
      message: `Quotation marked as ${status}.`,
      data: await quotationDto(quotation),
    });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.post('/:id/convert', requirePermission('quotation.management'), requirePermission('sales.order.create'), async (req, res) => {
  const mode = req.body?.mode || 'full';
  const includePartialLines = req.body?.includePartialLines === true;
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!['full', 'available'].includes(mode)) {
    return res.status(422).json({ success: false, message: 'mode must be "full" or "available".' });
  }
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }

  const sourceKey = conversionSourceKey(req.params.id, rawIdempotencyKey);
  const fingerprint = conversionFingerprint({ mode, includePartialLines });
  const actorScope = quotationActorScope(req);
  const conversionResponse = async (quotation, salesOrder, conversion, idempotent = false) => ({
    success: true,
    idempotent,
    message: idempotent
      ? `Conversion already created ${salesOrder.orderNumber}.`
      : mode === 'available'
        ? `Available stock converted to ${salesOrder.orderNumber}.`
        : `Remaining quotation converted to ${salesOrder.orderNumber}.`,
    data: { quotation: await quotationDto(quotation), salesOrder, conversion },
  });
  const findReplay = (session = null) => findConversionReplay({
    quotationId: req.params.id,
    branchId: req.branchId,
    sourceKey,
    fingerprint,
    actorScope,
    session,
  });

  try {
    const replay = await findReplay();
    if (replay) return res.json(await conversionResponse(replay.quotation, replay.salesOrder, replay.conversion, true));
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }

  const session = await mongoose.startSession();
  try {
    let result;
    let idempotent = false;
    await session.withTransaction(async () => {
      const replay = await findReplay(session);
      if (replay) {
        result = replay;
        idempotent = true;
        return;
      }
      result = await convertQuotationCore({
        quotationId: req.params.id,
        branchId: req.branchId,
        actor: req.user,
        actorScope,
        mode,
        includePartialLines,
        sourceKey,
        fingerprint,
        session,
      });
    });
    return res.json(await conversionResponse(result.quotation, result.salesOrder, result.conversion, idempotent));
  } catch (error) {
    if (error.code === 11000) {
      try {
        const replay = await findReplay();
        if (replay) return res.json(await conversionResponse(replay.quotation, replay.salesOrder, replay.conversion, true));
      } catch (replayError) {
        error = replayError;
      }
    }
    return res.status(error.status || (error.code === 11000 ? 409 : 500)).json({
      success: false,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(error.details ? { data: error.details } : {}),
      message: error.message,
    });
  } finally {
    await session.endSession();
  }
});

router.post('/:id/conversions/:conversionId/reverse', requirePermission('quotation.management'), requirePermission('sales.order.create'), async (req, res) => {
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  const reason = String(req.body?.reason || '').trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }
  if (!reason) return res.status(422).json({ success: false, message: 'A reversal reason is required.' });
  if (reason.length > 1000) return res.status(422).json({ success: false, message: 'Reversal reason cannot exceed 1000 characters.' });
  const { requestFingerprint, assertIdempotentReplay } = await import('../utils/idempotency.js');
  const reversalSourceKey = `quotation-reversal:${req.params.conversionId}:${rawIdempotencyKey}`;
  const fingerprint = requestFingerprint({ action: 'reverse', reason });
  const session = await mongoose.startSession();
  try {
    let quotation;
    let conversion;
    let salesOrder;
    let idempotent = false;
    await session.withTransaction(async () => {
      conversion = await QuotationConversion.findOne({
        _id: req.params.conversionId,
        quotation: req.params.id,
        branch: req.branchId,
      }).session(session);
      if (!conversion) throw routeError(404, 'Quotation conversion not found.');
      if (conversion.status === 'voided') {
        if (conversion.reversalSourceKey !== reversalSourceKey) {
          throw routeError(409, 'This conversion has already been reversed.');
        }
        assertIdempotentReplay({ requestFingerprint: conversion.reversalRequestFingerprint }, fingerprint);
        quotation = await Quotation.findOne({
          _id: req.params.id,
          branch: req.branchId,
          ...quotationActorScope(req),
        }).session(session);
        salesOrder = await SalesOrder.findOne({ _id: conversion.salesOrder, branch: req.branchId }).session(session);
        idempotent = true;
        return;
      }

      salesOrder = await SalesOrder.findOne({
        _id: conversion.salesOrder,
        branch: req.branchId,
        sourceQuotation: req.params.id,
      }).session(session);
      if (!salesOrder) throw routeError(409, 'Linked Sales Order could not be verified.');
      const orderIsVoid = salesOrder.status === 'cancelled' || salesOrder.approvalStatus === 'rejected';
      const hasReservation = (salesOrder.items || []).some(item => Number(item.reservedQuantity || 0) > 0.0001);
      if (!orderIsVoid || hasReservation || !['released', 'none'].includes(salesOrder.reservationStatus)) {
        throw routeError(409, 'Cancel or reject the child Sales Order and release its reservation before reversing quotation demand.');
      }

      const current = await Quotation.findOne({
        _id: req.params.id,
        branch: req.branchId,
        ...quotationActorScope(req),
      }).session(session).lean();
      if (!current) throw routeError(404, 'Quotation not found.');
      const reversalByItem = new Map();
      for (const line of conversion.lines || []) {
        const key = String(line.quotationItem);
        reversalByItem.set(key, Number(reversalByItem.get(key) || 0) + Number(line.quantity || 0));
      }
      const nextItems = (current.items || []).map((item) => {
        const decrement = Number(reversalByItem.get(String(item._id)) || 0);
        const convertedQuantity = Number(item.convertedQuantity || 0);
        if (decrement > convertedQuantity + 0.0001) {
          throw routeError(409, `Conversion history exceeds recorded quantity for ${item.productName || item.productCode || 'item'}.`);
        }
        return { ...item, convertedQuantity: Math.max(0, convertedQuantity - decrement) };
      });
      const anyConverted = nextItems.some(item => Number(item.convertedQuantity || 0) > 0.0001);
      const activeConversions = await QuotationConversion.find({
        branch: req.branchId,
        quotation: current._id,
        _id: { $ne: conversion._id },
        status: { $ne: 'voided' },
      }).sort({ createdAt: 1 }).select('createdAt').session(session).lean();
      const version = Number(current.conversionVersion || 0);
      const versionScope = version === 0
        ? { $or: [{ conversionVersion: 0 }, { conversionVersion: { $exists: false } }] }
        : { conversionVersion: version };
      quotation = await Quotation.findOneAndUpdate(
        {
          _id: current._id,
          branch: req.branchId,
          ...quotationActorScope(req),
          ...versionScope,
        },
        {
          $set: {
            items: nextItems,
            conversionState: anyConverted ? 'partial' : 'none',
            status: current.status === 'converted' ? (conversion.sourceQuotationStatus || 'accepted') : current.status,
            lastConvertedAt: activeConversions.at(-1)?.createdAt || current.firstConvertedAt || current.convertedAt,
          },
          $unset: { fullyConvertedAt: '' },
          $inc: { conversionVersion: 1 },
        },
        { new: true, session },
      );
      if (!quotation) throw routeError(409, 'Quotation changed before reversal; refresh and retry.');
      const reversed = await QuotationConversion.findOneAndUpdate(
        { _id: conversion._id, branch: req.branchId, status: { $ne: 'voided' } },
        {
          $set: {
            status: 'voided',
            reversalSourceKey,
            reversalRequestFingerprint: fingerprint,
            reversedAt: new Date(),
            reversedBy: req.user._id,
            reversalReason: reason,
          },
        },
        { new: true, runValidators: true, session },
      );
      if (!reversed) throw routeError(409, 'Conversion was reversed by another request.');
      conversion = reversed;
    });
    return res.json({
      success: true,
      idempotent,
      message: idempotent ? 'Quotation conversion was already reversed.' : 'Quotation demand reopened; no stock was moved by this reversal.',
      data: { quotation: await quotationDto(quotation), salesOrder, conversion },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({
      success: false,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      message: error.message,
    });
  } finally {
    await session.endSession();
  }
});

router.delete('/:id', requirePermission('quotation.management'), async (req, res) => {
  try {
    const existing = await Quotation.findOne({ _id: req.params.id, branch: req.branchId, ...quotationActorScope(req) }).lean();
    if (!existing) throw routeError(404, 'Quotation not found.');
    if (existing.sourceDealerOrderRequest) throw routeError(409, 'A quotation linked to an approved dealer order request cannot be deleted.');
    if (!['draft', 'cancelled'].includes(existing.status)) throw routeError(409, 'Only draft or cancelled quotations can be deleted.');
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Quotation, req.params.id, {
      user: req.user, module: 'quotation', titleField: 'dealerName', codeField: 'quotationNumber', scope: { branch: req.branchId, ...quotationActorScope(req) },
    });
    return res.status(result.status || 200).json(result);
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

// Live, FIFO-aware stock check for every quotation item. The result is
// advisory; conversion repeats this calculation and reserves exact buckets in
// the same transaction that creates the Sales Order.
router.get('/:id/check-stock', requirePermission('quotation.management'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw routeError(422, 'Quotation id is invalid.');
    const quotation = await Quotation.findOne({
      _id: req.params.id,
      branch: req.branchId,
      ...quotationActorScope(req),
    }).lean();
    if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found.' });
    const stockReadiness = await getQuotationReadiness(quotation);
    const dto = withQuotationReadiness(quotation, stockReadiness);
    return res.json({
      success: true,
      data: {
        ...stockReadiness,
        status: dto.status,
        effectiveStatus: dto.effectiveStatus,
        validUntil: dto.validUntil,
        isExpired: dto.isExpired,
        expiresInDays: dto.expiresInDays,
        conversionState: dto.conversionState,
        conversionVersion: dto.conversionVersion,
        lifecycle: {
          status: dto.status,
          effectiveStatus: dto.effectiveStatus,
          queueMode: stockReadiness.queueMode,
          eligibilityReason: stockReadiness.eligibilityReason,
        },
        validity: dto.validity,
        conversion: dto.conversion,
        quotation: dto,
        stockReadiness,
      },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

// ── Stock hold and split (SOW: quotation stock commitment) ────────────────────
//
// A quotation normally holds nothing, so "available" is only a prediction and can
// be wrong by the time a Sales Order is created. These endpoints turn it into a
// fact: an approved quotation takes a real hold on Stock (availableQty ->
// quotedQty), and if part of the demand has no stock the quotation splits into an
// available child that holds stock and a pending-stock child that waits for a GRN.
//
// The commit step re-derives the plan and refuses a stale one, so an approver can
// never unknowingly approve quantities they did not see.

/** Serialise a plan for the client without the bulky nested readiness twice over. */
const splitPlanDto = plan => ({
  planHash: plan.planHash,
  willSplit: plan.willSplit,
  canHold: plan.canHold,
  quotation: plan.quotation,
  quotationNumber: plan.quotationNumber,
  conversionVersion: plan.conversionVersion,
  available: plan.available,
  shortfall: plan.shortfall,
  totals: plan.totals,
  checkedAt: plan.checkedAt,
  holdTtlHours: holdTtlHours(),
  stockReadiness: plan.readiness,
});

async function loadHoldTarget(req, session = null) {
  let query = Quotation.findOne({
    _id: req.params.id,
    branch: req.branchId,
    ...quotationActorScope(req),
  });
  if (session) query = query.session(session);
  const quotation = await query;
  if (!quotation) throw routeError(404, 'Quotation not found.');
  return quotation;
}

// GET /api/v1/quotations/:id/split-preview
// What would happen if this quotation were approved for stock right now. Returns
// a planHash the caller must echo back, which is how drift is detected.
router.get('/:id/split-preview', requirePermission('quotation.management'), async (req, res) => {
  try {
    const quotation = await Quotation.findOne({
      _id: req.params.id,
      branch: req.branchId,
      ...quotationActorScope(req),
    }).lean();
    if (!quotation) throw routeError(404, 'Quotation not found.');
    // pending_stock is allowed so a shortfall child can be previewed before it is
    // confirmed. Readiness is evaluated as if it were approved, because a
    // pending-stock quotation is not conversion-eligible by design and would
    // otherwise report nothing allocatable.
    const previewable = HOLD_ELIGIBLE_STATUSES.has(quotation.status) || quotation.status === 'pending_stock';
    if (!previewable) {
      throw routeError(
        409,
        `A stock hold can only be taken on an approved, accepted or pending-stock quotation; this one is "${quotation.status}".`,
        'QUOTATION_NOT_HOLD_ELIGIBLE',
      );
    }
    if (quotation.holdStatus === 'held') {
      throw routeError(409, 'This quotation already holds stock.', 'QUOTATION_ALREADY_HELD');
    }
    const plan = await computeSplitPlan(
      quotation.status === 'pending_stock' ? { ...quotation, status: 'approved' } : quotation,
    );
    return res.json({ success: true, data: { ...splitPlanDto(plan), intent: quotation.status === 'pending_stock' ? 'confirm' : 'split' } });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message, code: error.code, data: error.details });
  }
});

// POST /api/v1/quotations/:id/split-approve   { planHash }
// Commits the plan: holds stock and, when part of the demand is short, splits the
// quotation into available + pending-stock children.
//
// Requires sales.order.approve as well as quotation.management: committing stock
// to a dealer is an approval decision, not an editing one.
router.post(
  '/:id/split-approve',
  requirePermission('quotation.management'),
  requirePermission('sales.order.approve'),
  async (req, res) => {
    const submittedHash = String(req.body?.planHash || '').trim();
    if (!submittedHash) {
      return res.status(422).json({ success: false, message: 'planHash is required. Fetch the split preview first.' });
    }
    const session = await mongoose.startSession();
    try {
      let result;
      let plan;
      await session.withTransaction(async () => {
        const quotation = await loadHoldTarget(req, session);
        if (!HOLD_ELIGIBLE_STATUSES.has(quotation.status)) {
          throw routeError(
            409,
            `A stock hold can only be taken on an approved or accepted quotation; this one is "${quotation.status}".`,
            'QUOTATION_NOT_HOLD_ELIGIBLE',
          );
        }
        if (quotation.holdStatus === 'held') {
          throw routeError(409, 'This quotation already holds stock.', 'QUOTATION_ALREADY_HELD');
        }

        // Recalculate from live stock and refuse a stale decision. This catches
        // drift in both directions: less stock than the approver saw, and more.
        plan = await computeSplitPlan(quotation, { session });
        if (plan.planHash !== submittedHash) {
          throw routeError(
            409,
            'Stock changed while this was being approved. Review the updated split and confirm again.',
            'SPLIT_PLAN_CHANGED',
            splitPlanDto(plan),
          );
        }
        if (!plan.canHold) {
          throw routeError(
            409,
            'No stock is currently available to hold for this quotation.',
            'INSUFFICIENT_STOCK',
            splitPlanDto(plan),
          );
        }

        if (!plan.willSplit) {
          // Everything is available, so there is nothing to split. Hold and stop.
          await placeQuotationHold(quotation, {
            plan: plan.available.map(entry => ({
              itemId: entry.itemId,
              quantity: entry.quantity,
              warehouse: entry.warehouse,
              shade: entry.shade,
              batch: entry.batch,
            })),
            session,
            actor: req.user._id,
            reason: `Quotation ${quotation.quotationNumber} stock hold`,
          });
          result = { parent: null, available: quotation, shortfall: null, splitGroupId: null };
          return;
        }

        result = await executeSplit(quotation, plan, {
          session,
          actor: req.user._id,
          reason: `Quotation ${quotation.quotationNumber} stock split`,
        });
      });

      const [parentDto, availableDto, shortfallDto] = await Promise.all([
        result.parent ? quotationDto(result.parent) : null,
        result.available ? quotationDto(result.available) : null,
        result.shortfall ? quotationDto(result.shortfall) : null,
      ]);
      return res.status(201).json({
        success: true,
        split: Boolean(result.parent),
        message: result.parent
          ? `Stock held on ${result.available?.quotationNumber}. ${result.shortfall?.quotationNumber} is pending stock.`
          : `Stock held on ${result.available?.quotationNumber}. No split was needed.`,
        data: {
          splitGroupId: result.splitGroupId,
          parent: parentDto,
          available: availableDto,
          shortfall: shortfallDto,
          heldQuantity: result.available ? totalHeldQuantity(result.available) : 0,
        },
      });
    } catch (error) {
      return res.status(error.status || (error.code === 11000 ? 409 : ['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
        .json({ success: false, message: error.message, code: error.code, data: error.details });
    } finally { await session.endSession(); }
  },
);

// POST /api/v1/quotations/:id/confirm-stock   { planHash }
// Promotes a pending-stock shortfall child once a GRN has landed: re-checks stock,
// takes a hold, and moves it to approved so it can be sent and converted.
// A shortfall child is never a firm offer until this succeeds.
router.post(
  '/:id/confirm-stock',
  requirePermission('quotation.management'),
  requirePermission('sales.order.approve'),
  async (req, res) => {
    const submittedHash = String(req.body?.planHash || '').trim();
    if (!submittedHash) {
      return res.status(422).json({ success: false, message: 'planHash is required. Fetch the split preview first.' });
    }
    const session = await mongoose.startSession();
    try {
      let quotation;
      let plan;
      await session.withTransaction(async () => {
        quotation = await loadHoldTarget(req, session);
        if (quotation.status !== 'pending_stock') {
          throw routeError(
            409,
            `Only a pending-stock quotation can be confirmed; this one is "${quotation.status}".`,
            'QUOTATION_NOT_PENDING_STOCK',
          );
        }
        // Temporarily evaluate as approved so readiness treats it as convertible
        // demand; the real status change happens below only if the hold succeeds.
        const asApproved = { ...quotation.toObject(), status: 'approved' };
        plan = await computeSplitPlan(asApproved, { session });
        if (plan.planHash !== submittedHash) {
          throw routeError(
            409,
            'Stock changed while this was being confirmed. Review the updated figures and confirm again.',
            'SPLIT_PLAN_CHANGED',
            splitPlanDto(plan),
          );
        }
        if (plan.willSplit) {
          throw routeError(
            409,
            'Stock is still short for this quotation. Split it again or wait for the remaining stock.',
            'INSUFFICIENT_STOCK',
            splitPlanDto(plan),
          );
        }
        if (!plan.canHold) {
          throw routeError(409, 'No stock is available for this quotation yet.', 'INSUFFICIENT_STOCK', splitPlanDto(plan));
        }
        await placeQuotationHold(quotation, {
          plan: plan.available.map(entry => ({
            itemId: entry.itemId,
            quantity: entry.quantity,
            warehouse: entry.warehouse,
            shade: entry.shade,
            batch: entry.batch,
          })),
          session,
          actor: req.user._id,
          reason: `Quotation ${quotation.quotationNumber} stock confirmed`,
        });
        quotation.status = 'approved';
        quotation.stockQueuedAt = quotation.stockQueuedAt || new Date();
        await quotation.save({ session });
      });
      return res.json({
        success: true,
        message: `Stock confirmed and held. ${quotation.quotationNumber} can now be sent and converted.`,
        data: await quotationDto(quotation),
      });
    } catch (error) {
      return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
        .json({ success: false, message: error.message, code: error.code, data: error.details });
    } finally { await session.endSession(); }
  },
);

// POST /api/v1/quotations/:id/hold/release   { reason }
// Gives held stock back without cancelling the quotation. The quotation keeps its
// FIFO position; it simply stops guaranteeing the quantity.
router.post('/:id/hold/release', requirePermission('quotation.management'), async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(422).json({ success: false, message: 'A reason is required to release a stock hold.' });
  if (reason.length > 1000) return res.status(422).json({ success: false, message: 'Reason cannot exceed 1000 characters.' });
  const session = await mongoose.startSession();
  try {
    let quotation;
    await session.withTransaction(async () => {
      quotation = await loadHoldTarget(req, session);
      if (!['held', 'partial'].includes(quotation.holdStatus)) {
        throw routeError(409, 'This quotation is not holding any stock.', 'NO_ACTIVE_HOLD');
      }
      await releaseQuotationHold(quotation, {
        session,
        actor: req.user._id,
        reason,
        expiryState: 'released',
      });
    });
    return res.json({ success: true, message: 'Stock hold released.', data: await quotationDto(quotation) });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message, code: error.code });
  } finally { await session.endSession(); }
});

// PATCH /api/v1/quotations/:id/hold/extend   { expiresAt, reason }
// Pushes the hold expiry out. Only ever extends, never shortens.
router.patch('/:id/hold/extend', requirePermission('quotation.management'), async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    const requested = new Date(req.body?.expiresAt);
    if (!reason) throw routeError(422, 'A reason is required to extend a stock hold.');
    if (reason.length > 1000) throw routeError(422, 'Reason cannot exceed 1000 characters.');
    if (Number.isNaN(requested.getTime())) throw routeError(422, 'expiresAt must be a valid date.');

    const current = await loadHoldTarget(req);
    if (!['held', 'partial'].includes(current.holdStatus)) {
      throw routeError(409, 'This quotation is not holding any stock.', 'NO_ACTIVE_HOLD');
    }
    if (current.holdExpiresAt && requested.getTime() <= new Date(current.holdExpiresAt).getTime()) {
      throw routeError(422, 'A hold expiry can only be extended, never shortened.', 'HOLD_EXPIRY_NOT_EXTENDED');
    }
    const version = Math.max(1, Number(current.holdExpiryVersion || 0)) + 1;
    const quotation = await Quotation.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, holdExpiryVersion: current.holdExpiryVersion, ...quotationActorScope(req) },
      {
        $set: {
          holdExpiresAt: requested,
          holdExpiryState: 'extended',
          holdExpiryVersion: version,
        },
        $push: {
          holdExtensions: {
            version,
            previousExpiresAt: current.holdExpiresAt,
            extendedTo: requested,
            reason,
            extendedBy: req.user._id,
            extendedAt: new Date(),
          },
        },
      },
      { new: true, runValidators: true },
    );
    if (!quotation) throw routeError(409, 'The hold changed before it could be extended. Refresh and retry.');
    return res.json({ success: true, message: 'Stock hold extended.', data: await quotationDto(quotation) });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message, code: error.code });
  }
});

// GET /api/v1/quotations/:id/split-family
// Every member of a split: the immutable parent and both children.
router.get('/:id/split-family', requirePermission('quotation.management'), async (req, res) => {
  try {
    const quotation = await Quotation.findOne({
      _id: req.params.id,
      branch: req.branchId,
      ...quotationActorScope(req),
    }).select('branch splitGroupId splitRole splitFromQuotation splitQuotations').lean();
    if (!quotation) throw routeError(404, 'Quotation not found.');
    return res.json({
      success: true,
      data: {
        splitGroupId: quotation.splitGroupId || null,
        splitRole: quotation.splitRole || 'none',
        members: await loadSplitFamily(quotation),
      },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
      .json({ success: false, message: error.message });
  }
});

export default router;
