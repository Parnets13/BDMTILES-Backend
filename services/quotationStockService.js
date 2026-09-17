import Quotation from '../models/Quotation.js';
import Stock from '../models/Stock.js';
import { quotationValidity, withQuotationValidity } from '../utils/quotationValidity.js';
import { resolveStockUom } from './stockUomService.js';

export const QUOTATION_STOCK_TOLERANCE = 0.0001;
export const QUOTATION_QUEUE_STATUSES = ['approved', 'accepted', 'sent'];

const idOf = value => String(value?._id || value || '');
const numberOf = value => Number(value || 0);
const rounded = value => Math.round((numberOf(value) + Number.EPSILON) * 1e6) / 1e6;
const stockId = row => idOf(row._id) || [
  idOf(row.branch), idOf(row.product), idOf(row.warehouse), row.shade || '', row.batch || '',
].join('|');

function quantitiesForLine(line) {
  const quotedQty = rounded(Math.max(0, numberOf(line.quantity)));
  const convertedQty = rounded(Math.min(quotedQty, Math.max(0, numberOf(line.convertedQuantity))));
  return {
    quotedQty,
    convertedQty,
    remainingQty: rounded(Math.max(0, quotedQty - convertedQty)),
  };
}

function uomSnapshotForLine(line) {
  const quantities = quantitiesForLine(line);
  const conversionFactor = Number(line?.conversionFactor);
  const baseQuantity = Number(line?.baseQuantity);
  const uomVersion = Number(line?.uomVersion);
  const uomPrecision = Number(line?.uomPrecision);
  const uomAllowFraction = line?.uomAllowFraction;
  const precisionScale = Number.isInteger(uomPrecision) && uomPrecision >= 0 && uomPrecision <= 6
    ? 10 ** uomPrecision
    : null;
  const quantityConformsToPrecision = precisionScale !== null
    && Math.abs(quantities.quotedQty * precisionScale - Math.round(quantities.quotedQty * precisionScale)) <= 1e-8;
  const convertedConformsToPrecision = precisionScale !== null
    && Math.abs(quantities.convertedQty * precisionScale - Math.round(quantities.convertedQty * precisionScale)) <= 1e-8;
  const fractionPolicySatisfied = uomAllowFraction === true
    || (uomAllowFraction === false
      && Math.abs(quantities.quotedQty - Math.round(quantities.quotedQty)) <= 1e-8
      && Math.abs(quantities.convertedQty - Math.round(quantities.convertedQty)) <= 1e-8);
  const valid = Number.isFinite(conversionFactor) && conversionFactor > 0
    && Number.isFinite(baseQuantity) && baseQuantity >= 0
    && Math.abs(baseQuantity - quantities.quotedQty * conversionFactor) <= Math.max(
      QUOTATION_STOCK_TOLERANCE,
      Math.abs(baseQuantity) * 1e-8,
    )
    && Boolean(String(line?.baseUnit || '').trim())
    && Number.isInteger(uomVersion) && uomVersion >= 1
    && Number.isInteger(uomPrecision) && uomPrecision >= 0 && uomPrecision <= 6
    && typeof uomAllowFraction === 'boolean'
    && quantityConformsToPrecision && convertedConformsToPrecision
    && fractionPolicySatisfied;
  return {
    valid,
    conversionFactor: valid ? conversionFactor : null,
    baseUnit: valid ? String(line.baseUnit) : null,
    uomVersion: valid ? uomVersion : null,
    precision: valid ? uomPrecision : null,
    allowFraction: valid ? uomAllowFraction : null,
    quotedBaseQty: valid ? rounded(baseQuantity) : null,
    convertedBaseQty: valid ? rounded(quantities.convertedQty * conversionFactor) : null,
    remainingBaseQty: valid ? rounded(quantities.remainingQty * conversionFactor) : null,
  };
}

