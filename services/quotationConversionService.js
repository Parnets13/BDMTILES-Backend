import mongoose from 'mongoose';
import Quotation from '../models/Quotation.js';
import QuotationConversion from '../models/QuotationConversion.js';
import SalesOrder from '../models/SalesOrder.js';
import DealerOrderRequest from '../models/DealerOrderRequest.js';
import { addCreditApproval } from './orderPricingService.js';
import { getDealerCreditExposure } from './dealerCreditService.js';
import { syncAutomaticApprovalRequest } from './approvalRequestService.js';
import { findActiveDealer, getBranchOutstanding, priceQuotation } from './quotationPricingService.js';
import { consumeQuotationHold } from './quotationHoldService.js';
import { getQuotationReadiness, quotationStockEligibility } from './quotationStockService.js';
import { assertWarehousesInBranch } from '../utils/branchScope.js';
import { reserveSalesOrderInventory } from '../utils/salesOrderInventory.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';
import { assertIdempotentReplay, requestFingerprint } from '../utils/idempotency.js';

// The quotation -> Sales Order conversion, lifted out of routes/quotationRoutes.js
// so it can be called from inside another transaction. Dealer order processing has
// to convert the available child of a split without going back out through HTTP,
// and re-implementing this would mean a second place that decides how much stock a
// Sales Order reserves. There must only ever be one.

const conversionError = (status, message, code, details) => Object.assign(
  new Error(message),
  { status, ...(code ? { code } : {}), ...(details ? { details } : {}) },
);

export const conversionSourceKey = (quotationId, idempotencyKey) =>
  `quotation:${quotationId}:${idempotencyKey}`;

export const conversionFingerprint = ({ mode, includePartialLines }) =>
  requestFingerprint({ mode, includePartialLines });

/**
 * Finds an already-completed conversion for this idempotency key. Returns null
 * when the key is unused, and throws when the same key arrives with a different
 * payload or when the stored history no longer agrees with itself.
 */
export async function findConversionReplay({
  quotationId,
  branchId,
  sourceKey,
  fingerprint,
  actorScope = {},
  session = null,
}) {
  let conversionQuery = QuotationConversion.findOne({ branch: branchId, quotation: quotationId, sourceKey });
  if (session) conversionQuery = conversionQuery.session(session);
  const conversion = await conversionQuery.lean();
  if (!conversion) return null;
  assertIdempotentReplay(conversion, fingerprint);

  let orderQuery = SalesOrder.findOne({
    _id: conversion.salesOrder,
    branch: branchId,
    sourceQuotation: quotationId,
    sourceKey,
  });
  let quotationQuery = Quotation.findOne({ _id: quotationId, branch: branchId, ...actorScope });
  if (session) {
    orderQuery = orderQuery.session(session);
    quotationQuery = quotationQuery.session(session);
  }
  const salesOrder = await orderQuery;
  const quotation = await quotationQuery;
  if (!salesOrder || !quotation) throw conversionError(409, 'Idempotent conversion history is inconsistent.');
  return { conversion, salesOrder, quotation };
}

/**
 * Converts a quotation into a Sales Order. Must be called inside an open
 * transaction: the stock reservation, the quotation's converted-quantity
 * increments and the ledger posting are one unit of work or none of them.
 *
 * @param {object}  options
 * @param {string}  options.quotationId
 * @param {*}       options.branchId
 * @param {object}  options.actor            User document ({ _id, role, name }).
 * @param {object}  [options.actorScope]     Extra quotation match, e.g. a sales
 *                                           executive limited to their own.
 * @param {'full'|'available'} [options.mode]
 * @param {boolean} [options.includePartialLines]
 * @param {string}  options.sourceKey        Idempotency scope for this conversion.
 * @param {string}  options.fingerprint      Payload fingerprint for replay checks.
 * @param {*}       options.session          Open mongoose session (required).
 * @param {string}  [options.remarksNote]    Overrides the generated SO remark.
 * @param {boolean} [options.stampSourceRequest] Set false when the caller owns the
 *                                           dealer order request bookkeeping itself.
 * @returns {Promise<{quotation: object, salesOrder: object, conversion: object}>}
 */
