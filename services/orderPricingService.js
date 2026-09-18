import mongoose from 'mongoose';
import Product from '../models/Product.js';
import { pricingAuditSnapshot, resolvePricing } from './pricingResolver.js';
import { roundMoney } from '../utils/pricingCalculations.js';
import { normalizeUom } from './stockUomService.js';

function routeError(status, message) {
  return Object.assign(new Error(message), { status });
}
function finiteNonNegative(value, field, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) throw routeError(422, `${field} must be a non-negative finite number.`);
  return number;
}
function quantityValue(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw routeError(422, `${field} must be greater than zero.`);
  return number;
}
const fieldProvided = (item, field) => {
  if (!Object.prototype.hasOwnProperty.call(item, field) || item[field] === undefined || item[field] === null || item[field] === '') return false;
  // Persisted legacy items used zero defaults for omitted display UOMs.
  return !(item._id && Number(item[field]) === 0 && field !== 'quantity');
};
const roundQuantity = value => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
const quantitiesMatch = (left, right) => Math.abs(left - right) <= Math.max(0.0001, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);

export async function normalizeOrderItemsUom(items, session = null, { requireItemUnit = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw routeError(422, 'At least one item is required.');
  const productIds = items.map((item, index) => {
    const id = item.product?._id || item.product;
    if (!mongoose.isValidObjectId(id)) throw routeError(422, `items[${index}].product must be valid.`);
    return id;
  });
  let query = Product.find({ _id: { $in: productIds } }).lean();
  if (session) query = query.session(session);
  const products = await query;
  const byId = new Map(products.map(product => [String(product._id), product]));

  return items.map((item, index) => {
    const product = byId.get(String(productIds[index]));
    if (!product) throw routeError(404, `Product not found for items[${index}].`);
    if (product.status !== 'active') throw routeError(422, `Product ${product.productCode || product._id} is not active.`);
    if (requireItemUnit) {
      if (!String(item.unit || '').trim()) throw routeError(422, `items[${index}].unit is required.`);
      const requestedUnit = normalizeUom(item.unit);
      const commercialUnit = normalizeUom(product.unit || 'Unit');
      const configuredUnits = new Set([commercialUnit, ...(product.uomConversions || []).map(row => normalizeUom(row.uom))]);
      if (!configuredUnits.has(requestedUnit)) throw routeError(422, `items[${index}].unit is not configured for product ${product.productCode || product._id}.`);
      if (requestedUnit !== commercialUnit) throw routeError(422, `items[${index}].unit must match the product commercial unit ${commercialUnit}.`);
      const quantity = roundQuantity(quantityValue(item.quantity, `items[${index}].quantity`));
      const piecesPerBox = finiteNonNegative(product.piecesPerBox, `items[${index}].piecesPerBox`);
      const sqftPerBox = finiteNonNegative(product.sqftPerBox, `items[${index}].sqftPerBox`);
      return {
        source: {
          ...item,
          product: product._id,
          unit: requestedUnit,
          quantity,
          boxes: requestedUnit === 'Box' ? quantity : 0,
          pieces: requestedUnit === 'Piece' ? quantity : requestedUnit === 'Box' && piecesPerBox > 0 ? roundQuantity(quantity * piecesPerBox) : 0,
          sqft: requestedUnit === 'Sqft' ? quantity : requestedUnit === 'Box' && sqftPerBox > 0 ? roundQuantity(quantity * sqftPerBox) : 0,
        },
        product,
        quantity,
      };
    }
    const piecesPerBox = finiteNonNegative(product.piecesPerBox, `items[${index}].piecesPerBox`);
    const sqftPerBox = finiteNonNegative(product.sqftPerBox, `items[${index}].sqftPerBox`);
    if (!(piecesPerBox > 0) || !(sqftPerBox > 0)) {
      throw routeError(422, `Product ${product.productCode || product.itemName} requires positive piecesPerBox and sqftPerBox conversions.`);
    }
    const candidates = [];
    if (fieldProvided(item, 'quantity')) candidates.push({ field: 'quantity', boxes: quantityValue(item.quantity, `items[${index}].quantity`) });
    if (fieldProvided(item, 'boxes')) candidates.push({ field: 'boxes', boxes: quantityValue(item.boxes, `items[${index}].boxes`) });
    if (fieldProvided(item, 'pieces')) {
      const pieces = quantityValue(item.pieces, `items[${index}].pieces`);
      candidates.push({ field: 'pieces', boxes: pieces / piecesPerBox });
    }
    if (fieldProvided(item, 'sqft')) {
      const sqft = quantityValue(item.sqft, `items[${index}].sqft`);
      candidates.push({ field: 'sqft', boxes: sqft / sqftPerBox });
    }
    if (!candidates.length) throw routeError(422, `items[${index}] requires quantity, boxes, pieces, or sqft.`);
    const boxes = candidates[0].boxes;
    const inconsistent = candidates.find(candidate => !quantitiesMatch(candidate.boxes, boxes));
    if (inconsistent) {
      throw routeError(422, `items[${index}].${inconsistent.field} is inconsistent with ${candidates[0].field} for product packaging.`);
    }
    const canonicalBoxes = roundQuantity(boxes);
    return {
      source: {
        ...item,
        product: product._id,
        quantity: canonicalBoxes,
        boxes: canonicalBoxes,
        pieces: roundQuantity(canonicalBoxes * piecesPerBox),
        sqft: roundQuantity(canonicalBoxes * sqftPerBox),
      },
      product,
      quantity: canonicalBoxes,
    };
  });
}
async function loadPreservedResolution(item, quantity, session) {
  const productId = item.product?._id || item.product;
  if (!mongoose.isValidObjectId(productId)) throw routeError(422, 'Each item requires a valid product.');
  let query = Product.findById(productId);
  if (session) query = query.session(session);
  const product = await query.lean();
  if (!product) throw routeError(404, 'Product not found.');
  if (product.status !== 'active') throw routeError(422, `Product ${product.productCode || product._id} is not active.`);
  const snapshot = item.pricingSnapshot;
  if (!snapshot || !Number.isFinite(Number(snapshot.effectiveRate))) return null;
  const effectiveRate = roundMoney(finiteNonNegative(snapshot.effectiveRate, 'pricingSnapshot.effectiveRate'));
  const pricingRate = roundMoney(finiteNonNegative(snapshot.pricingRate, 'pricingSnapshot.pricingRate', effectiveRate));
  const regularDiscountPerUnit = roundMoney(finiteNonNegative(snapshot.regularDiscountPerUnit, 'pricingSnapshot.regularDiscountPerUnit'));
  const schemeDiscountPerUnit = roundMoney(finiteNonNegative(snapshot.schemeDiscountPerUnit, 'pricingSnapshot.schemeDiscountPerUnit'));
  const minimumSellingRate = roundMoney(finiteNonNegative(product.minimumSellingRate, 'minimumSellingRate'));
  return {
    product,
    quantity,
    dealer: null,
    dealerType: null,
    source: snapshot.source || 'product_tier',
    sourceId: snapshot.sourceId || null,
    sourceName: snapshot.sourceName || 'Accepted quotation snapshot',
    overrideScope: snapshot.overrideScope || null,
    requestedTier: snapshot.requestedTier,
    rateField: snapshot.rateField,
    baseRate: finiteNonNegative(snapshot.baseRate, 'pricingSnapshot.baseRate', pricingRate),
    pricingRate,
    regularDiscountPerUnit,
    regularDiscountAmount: roundMoney(regularDiscountPerUnit * quantity),
    schemeDiscountPerUnit,
    schemeDiscountAmount: roundMoney(schemeDiscountPerUnit * quantity),
    effectiveRate,
    taxableAmount: roundMoney(effectiveRate * quantity),
    minimumSellingRate,
    belowMinimum: minimumSellingRate > 0 && effectiveRate < minimumSellingRate,
    requiresApproval: minimumSellingRate > 0 && effectiveRate < minimumSellingRate,
    fallbackApplied: Boolean(snapshot.fallbackApplied),
    slab: snapshot.slab || null,
    rule: snapshot.rule || null,
  };
}
function approvalKey(reason) {
  return `${reason.type}:${reason.itemIndex ?? ''}:${reason.product ? String(reason.product) : ''}:${reason.subject || ''}`;
}
export function mergeApprovalReasons(generated, existing = [], options = {}) {
  const oldByKey = new Map((existing || []).map((reason) => [approvalKey(reason), reason.toObject?.() || reason]));
  return generated.map((reason) => {
    const old = oldByKey.get(approvalKey(reason));
    const sameExposure = old
      && Number(old.requestedValue) === Number(reason.requestedValue)
      && Number(old.thresholdValue) === Number(reason.thresholdValue);
    const preserve = sameExposure && (
      ['credit_limit', 'overdue_credit', 'credit_days'].includes(reason.type)
      || (options.preserveBelowMinimum && reason.type === 'below_minimum_price')
    );
    return preserve ? { ...reason, status: old.status || 'pending' } : { ...reason, status: 'pending' };
  });
}
export function approvalStatusForReasons(reasons = []) {
  if (!reasons.length) return 'not_required';
  if (reasons.some((reason) => reason.status === 'rejected')) return 'rejected';
  if (reasons.some((reason) => reason.status !== 'approved')) return 'pending';
  return 'approved';
}
export function addCreditApproval(pricingResult, dealer, branchOutstanding, existingReasons = [], options = {}) {
  const reasons = [...pricingResult.approvalReasons];
  let creditLimitExceeded = false;
  if (dealer?.creditLimit > 0 && branchOutstanding + pricingResult.grandTotal > dealer.creditLimit) {
    creditLimitExceeded = true;
    reasons.push({
      type: 'credit_limit',
      message: `Projected outstanding ${roundMoney(branchOutstanding + pricingResult.grandTotal)} exceeds credit limit ${roundMoney(dealer.creditLimit)}.`,
      requestedValue: roundMoney(branchOutstanding + pricingResult.grandTotal),
      thresholdValue: roundMoney(dealer.creditLimit),
      subject: String(dealer._id),
    });
  }
  const exposure = options.creditExposure;
  if (dealer && exposure && !exposure.creditDaysValid) {
    reasons.push({
      type: 'credit_days',
      message: `Dealer credit days value ${dealer.creditDays} is invalid and requires approval.`,
      requestedValue: Number(dealer.creditDays || 0),
      thresholdValue: 0,
      subject: String(dealer._id),
    });
  } else if (dealer && exposure?.overdueAmount > 0) {
    reasons.push({
      type: 'overdue_credit',
      message: `Dealer has ${exposure.overdueCount} overdue invoice/order exposure(s) totaling ${roundMoney(exposure.overdueAmount)} beyond ${exposure.creditDays} credit day(s).`,
      requestedValue: roundMoney(exposure.overdueAmount),
      thresholdValue: 0,
      subject: String(dealer._id),
    });
  }
  const merged = mergeApprovalReasons(reasons, existingReasons, {
    preserveBelowMinimum: Boolean(options.preserveBelowMinimum),
  });
  return { creditLimitExceeded, approvalReasons: merged, approvalStatus: approvalStatusForReasons(merged) };
}

export async function deriveOrderPricing(options = {}) {
  const {
    branchId, dealerId, dealerTypeId, scope, orderType = dealerId ? 'dealer' : 'retail',
    // Lets a caller pin the rate column, e.g. the website selling at MRP. Omitted
    // everywhere else, so existing callers resolve exactly as before.
    preferredTier = null,
    pricingDate = new Date(), items, session = null, existingApprovalReasons = [],
    preserveSnapshots = false, preserveBelowMinimumApprovals = false, requireItemUnit = false,
    freightCharges = 0, loadingCharges = 0, installationCharges = 0, otherCharges = 0,
    advanceAmount = 0,
  } = options;
  const normalized = await normalizeOrderItemsUom(items, session, { requireItemUnit });

  let resolutions;
  if (preserveSnapshots) {
    resolutions = await Promise.all(normalized.map(async ({ source, quantity }) => {
      const preserved = await loadPreservedResolution(source, quantity, session);
      if (preserved) return preserved;
      return resolvePricing({
        branchId, dealerId, dealerTypeId, scope, product: source.product, preferredTier,
        quantity, manualRate: source.manualRate, orderType, pricingDate, session,
      });
    }));
  } else {
    const firstPass = await Promise.all(normalized.map(({ source, product, quantity }) => resolvePricing({
      branchId, dealerId, dealerTypeId, scope, product, quantity, manualRate: source.manualRate,
      preferredTier, orderType, pricingDate, session,
    })));
    const orderAmount = roundMoney(firstPass.reduce((sum, result) => sum + result.pricingRate * result.quantity, 0));
    resolutions = await Promise.all(normalized.map(({ source, product, quantity }) => resolvePricing({
      branchId, dealerId, dealerTypeId, scope, product, quantity, manualRate: source.manualRate,
      preferredTier, orderType, pricingDate, orderAmount, session,
    })));
  }

  let subtotal = 0;
  let totalDiscount = 0;
  let totalSchemeDiscount = 0;
  let totalTax = 0;
  const generatedReasons = [];
  const pricedItems = resolutions.map((resolution, index) => {
    const source = normalized[index].source;
    const product = resolution.product;
    const quantity = resolution.quantity;
    const gstPercentage = finiteNonNegative(product.gst, `products[${index}].gst`, 18);
    if (gstPercentage > 100) throw routeError(422, `Product ${product.productCode || product._id} has invalid GST.`);
    const taxableAmount = roundMoney(resolution.effectiveRate * quantity);
    const gstAmount = roundMoney((taxableAmount * gstPercentage) / 100);
    subtotal += taxableAmount;
    totalDiscount += resolution.regularDiscountAmount;
    totalSchemeDiscount += resolution.schemeDiscountAmount;
    totalTax += gstAmount;
    if (resolution.belowMinimum) {
      generatedReasons.push({
        type: 'below_minimum_price',
        message: `${product.productCode || product.itemName} effective rate ${resolution.effectiveRate} is below minimum ${resolution.minimumSellingRate}.`,
        itemIndex: index,
        product: product._id,
        requestedValue: resolution.effectiveRate,
        thresholdValue: resolution.minimumSellingRate,
      });
    }
    return {
      product: product._id,
      productCode: product.productCode || '',
      productName: product.itemName,
      productImage: product.images?.[0] || '',
      shade: source.shade || '',
      batch: source.batch || '',
      quantity,
      unit: source.unit || product.unit || 'Box',
      boxes: finiteNonNegative(source.boxes, `items[${index}].boxes`),
      pieces: finiteNonNegative(source.pieces, `items[${index}].pieces`),
      sqft: finiteNonNegative(source.sqft, `items[${index}].sqft`),
      rate: resolution.pricingRate,
      discount: resolution.regularDiscountPerUnit,
      discountType: 'flat',
      schemeDiscount: resolution.schemeDiscountAmount,
      taxableAmount,
      gstPercentage,
      cgst: roundMoney(gstAmount / 2),
      sgst: roundMoney(gstAmount / 2),
      igst: 0,
      gstAmount,
      totalAmount: roundMoney(taxableAmount + gstAmount),
      warehouse: source.warehouse || undefined,
      pricingSnapshot: pricingAuditSnapshot(resolution),
    };
  });

  const charges = {
    freightCharges: finiteNonNegative(freightCharges, 'freightCharges'),
    loadingCharges: finiteNonNegative(loadingCharges, 'loadingCharges'),
    installationCharges: finiteNonNegative(installationCharges, 'installationCharges'),
    otherCharges: finiteNonNegative(otherCharges, 'otherCharges'),
  };
  const unroundedTotal = subtotal + totalTax + Object.values(charges).reduce((sum, value) => sum + value, 0);
  const grandTotal = Math.round(unroundedTotal);
  const advance = finiteNonNegative(advanceAmount, 'advanceAmount');
  if (advance > grandTotal) throw routeError(422, 'advanceAmount cannot exceed the calculated grandTotal.');
  const approvalReasons = mergeApprovalReasons(generatedReasons, existingApprovalReasons, {
    preserveBelowMinimum: preserveBelowMinimumApprovals,
  });
  const dealerType = resolutions.find((resolution) => resolution.dealerType)?.dealerType || null;
  return {
    items: pricedItems,
    subtotal: roundMoney(subtotal),
    totalDiscount: roundMoney(totalDiscount),
    totalSchemeDiscount: roundMoney(totalSchemeDiscount),
    totalTax: roundMoney(totalTax),
    ...charges,
    roundOff: roundMoney(grandTotal - unroundedTotal),
    grandTotal,
    advanceAmount: advance,
    balanceAmount: roundMoney(grandTotal - advance),
    paymentStatus: grandTotal - advance === 0 ? 'paid' : advance > 0 ? 'partial' : 'pending',
    approvalReasons,
    approvalStatus: approvalStatusForReasons(approvalReasons),
    dealerType: dealerType?._id || dealerType || dealerTypeId || undefined,
    dealerTypeSnapshot: dealerType ? { name: dealerType.name, pricingTier: dealerType.pricingTier } : undefined,
    resolutions,
  };
}