export async function applyQuotationUomSnapshots(items, { session = null, at = new Date() } = {}) {
  return Promise.all((items || []).map(async (item) => {
    const snapshot = await resolveStockUom({
      product: item.product,
      enteredQuantity: item.quantity,
      enteredUnit: item.unit,
      at,
      session,
    });
    if (Math.abs(Number(item.quantity) - snapshot.enteredQuantity) > 1e-9) {
      const error = new Error(`${snapshot.enteredUnit} quantity must use at most ${snapshot.precision} decimal place${snapshot.precision === 1 ? '' : 's'}.`);
      error.status = 422;
      throw error;
    }
    return {
      ...item,
      quantity: snapshot.enteredQuantity,
      unit: snapshot.enteredUnit,
      baseQuantity: snapshot.baseQuantity,
      baseUnit: snapshot.baseUnit,
      conversionFactor: snapshot.conversionFactor,
      uomVersion: snapshot.uomVersion,
      uomPrecision: snapshot.precision,
      uomAllowFraction: snapshot.allowFraction,
    };
  }));
}

export function quotationConversionState(quotation) {
  const items = quotation?.items || [];
  const hasItems = items.length > 0;
  const allConverted = hasItems && items.every(item => quantitiesForLine(item).remainingQty <= QUOTATION_STOCK_TOLERANCE);
  const anyConverted = items.some(item => quantitiesForLine(item).convertedQty > QUOTATION_STOCK_TOLERANCE);
  const hasLineage = Boolean(quotation?.convertedToSO)
    || (quotation?.convertedSalesOrders || []).length > 0;
  if (quotation?.status === 'converted' || quotation?.conversionState === 'full' || allConverted) return 'full';
  if (quotation?.conversionState === 'partial' || anyConverted) return 'partial';
  // An explicit none is authoritative after a safe reversal. Historical child
  // order references remain for audit and must not reopen conversion state.
  if (quotation?.conversionState === 'none') return 'none';
  if (hasLineage) return 'partial';
  return 'none';
}

const validQueueTimestamp = (value) => Boolean(value && !Number.isNaN(new Date(value).getTime()));

export function quotationStockEligibility(quotation, now = new Date()) {
  const status = quotation?.status || 'draft';
  const conversionState = quotationConversionState(quotation);
  const approvalReasons = quotation?.approvalReasons || [];
  const unresolvedApprovalReason = approvalReasons.some(reason => reason?.status !== 'approved');
  const approvalStatus = quotation?.approvalStatus || (quotation?.approvalRequired ? 'pending' : 'not_required');
  const pricingApprovalSatisfied = approvalStatus !== 'pending'
    && approvalStatus !== 'rejected'
    && (!quotation?.approvalRequired || approvalStatus === 'approved')
    && !unresolvedApprovalReason;
  const validity = quotationValidity({ ...quotation, conversionState }, now);
  const terminal = ['converted', 'cancelled', 'expired'].includes(status) || conversionState === 'full';
  const uomSnapshotSatisfied = (quotation?.items || [])
    .filter(item => quantitiesForLine(item).remainingQty > QUOTATION_STOCK_TOLERANCE)
    .every(item => uomSnapshotForLine(item).valid);
  const hasQueueTimestamp = validQueueTimestamp(quotation?.stockQueuedAt);
  const approvedOrAccepted = ['approved', 'accepted'].includes(status);
  const approvedOriginSent = status === 'sent' && hasQueueTimestamp;

  let queueEligible = false;
  let conversionEligible = false;
  let reason = 'status_not_approved_or_accepted';
  if (terminal) reason = 'terminal_or_fully_converted';
  else if (validity.isExpired) reason = 'expired';
  else if (!pricingApprovalSatisfied) reason = 'pricing_approval_not_satisfied';
  else if ((approvedOrAccepted || status === 'sent') && !uomSnapshotSatisfied) reason = 'uom_snapshot_missing_or_invalid';
  else if (approvedOrAccepted && !hasQueueTimestamp) reason = 'missing_queue_timestamp';
  else if (approvedOrAccepted) {
    queueEligible = true;
    conversionEligible = true;
    reason = 'eligible_fifo';
  } else if (approvedOriginSent) {
    queueEligible = true;
    reason = 'sent_preserving_approved_fifo';
  } else if (status === 'sent' && quotation?.stockQueuedAt) {
    reason = 'invalid_queue_timestamp';
  } else if (status === 'sent' && validQueueTimestamp(quotation?.approvalDate)) {
    reason = 'missing_queue_timestamp';
  } else if (status === 'sent') {
    reason = 'sent_not_previously_queued';
  }

  return {
    queueEligible,
    conversionEligible,
    queueMode: queueEligible ? 'queued_fifo' : 'physical_only',
    pricingApprovalSatisfied,
    uomSnapshotSatisfied,
    isExpired: validity.isExpired,
    terminal,
    conversionState,
    reason,
  };
}