export async function convertQuotationCore({
  quotationId,
  branchId,
  actor,
  actorScope = {},
  mode = 'full',
  includePartialLines = false,
  sourceKey,
  fingerprint,
  session,
  remarksNote = null,
  stampSourceRequest = true,
}) {
  if (!session) throw conversionError(500, 'Quotation conversion requires an open transaction session.');
  if (!['full', 'available'].includes(mode)) throw conversionError(422, 'mode must be "full" or "available".');
  if (!sourceKey || !fingerprint) throw conversionError(500, 'Quotation conversion requires an idempotency scope.');

  const current = await Quotation.findOne({ _id: quotationId, branch: branchId, ...actorScope }).session(session).lean();
  if (!current) throw conversionError(404, 'Quotation not found.');
  if (current.status === 'converted' || current.conversionState === 'full') {
    throw conversionError(409, 'Quotation has no remaining quantity to convert.', 'QUOTATION_FULLY_CONVERTED');
  }
  const eligibility = quotationStockEligibility(current);
  if (!eligibility.conversionEligible) {
    const message = eligibility.reason === 'expired'
      ? 'Expired quotation cannot be converted.'
      : eligibility.reason === 'pricing_approval_not_satisfied'
        ? 'Quotation pricing approval is required before conversion.'
        : ['missing_queue_timestamp', 'invalid_queue_timestamp'].includes(eligibility.reason)
          ? 'Quotation has no trustworthy FIFO queue timestamp. Run and review the readiness migration before conversion.'
          : 'Only accepted or approved quotations can be converted.';
    const stockReadiness = await getQuotationReadiness(current, { session });
    throw conversionError(409, message, 'QUOTATION_NOT_ELIGIBLE', stockReadiness);
  }
  for (const item of current.items || []) {
    const quoted = Number(item.quantity || 0);
    const converted = Number(item.convertedQuantity || 0);
    if (converted < 0 || converted > quoted + 0.0001) {
      throw conversionError(409, 'Quotation converted quantities are inconsistent. Run the conversion migration before retrying.');
    }
  }

  const stockReadiness = await getQuotationReadiness(current, { session });
  if (stockReadiness.fullyConverted || stockReadiness.totalRemainingQty <= 0.0001) {
    throw conversionError(409, 'Quotation has no remaining quantity to convert.', 'QUOTATION_FULLY_CONVERTED');
  }
  if (mode === 'full' && !stockReadiness.allStockAvailable) {
    throw conversionError(409, 'All remaining quotation stock is not currently available.', 'INSUFFICIENT_STOCK', stockReadiness);
  }
  if (mode === 'available' && !stockReadiness.anyStockAvailable) {
    throw conversionError(409, 'No FIFO-allocated stock is currently available for this quotation.', 'INSUFFICIENT_STOCK', stockReadiness);
  }
  const partialLines = stockReadiness.items.filter(item => item.status === 'partial' && item.allocatedQty > 0.0001);
  if (mode === 'available' && partialLines.length && !includePartialLines) {
    throw conversionError(
      409,
      'Available conversion includes partial line quantities. Confirm that later stock may use a different shade or batch.',
      'PARTIAL_LINE_CONFIRMATION_REQUIRED',
      { ...stockReadiness, partialLines },
    );
  }

  const selectedReadiness = stockReadiness.items.filter(item =>
    item.remainingQty > 0.0001
    && (mode === 'full' ? item.status === 'available' : item.allocatedQty > 0.0001)
  );
  if (!selectedReadiness.length) throw conversionError(409, 'No quotation quantity is currently convertible.');
  const selectedOriginalIndexes = new Map();
  const conversionItems = selectedReadiness.map((ready, childIndex) => {
    const source = current.items[ready.itemIndex];
    const quantity = mode === 'full' ? ready.remainingQty : ready.allocatedQty;
    const ratio = quantity / Number(source.quantity || 1);
    selectedOriginalIndexes.set(ready.itemIndex, childIndex);
    return {
      ...source,
      _id: undefined,
      sourceQuotationItem: source._id,
      quantity,
      boxes: quantity,
      pieces: Number(source.pieces || 0) > 0 ? Number(source.pieces) * ratio : undefined,
      sqft: Number(source.sqft || 0) > 0 ? Number(source.sqft) * ratio : undefined,
      warehouse: ready.allocation?.warehouse,
      shade: ready.allocation?.shade || '',
      batch: ready.allocation?.batch || '',
    };
  });
  await assertWarehousesInBranch(conversionItems.map(item => item.warehouse), branchId, { session });

  const selectedByIndex = new Map(selectedReadiness.map((ready) => [ready.itemIndex, mode === 'full' ? ready.remainingQty : ready.allocatedQty]));
  const willBeFull = (current.items || []).every((item, index) =>
    Number(item.convertedQuantity || 0) + Number(selectedByIndex.get(index) || 0) >= Number(item.quantity || 0) - 0.0001
  );
  const priorConversions = await QuotationConversion.find({
    branch: branchId,
    quotation: current._id,
    status: { $ne: 'voided' },
  }).select('charges').session(session).lean();
  const chargeFields = ['freightCharges', 'loadingCharges', 'installationCharges', 'otherCharges'];
  const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  const originalWeight = (current.items || []).reduce((sum, item) => sum + Math.max(
    Number(item.taxableAmount || 0), Number(item.totalAmount || 0), Number(item.quantity || 0)
  ), 0);
  const selectedWeight = selectedReadiness.reduce((sum, ready) => {
    const item = current.items[ready.itemIndex];
    const lineWeight = Math.max(Number(item.taxableAmount || 0), Number(item.totalAmount || 0), Number(item.quantity || 0));
    const quantity = mode === 'full' ? ready.remainingQty : ready.allocatedQty;
    return sum + lineWeight * quantity / Number(item.quantity || 1);
  }, 0);
  const charges = Object.fromEntries(chargeFields.map((field) => {
    const total = money(current[field]);
    const allocated = money(priorConversions.reduce((sum, entry) => sum + Number(entry.charges?.[field] || 0), 0));
    const remainingCharge = money(Math.max(0, total - allocated));
    const proportional = originalWeight > 0 ? money(total * selectedWeight / originalWeight) : 0;
    return [field, willBeFull ? remainingCharge : Math.min(remainingCharge, proportional)];
  }));
  const selectedApprovalReasons = (current.approvalReasons || []).flatMap((reason) => {
    if (reason.type !== 'below_minimum_price') return [reason];
    const childIndex = selectedOriginalIndexes.get(reason.itemIndex);
    return childIndex === undefined ? [] : [{ ...reason, itemIndex: childIndex }];
  });
  const dealer = current.dealer ? await findActiveDealer(current.dealer, session) : null;
  if (current.dealer && !dealer) throw conversionError(404, 'Dealer not found.');
  const { priced } = await priceQuotation(
    { ...current, ...charges, items: conversionItems },
    dealer,
    branchId,
    session,
    selectedApprovalReasons,
    { preserveSnapshots: true, preserveBelowMinimumApprovals: true },
  );
  priced.items = priced.items.map((item, index) => {
    const source = conversionItems[index];
    const conversionFactor = Number(source.conversionFactor);
    if (!Number.isFinite(conversionFactor) || conversionFactor <= 0
        || !source.baseUnit || !Number.isInteger(Number(source.uomVersion))) {
      throw conversionError(409, 'Quotation item UOM snapshot is missing or invalid. Re-save an editable quotation or review legacy readiness migration output.');
    }
    return {
      ...item,
      unit: source.unit,
      sourceQuotationItem: source.sourceQuotationItem,
      baseQuantity: Math.round((Number(item.quantity) * conversionFactor + Number.EPSILON) * 1e6) / 1e6,
      baseUnit: source.baseUnit,
      conversionFactor,
      uomVersion: Number(source.uomVersion),
    };
  });
  const outstanding = dealer ? await getBranchOutstanding(branchId, dealer._id, session) : 0;
  const creditExposure = dealer ? await getDealerCreditExposure({ branchId, dealer, asOf: new Date(), session }) : null;
  const approval = addCreditApproval(priced, dealer, outstanding, selectedApprovalReasons, {
    preserveBelowMinimum: true,
    creditExposure,
  });
  const now = new Date();
  const salesOrderId = new mongoose.Types.ObjectId();
  const soNumber = await generateBranchNumber(current.branch, 'salesOrder', now, { session });
  const orderStatus = ['pending', 'rejected'].includes(approval.approvalStatus) ? 'draft' : 'confirmed';
  const [salesOrder] = await SalesOrder.create([{
    _id: salesOrderId,
    orderNumber: soNumber,
    branch: current.branch,
    orderDate: now,
    dealer: current.dealer || undefined,
    dealerType: dealer?.dealerType?._id || priced.dealerType,
    dealerTypeSnapshot: dealer?.dealerType
      ? { name: dealer.dealerType.name, pricingTier: dealer.dealerType.pricingTier }
      : priced.dealerTypeSnapshot,
    dealerName: dealer?.businessName || current.customerName || '',
    dealerCode: dealer?.dealerCode || '',
    customerName: current.customerName || '',
    customerPhone: current.customerPhone || '',
    deliveryAddress: current.customerAddress || '',
    orderType: dealer ? (current.customerType || 'dealer') : 'retail',
    items: priced.items,
    subtotal: priced.subtotal,
    totalDiscount: priced.totalDiscount,
    totalSchemeDiscount: priced.totalSchemeDiscount,
    totalTax: priced.totalTax,
    freightCharges: priced.freightCharges,
    loadingCharges: priced.loadingCharges,
    installationCharges: priced.installationCharges,
    otherCharges: priced.otherCharges,
    roundOff: priced.roundOff,
    grandTotal: priced.grandTotal,
    balanceAmount: priced.grandTotal,
    paymentStatus: 'pending',
    status: orderStatus,
    confirmationRequested: true,
    sourceQuotation: current._id,
    sourceKey,
    requestFingerprint: fingerprint,
    remarks: (remarksNote
      || `Converted ${mode === 'available' ? 'available stock' : 'remaining quantity'} from ${current.quotationNumber}. ${current.remarks || ''}`
    ).trim(),
    tallySyncStatus: 'not_synced',
    ...approval,
    salesExecutive: actor.role === 'sales_executive' ? actor._id : undefined,
    createdBy: actor._id,
  }], { session });

  // A held quotation already owns its stock in Stock.quotedQty. Move that
  // straight to reservedQty instead of competing for availableQty again —
  // this is what makes converting a held quotation impossible to fail on
  // stock. Anything not covered by the hold falls through to a normal
  // reservation below.
  if (['held', 'partial'].includes(current.holdStatus)) {
    // consumeQuotationHold mutates and saves the quotation, so it needs a
    // hydrated document; `current` above is lean.
    const heldQuotation = await Quotation.findById(current._id).session(session);
    if (!heldQuotation) throw conversionError(409, 'Quotation no longer exists.');
    await consumeQuotationHold(heldQuotation, salesOrder, {
      session,
      actor: actor._id,
      reason: `Quotation ${current.quotationNumber} hold consumed by ${soNumber}`,
    });
  }

  // Reserves only what the hold did not already cover; a fully held quotation
  // leaves nothing missing here, so this becomes a no-op.
  await reserveSalesOrderInventory(salesOrder, { session, actor: actor._id, reason: 'Quotation conversion reservation' });

  const version = Number(current.conversionVersion || 0);
  const versionScope = version === 0
    ? { $or: [{ conversionVersion: 0 }, { conversionVersion: { $exists: false } }] }
    : { conversionVersion: version };
  const quantityIncrements = Object.fromEntries(selectedReadiness.map((ready) => [
    `items.${ready.itemIndex}.convertedQuantity`,
    mode === 'full' ? ready.remainingQty : ready.allocatedQty,
  ]));
  const setFields = {
    conversionState: willBeFull ? 'full' : 'partial',
    status: willBeFull ? 'converted' : current.status,
    lastConvertedAt: now,
    ...(willBeFull ? { fullyConvertedAt: now } : {}),
    ...(!current.convertedToSO ? { convertedToSO: salesOrderId } : {}),
    ...(!current.convertedAt ? { convertedAt: now } : {}),
    ...(!current.firstConvertedAt ? { firstConvertedAt: now } : {}),
  };
  const quotation = await Quotation.findOneAndUpdate(
    {
      _id: current._id,
      branch: branchId,
      status: current.status,
      ...actorScope,
      ...versionScope,
    },
    {
      $set: setFields,
      $inc: { conversionVersion: 1, ...quantityIncrements },
      $addToSet: { convertedSalesOrders: salesOrderId },
    },
    { new: true, session },
  );
  if (!quotation) throw conversionError(409, 'Quotation changed before conversion; refresh and retry.');

  const [conversion] = await QuotationConversion.create([{
    branch: branchId,
    quotation: current._id,
    salesOrder: salesOrderId,
    sourceKey,
    requestFingerprint: fingerprint,
    mode,
    sourceQuotationStatus: current.status,
    status: 'active',
    includePartialLines,
    charges,
    lines: selectedReadiness.map((ready) => ({
      quotationItem: current.items[ready.itemIndex]._id,
      product: current.items[ready.itemIndex].product,
      quantity: mode === 'full' ? ready.remainingQty : ready.allocatedQty,
      warehouse: ready.allocation.warehouse,
      shade: ready.allocation.shade || '',
      batch: ready.allocation.batch || '',
    })),
    createdBy: actor._id,
  }], { session });

  // Close the loop back to the dealer's original request. Without this the
  // request stays at "quotation created" forever and the dealer never learns
  // that their demand actually became an order. Only stamp the first
  // conversion: a partially converted quotation can produce several orders,
  // and the request should point at the one that started it.
  if (stampSourceRequest && current.sourceDealerOrderRequest) {
    await DealerOrderRequest.updateOne(
      {
        _id: current.sourceDealerOrderRequest,
        branch: branchId,
        sourceSalesOrder: { $exists: false },
      },
      { $set: { sourceSalesOrder: salesOrder._id, convertedAt: now } },
      { session },
    );
  }

  await syncAutomaticApprovalRequest({
    branchId,
    type: 'sales_order',
    referenceModel: 'SalesOrder',
    referenceId: salesOrder._id,
    referenceNumber: salesOrder.orderNumber,
    title: `Sales Order ${salesOrder.orderNumber} requires approval`,
    reasons: salesOrder.approvalReasons || [],
    requestedBy: actor._id,
    requestedByName: actor.name || '',
    requestedValue: salesOrder.grandTotal,
    document: salesOrder,
    session,
  });
  if (salesOrder.status === 'confirmed' && salesOrder.dealer && salesOrder.grandTotal > 0) {
    await postSubledgerEntry({
      session, branch: branchId, partyType: 'dealer', partyId: salesOrder.dealer,
      amount: salesOrder.grandTotal, side: 'debit', postingKey: `sales-order:${salesOrder._id}:confirmed`,
      entryType: 'invoice', entryDate: salesOrder.orderDate,
      description: `Receivable for Sales Order ${salesOrder.orderNumber}`,
      referenceNumber: salesOrder.orderNumber, referenceModel: 'SalesOrder', referenceId: salesOrder._id, createdBy: actor._id,
    });
  }

  return { quotation, salesOrder, conversion };
}