export function withQuotationReadiness(quotation, readiness) {
  const source = quotation?.toObject ? quotation.toObject() : quotation;
  const conversionState = quotationConversionState(source);
  const conversionVersion = Math.max(0, numberOf(source?.conversionVersion));
  const dto = withQuotationValidity({ ...source, conversionState });
  return {
    ...dto,
    conversionState,
    conversionVersion,
    validity: {
      validUntil: dto.validUntil || null,
      isExpired: dto.isExpired,
      expiresInDays: dto.expiresInDays,
      effectiveStatus: dto.effectiveStatus,
      version: Math.max(0, numberOf(source?.validityVersion)),
    },
    conversion: { state: conversionState, version: conversionVersion },
    snapshotCaptured: source?.snapshotCaptured === true || Boolean(source?.stockSnapshotAt),
    stockReadiness: readiness,
  };
}

function matchesLine(row, line) {
  if (idOf(row.product) !== idOf(line.product)) return false;
  if (line.warehouse && idOf(row.warehouse) !== idOf(line.warehouse)) return false;
  if (line.shade && String(row.shade || '') !== String(line.shade)) return false;
  if (line.batch && String(row.batch || '') !== String(line.batch)) return false;
  return true;
}

function candidateRows(stockRows, line, remaining, requiredQty) {
  return stockRows
    .filter(row => matchesLine(row, line) && numberOf(remaining.get(stockId(row))) > QUOTATION_STOCK_TOLERANCE)
    .sort((left, right) => {
      const leftQty = numberOf(remaining.get(stockId(left)));
      const rightQty = numberOf(remaining.get(stockId(right)));
      const leftEnough = leftQty + QUOTATION_STOCK_TOLERANCE >= requiredQty;
      const rightEnough = rightQty + QUOTATION_STOCK_TOLERANCE >= requiredQty;
      if (leftEnough !== rightEnough) return leftEnough ? -1 : 1;
      if (leftEnough && rightEnough && leftQty !== rightQty) return leftQty - rightQty;
      if (!leftEnough && !rightEnough && rightQty !== leftQty) return rightQty - leftQty;
      return [idOf(left.warehouse), left.shade || '', left.batch || '', stockId(left)].join('|')
        .localeCompare([idOf(right.warehouse), right.shade || '', right.batch || '', stockId(right)].join('|'));
    });
}

function summarize(itemResults, { queued, checkedAt, eligibility }) {
  const remainingItems = itemResults.filter(item => item.remainingQty > QUOTATION_STOCK_TOLERANCE);
  const availableItems = remainingItems.filter(item => item.status === 'available').length;
  const partialItems = remainingItems.filter(item => item.status === 'partial').length;
  const outOfStockItems = remainingItems.filter(item => item.status === 'out_of_stock').length;
  const invalidItems = remainingItems.filter(item => item.status === 'unknown').length;
  const totalQuotedQty = rounded(itemResults.reduce((sum, item) => sum + item.quotedQty, 0));
  const totalConvertedQty = rounded(itemResults.reduce((sum, item) => sum + item.convertedQty, 0));
  const totalRequiredQty = rounded(remainingItems.reduce((sum, item) => sum + item.requiredQty, 0));
  const totalAllocatedQty = rounded(remainingItems.reduce((sum, item) => sum + item.allocatedQty, 0));
  let overallStatus = 'unknown';
  if (!remainingItems.length && itemResults.length) overallStatus = 'fully_converted';
  else if (invalidItems) overallStatus = 'unknown';
  else if (remainingItems.length) {
    if (availableItems === remainingItems.length) overallStatus = 'available';
    else if (totalAllocatedQty > QUOTATION_STOCK_TOLERANCE) overallStatus = 'partial';
    else overallStatus = 'out_of_stock';
  }
  const resolvedEligibility = eligibility || {
    queueEligible: false,
    conversionEligible: false,
    pricingApprovalSatisfied: false,
    reason: 'not_evaluated',
  };
  return {
    overallStatus,
    allStockAvailable: overallStatus === 'available',
    anyStockAvailable: invalidItems === 0 && totalAllocatedQty > QUOTATION_STOCK_TOLERANCE,
    fullyConverted: overallStatus === 'fully_converted',
    queued: Boolean(queued),
    queueMode: queued ? 'queued_fifo' : 'physical_only',
    eligibleForQueue: Boolean(resolvedEligibility.queueEligible),
    eligibleForConversion: Boolean(resolvedEligibility.conversionEligible),
    eligibilityReason: resolvedEligibility.reason,
    eligibility: resolvedEligibility,
    allocationMode: 'single_exact_bucket',
    totalItems: itemResults.length,
    remainingItems: remainingItems.length,
    convertedItems: itemResults.length - remainingItems.length,
    availableItems,
    partialItems,
    outOfStockItems,
    invalidItems,
    totalQuotedQty,
    totalConvertedQty,
    totalRemainingQty: totalRequiredQty,
    totalRequiredQty,
    totalAllocatedQty,
    totalShortfallQty: rounded(Math.max(0, totalRequiredQty - totalAllocatedQty)),
    checkedAt,
    items: itemResults,
  };
}

/**
 * Virtually allocates one exact Stock bucket to each quotation line's remaining
 * quantity. Empty warehouse/shade/batch values are unspecified constraints. A
 * line is never silently mixed across shades/batches/warehouses.
 */
export function calculateQuotationReadiness(quotation, stockRows, remainingByStockId = null, options = {}) {
  const checkedAt = options.checkedAt || new Date();
  const eligibility = options.eligibility || quotationStockEligibility(quotation, checkedAt);
  const remaining = remainingByStockId || new Map(stockRows.map(row => [stockId(row), rounded(row.availableQty)]));
  const lines = quotation?.items || [];
  const items = lines.map((line, index) => {
    const quantities = quantitiesForLine(line);
    const uom = uomSnapshotForLine(line);
    return {
      itemId: idOf(line._id) || String(index),
      itemIndex: index,
      productId: idOf(line.product),
      productName: line.productName || line.product?.itemName || '',
      productCode: line.productCode || line.product?.productCode || '',
      unit: line.unit || '',
      baseUnit: uom.baseUnit,
      conversionFactor: uom.conversionFactor,
      uomVersion: uom.uomVersion,
      uomPrecision: uom.precision,
      uomAllowFraction: uom.allowFraction,
      quotedBaseQty: uom.quotedBaseQty,
      convertedBaseQty: uom.convertedBaseQty,
      remainingBaseQty: uom.remainingBaseQty,
      uomSnapshotValid: uom.valid,
      ...quantities,
      requiredQty: quantities.remainingQty,
      quantityRequired: quantities.remainingQty,
      requiredBaseQty: uom.remainingBaseQty,
      allocatedQty: 0,
      allocatedBaseQty: 0,
      availableQty: 0,
      shortfallQty: quantities.remainingQty,
      shortfallBaseQty: uom.remainingBaseQty,
      status: quantities.remainingQty <= QUOTATION_STOCK_TOLERANCE
        ? 'converted'
        : uom.valid ? 'out_of_stock' : 'unknown',
      hasStock: false,
      allocation: null,
    };
  });
  const allocationOrder = lines.map((line, index) => ({
    line,
    index,
    requiredQty: items[index].remainingQty,
    requiredBaseQty: items[index].requiredBaseQty,
    conversionFactor: items[index].conversionFactor,
    precision: items[index].uomPrecision,
    allowFraction: items[index].uomAllowFraction,
    uomSnapshotValid: items[index].uomSnapshotValid,
    specificity: Number(Boolean(line.warehouse)) + Number(Boolean(line.shade)) + Number(Boolean(line.batch)),
  })).filter(entry => entry.uomSnapshotValid && entry.requiredQty > QUOTATION_STOCK_TOLERANCE).sort((left, right) =>
    right.specificity - left.specificity
    || right.requiredBaseQty - left.requiredBaseQty
    || left.index - right.index
  );

  for (const { line, index, requiredQty, requiredBaseQty, conversionFactor, precision, allowFraction } of allocationOrder) {
    const candidates = candidateRows(stockRows, line, remaining, requiredBaseQty);
    const selected = candidates[0];
    const selectedKey = selected ? stockId(selected) : null;
    const bucketAvailableBaseQty = selected ? rounded(remaining.get(selectedKey)) : 0;
    const maximumEnteredQty = Math.min(requiredQty, bucketAvailableBaseQty / conversionFactor);
    const precisionScale = 10 ** precision;
    const allocatedQty = rounded(allowFraction
      ? Math.floor((maximumEnteredQty + Number.EPSILON) * precisionScale) / precisionScale
      : Math.floor(maximumEnteredQty));
    const allocatedBaseQty = rounded(allocatedQty * conversionFactor);
    if (selectedKey) remaining.set(selectedKey, rounded(Math.max(0, bucketAvailableBaseQty - allocatedBaseQty)));
    const shortfallQty = rounded(Math.max(0, requiredQty - allocatedQty));
    const shortfallBaseQty = rounded(Math.max(0, requiredBaseQty - allocatedBaseQty));
    const status = shortfallBaseQty <= QUOTATION_STOCK_TOLERANCE
      ? 'available'
      : allocatedBaseQty > QUOTATION_STOCK_TOLERANCE
        ? 'partial'
        : 'out_of_stock';
    Object.assign(items[index], {
      allocatedQty,
      allocatedBaseQty,
      availableQty: allocatedQty,
      shortfallQty,
      shortfallBaseQty,
      status,
      hasStock: status === 'available',
      allocation: selected ? {
        stockId: selected._id,
        warehouse: selected.warehouse,
        shade: selected.shade || '',
        batch: selected.batch || '',
        bucketAvailableQty: rounded(bucketAvailableBaseQty / conversionFactor),
        bucketAvailableBaseQty,
        baseUnit: items[index].baseUnit,
      } : null,
    });
  }
  return summarize(items, { queued: Boolean(options.queued), checkedAt, eligibility });
}

async function loadStockRows(branchId, productIds, session = null) {
  if (!productIds.length) return [];
  let query = Stock.find({
    branch: branchId,
    product: { $in: productIds },
    availableQty: { $gt: QUOTATION_STOCK_TOLERANCE },
  }).select('_id branch product warehouse shade batch availableQty createdAt lastGRNDate').lean();
  if (session) query = query.session(session);
  return query;
}

function queueTime(quotation) {
  return new Date(quotation.stockQueuedAt).getTime();
}

function queueSort(left, right) {
  return queueTime(left) - queueTime(right)
    || new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
    || idOf(left._id).localeCompare(idOf(right._id));
}

export function allocateQuotationReadiness({
  queueCandidates = [], requested = [], stockRows = [], checkedAt = new Date(),
}) {
  const queuedQuotations = queueCandidates
    .map(quotation => ({ quotation, eligibility: quotationStockEligibility(quotation, checkedAt) }))
    .filter(entry => entry.eligibility.queueEligible)
    .sort((left, right) => queueSort(left.quotation, right.quotation));
  const remaining = new Map(stockRows.map(row => [stockId(row), rounded(row.availableQty)]));
  const result = new Map();
  for (const { quotation, eligibility } of queuedQuotations) {
    result.set(idOf(quotation._id), calculateQuotationReadiness(quotation, stockRows, remaining, {
      queued: true,
      checkedAt,
      eligibility,
    }));
  }
  for (const quotation of requested) {
    const key = idOf(quotation._id);
    if (result.has(key)) continue;
    result.set(key, calculateQuotationReadiness(quotation, stockRows, null, {
      queued: false,
      checkedAt,
      eligibility: quotationStockEligibility(quotation, checkedAt),
    }));
  }
  return result;
}

/**
 * Returns readiness for requested quotations. Queue-eligible quotations share
 * one FIFO virtual stock pool; sent quotations retain an approved queue position
 * only when they already have stockQueuedAt. Other records are physical-only.
 */
export async function getQuotationReadinessMap({ branchId, quotations = [], session = null }) {
  const now = new Date();
  let queueQuery = Quotation.find({
    branch: branchId,
    status: { $in: QUOTATION_QUEUE_STATUSES },
    conversionState: { $ne: 'full' },
  }).select('_id items status stockQueuedAt approvalDate createdAt validUntil conversionState approvalRequired approvalStatus approvalReasons convertedToSO convertedSalesOrders').lean();
  if (session) queueQuery = queueQuery.session(session);
  const queueCandidates = await queueQuery;
  const requested = quotations.map(value => value?.toObject ? value.toObject() : value).filter(Boolean);
  const allForProducts = [...queueCandidates, ...requested];
  const productIds = [...new Set(allForProducts.flatMap(quotation =>
    (quotation.items || [])
      .filter(item => quantitiesForLine(item).remainingQty > QUOTATION_STOCK_TOLERANCE)
      .map(item => idOf(item.product))
      .filter(Boolean)
  ))];
  const stockRows = await loadStockRows(branchId, productIds, session);
  return allocateQuotationReadiness({ queueCandidates, requested, stockRows, checkedAt: now });
}

export async function getQuotationReadiness(quotation, options = {}) {
  const branchId = quotation?.branch?._id || quotation?.branch;
  const map = await getQuotationReadinessMap({
    branchId,
    quotations: [quotation],
    session: options.session || null,
  });
  const eligibility = quotationStockEligibility(quotation);
  return map.get(idOf(quotation?._id)) || summarize([], {
    queued: false,
    checkedAt: new Date(),
    eligibility,
  });
}

/** Captures a server-owned historical snapshot; it is never used as live truth. */
export async function applyQuotationStockSnapshot(items, branchId, { session = null } = {}) {
  const productIds = [...new Set((items || []).map(item => idOf(item.product)).filter(Boolean))];
  const stockRows = await loadStockRows(branchId, productIds, session);
  const readiness = calculateQuotationReadiness({ items }, stockRows, null, { queued: false });
  return (items || []).map((item, index) => ({
    ...item,
    stockAtQuotation: readiness.items[index]?.allocatedQty || 0,
    outOfStock: readiness.items[index]?.status !== 'available',
  }));
}

export function applyReadinessAllocations(items, readiness) {
  return (items || []).map((item, index) => {
    const allocation = readiness?.items?.[index]?.allocation;
    if (!allocation) return item;
    return {
      ...item,
      warehouse: allocation.warehouse,
      shade: allocation.shade,
      batch: allocation.batch,
    };
  });
}
