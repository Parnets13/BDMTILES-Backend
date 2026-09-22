import DealerOrderRequest from '../models/DealerOrderRequest.js';
import Quotation from '../models/Quotation.js';
import { findActiveDealer, priceQuotation } from './quotationPricingService.js';
import {
  applyQuotationStockSnapshot,
  applyQuotationUomSnapshots,
} from './quotationStockService.js';
import { computeSplitPlan, executeSplit } from './quotationSplitService.js';
import { placeQuotationHold } from './quotationHoldService.js';
import {
  conversionFingerprint,
  conversionSourceKey,
  convertQuotationCore,
} from './quotationConversionService.js';
import { refreshAndFingerprintRequest } from './dealerOrderRequestService.js';
import { syncAutomaticApprovalRequest } from './approvalRequestService.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

/**
 * Stock-aware dealer order processing.
 *
 * A dealer order request carries products and quantities but no stock decision.
 * Processing it means answering, atomically, "how much of this can we actually
 * commit to right now?" — and the only trustworthy answer is one backed by a real
 * reservation. So this deliberately owns no stock logic of its own. It:
 *
 *   1. turns the approved request into a quotation at the FULL requested quantity
 *      (which is what keeps the request's approved fingerprint intact),
 *   2. runs the existing quotation split, which holds the available part in
 *      Stock.quotedQty and parks the rest as a pending-stock child,
 *   3. converts the available child through the existing conversion core, moving
 *      the hold straight into reservedQty.
 *
 * The consequence of step 2 is the property the whole feature rests on: a Sales
 * Order is only ever created for a quantity that a conditional stock update
 * already succeeded on. If stock moved between the preview and the commit, the
 * planHash check rejects the whole thing and staff re-reads a fresh plan. Nothing
 * partial is ever invented.
 *
 * The dealer is then asked about the shortfall only. Whatever they answer cannot
 * touch the Sales Order that already exists.
 */

const SHORTFALL_TOLERANCE = 0.0001;
const processingError = (status, message, code, details) => Object.assign(
  new Error(message),
  { status, ...(code ? { code } : {}), ...(details ? { details } : {}) },
);
const idOf = value => String(value?._id || value || '');
const qty = value => Math.round((Number(value || 0) + Number.EPSILON) * 1e6) / 1e6;

// Staff process a request in one action. A request that has not been separately
// approved yet is approved as part of that same action, because reviewing the demand
// and committing stock to it is one decision from the branch's point of view — and
// making them click twice would mean the available quantity sits unreserved in
// between, which is exactly the window this feature exists to close.
export const PROCESSABLE_STATUSES = new Set(['submitted', 'approved']);

function validityWindow(now = new Date()) {
  const validUntil = new Date(now);
  validUntil.setUTCDate(validUntil.getUTCDate() + 30);
  validUntil.setUTCHours(23, 59, 59, 999);
  return { quotationDate: now, validUntil };
}

/**
 * Loads a request for processing and rejects anything that is not in a state
 * where a stock decision makes sense.
 */
export async function loadProcessableRequest({ requestId, branchId, session = null }) {
  let query = DealerOrderRequest.findOne({ _id: requestId, branch: branchId });
  if (session) query = query.session(session);
  const request = await query;
  if (!request) throw processingError(404, 'Dealer order request not found.');
  return request;
}

/**
 * Creates (or re-finds) the quotation for an approved request, at the full
 * requested quantity and already approved for pricing.
 *
 * Full quantity is not a convenience: DealerOrderRequest.approvedFingerprint is an
 * exact product+quantity hash of what staff approved, and a quotation raised for a
 * reduced quantity is rejected by assertQuotationMatchesRequest. The reduction has
 * to happen through the split, below, where it is backed by a real hold.
 *
 * Idempotent — a request that already has a linked quotation returns it untouched.
 */
export async function prepareDealerOrderQuotation({ request, branchId, actor, session }) {
  if (!session) throw processingError(500, 'Dealer order preparation requires an open transaction session.');

  if (request.sourceQuotation) {
    const existing = await Quotation.findOne({
      _id: request.sourceQuotation,
      branch: branchId,
      sourceDealerOrderRequest: request._id,
    }).session(session);
    if (!existing) throw processingError(409, 'This request is linked to a quotation that could not be verified.');
    return { quotation: existing, created: false };
  }

  if (!PROCESSABLE_STATUSES.has(request.status)) {
    throw processingError(409, `A dealer order request in "${request.status}" status cannot be processed.`);
  }

  // Re-derive the trusted items from live product data.
  const refreshed = await refreshAndFingerprintRequest(request, session);
  if (request.status === 'approved') {
    // Already reviewed: refuse to act if the products or quantities no longer hash
    // the same as they did when somebody approved them.
    if (!request.approvedFingerprint) {
      throw processingError(409, 'This request has no approved fingerprint. Re-approve it before processing.');
    }
    if (refreshed.fingerprint !== request.approvedFingerprint) {
      throw processingError(409, 'Approved request details changed. Review the request again.');
    }
  }

  const dealer = await findActiveDealer(request.dealer, session);
  if (!dealer) throw processingError(404, 'Dealer not found.');

  const { quotationDate, validUntil } = validityWindow();
  const data = {
    quotationDate,
    validUntil,
    dealer: dealer._id,
    customerType: 'dealer',
    customerName: request.dealerSnapshot?.businessName || dealer.businessName || '',
    customerPhone: request.dealerSnapshot?.mobile || dealer.mobile || '',
    customerAddress: request.deliveryAddress || request.dealerSnapshot?.address || '',
    // Warehouse, shade and batch are deliberately left unset: FIFO readiness picks
    // the exact bucket, and pinning one here would constrain the allocation to a
    // bucket nobody chose.
    items: refreshed.items.map(item => ({
      product: item.product,
      quantity: item.quantity,
      unit: item.unit,
      boxes: item.boxes,
      pieces: item.pieces,
      sqft: item.sqft,
    })),
  };

  const { fields } = await priceQuotation(data, dealer, branchId, session);
  fields.items = await applyQuotationUomSnapshots(fields.items, { session, at: quotationDate });
  fields.items = await applyQuotationStockSnapshot(fields.items, branchId, { session });

  const now = new Date();
  // A request that needed a price the system could not justify still has to go
  // through pricing approval; auto-approving it here would turn the dealer app
  // into a way around the below-minimum-price gate.
  const needsPricingApproval = Boolean(fields.approvalRequired);
  const [quotation] = await Quotation.create([{
    ...data,
    ...fields,
    branch: branchId,
    quotationNumber: await generateBranchNumber(branchId, 'quotation', quotationDate, { session }),
    dealerName: dealer.businessName || '',
    dealerCode: dealer.dealerCode || '',
    snapshotCaptured: true,
    stockSnapshotAt: now,
    sourceDealerOrderRequest: request._id,
    status: needsPricingApproval ? 'pending_approval' : 'approved',
    // The FIFO position is what makes this request's demand compete fairly for
    // incoming stock, so it is stamped as soon as the quotation is approved.
    ...(needsPricingApproval ? {} : {
      stockQueuedAt: now,
      approvalStatus: 'not_required',
      approvedBy: actor._id,
      approvalDate: now,
      approvalRemarks: `Auto-approved from dealer order request ${request.requestNumber}.`,
    }),
    tallySyncStatus: 'not_synced',
    remarks: `Dealer order request ${request.requestNumber}. ${request.remarks || ''}`.trim(),
    createdBy: actor._id,
  }], { session });

  // Claim the request for this quotation, approving it in the same breath when it
  // had not been reviewed separately. The compare-and-set is what stops two staff
  // members processing the same request into two quotations.
  const approving = request.status !== 'approved';
  const linked = await DealerOrderRequest.findOneAndUpdate(
    {
      _id: request._id,
      branch: branchId,
      status: request.status,
      revision: request.revision,
      sourceQuotation: { $exists: false },
    },
    {
      $set: {
        sourceQuotation: quotation._id,
        linkedAt: now,
        linkedBy: actor._id,
        ...(approving ? {
          status: 'approved',
          items: refreshed.items,
          approvedFingerprint: refreshed.fingerprint,
          approvedBy: actor._id,
          approvedAt: now,
          approvalRemarks: 'Approved as part of stock processing.',
        } : {}),
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session },
  );
  if (!linked) throw processingError(409, 'The dealer order request was linked or changed by another user.');

  await syncAutomaticApprovalRequest({
    branchId,
    type: 'quotation',
    referenceModel: 'Quotation',
    referenceId: quotation._id,
    referenceNumber: quotation.quotationNumber,
    title: `Quotation ${quotation.quotationNumber} requires pricing approval`,
    reasons: quotation.approvalReasons || [],
    requestedBy: actor._id,
    requestedByName: actor.name || '',
    requestedValue: quotation.grandTotal,
    document: quotation,
    session,
  });

  return { quotation, created: true, request: linked };
}

/**
 * What processing this request would do to stock right now.
 *
 * Returns the real quotation split plan, not an estimate: the quotation is created
 * first so the plan is computed by the same FIFO allocator that will run at commit
 * time, against the same queue. A synthetic preview would ignore the quotations
 * ahead of this one and promise stock that commit could not deliver.
 */
export async function dealerOrderStockPlan({ requestId, branchId, actor, session }) {
  const request = await loadProcessableRequest({ requestId, branchId, session });
  if (request.processedAt) {
    throw processingError(409, 'This request has already been processed. Review its shortfall instead.', 'REQUEST_ALREADY_PROCESSED');
  }
  const { quotation } = await prepareDealerOrderQuotation({ request, branchId, actor, session });
  if (quotation.status === 'pending_approval') {
    throw processingError(
      409,
      `Quotation ${quotation.quotationNumber} needs pricing approval before stock can be committed.`,
      'PRICING_APPROVAL_REQUIRED',
      { quotation: quotation._id, quotationNumber: quotation.quotationNumber },
    );
  }
  const plan = await computeSplitPlan(quotation, { session });
  return { request, quotation, plan };
}

/**
 * Later, when the stock has arrived: turns the agreed pending-stock quotation into a
 * real, reserved Sales Order.
 *
 * Same discipline as the first pass and for the same reason — re-check live stock,
 * take the atomic hold, and only then convert. Nothing here trusts the expected date
 * that was given to the dealer; that was an estimate, and the only thing that can
 * authorise an order is a reservation that actually succeeded.
 *
 * Deliberately a manual staff action, not a background sweep: committing stock to one
 * dealer ahead of everyone else queued behind them is a decision a person should make.
 */
export async function processPendingStock({
  requestId,
  branchId,
  actor,
  planHash,
  includePartialLines = false,
  session,
}) {
  if (!session) throw processingError(500, 'Processing pending stock requires an open transaction session.');
  const request = await loadProcessableRequest({ requestId, branchId, session });
  if (!request.pendingStockQuotation) {
    throw processingError(409, 'This request has no pending-stock quantity waiting for stock.', 'NO_PENDING_STOCK');
  }
  if (request.shortfallStatus !== 'closed') {
    throw processingError(
      409,
      'The pending quantity is still being agreed with the dealer.',
      'SHORTFALL_NOT_SETTLED',
    );
  }

  const pending = await Quotation.findOne({
    _id: request.pendingStockQuotation,
    branch: branchId,
  }).session(session);
  if (!pending) throw processingError(409, 'The pending-stock quotation could not be found.');
  if (pending.status !== 'pending_stock') {
    throw processingError(
      409,
      `${pending.quotationNumber} is "${pending.status}" and is no longer waiting for stock.`,
      'QUOTATION_NOT_PENDING_STOCK',
    );
  }

  // Readiness ignores a pending-stock quotation as convertible demand by design, so
  // it is evaluated as if approved purely to compute the plan. The status only
  // changes below, and only once the hold has actually succeeded.
  const plan = await computeSplitPlan({ ...pending.toObject(), status: 'approved' }, { session });
  const lines = plan.available.map(entry => ({
    product: entry.productId,
    productName: entry.productName,
    productCode: entry.productCode,
    unit: entry.unit,
    requestedQty: entry.quantity,
    allocatedQty: entry.quantity,
    availableQty: entry.quantity,
    shortfallQty: 0,
  }));

  const submitted = String(planHash || '').trim();
  if (submitted && plan.planHash !== submitted) {
    throw processingError(
      409,
      'Stock changed while this was being confirmed. Review the updated figures and confirm again.',
      'SPLIT_PLAN_CHANGED',
      { plan: { ...plan, readiness: undefined }, lines },
    );
  }
  if (plan.willSplit || !plan.canHold) {
    throw processingError(
      409,
      `Stock is still short for ${pending.quotationNumber}. Nothing has been ordered.`,
      'INSUFFICIENT_STOCK',
      { plan: { ...plan, readiness: undefined }, lines },
    );
  }

  // The hold is the commitment. If this conditional update fails the transaction
  // aborts and no order exists for a quantity that was not secured.
  await placeQuotationHold(pending, {
    plan: plan.available.map(entry => ({
      itemId: entry.itemId,
      quantity: entry.quantity,
      warehouse: entry.warehouse,
      shade: entry.shade,
      batch: entry.batch,
    })),
    session,
    actor: actor._id,
    reason: `Dealer order request ${request.requestNumber} pending stock confirmed`,
  });
  pending.status = 'approved';
  pending.stockQueuedAt = pending.stockQueuedAt || new Date();
  await pending.save({ session });

  const key = `dealer-order-request-pending:${idOf(request._id)}:${idOf(pending._id)}`;
  const { salesOrder, conversion } = await convertQuotationCore({
    quotationId: pending._id,
    branchId,
    actor,
    mode: 'full',
    includePartialLines,
    sourceKey: conversionSourceKey(idOf(pending._id), key),
    fingerprint: conversionFingerprint({ mode: 'full', includePartialLines }),
    session,
    remarksNote: `Dealer order request ${request.requestNumber} pending stock converted from ${pending.quotationNumber}.`,
    stampSourceRequest: false,
  });

  const now = new Date();
  const updated = await DealerOrderRequest.findOneAndUpdate(
    {
      _id: request._id,
      branch: branchId,
      revision: request.revision,
      pendingStockQuotation: pending._id,
    },
    {
      $set: { status: 'quotation_linked', pendingStockFulfilledAt: now },
      $push: {
        outcomes: {
          kind: 'shortfall',
          quotation: pending._id,
          salesOrder: salesOrder._id,
          at: now,
          by: actor._id,
        },
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session },
  );
  if (!updated) throw processingError(409, 'The dealer order request changed while the pending stock was being processed. Refresh and retry.');

  return { request: updated, quotation: pending, salesOrder, conversion, plan, lines };
}

/** Per-product view of the plan, which is the shape both the UI and the dealer see. */
export function planLines(plan, requestItems) {
  const requestedByProduct = new Map((requestItems || []).map(item => [idOf(item.product), item]));
  const allocatedByProduct = new Map();
  const shortfallByProduct = new Map();
  for (const entry of plan.available) {
    allocatedByProduct.set(entry.productId, qty((allocatedByProduct.get(entry.productId) || 0) + entry.quantity));
  }
  for (const entry of plan.shortfall) {
    shortfallByProduct.set(entry.productId, qty((shortfallByProduct.get(entry.productId) || 0) + entry.quantity));
  }
  return [...requestedByProduct.entries()].map(([productId, item]) => ({
    product: item.product,
    productCode: item.productCode || '',
    productName: item.productName || '',
    productImage: item.productImage || '',
    unit: item.unit || 'Box',
    requestedQty: qty(item.quantity),
    allocatedQty: allocatedByProduct.get(productId) || 0,
    availableQty: allocatedByProduct.get(productId) || 0,
    shortfallQty: shortfallByProduct.get(productId) || 0,
  }));
}

/**
 * Validates the per-line availability answers staff give for a shortfall. Every
 * short line needs an answer, and an answer is either a date or an explicit
 * "no ETA" — silence would be published to the dealer as a blank promise.
 */
export function buildShortfallLines({ lines, shortfallInput }) {
  const shortLines = lines.filter(line => line.shortfallQty > SHORTFALL_TOLERANCE);
  if (!shortLines.length) return [];

  const byProduct = new Map();
  for (const entry of shortfallInput || []) {
    const key = idOf(entry.product);
    if (!key) throw processingError(422, 'Each shortfall answer needs a product.');
    if (byProduct.has(key)) throw processingError(422, 'Each product may appear only once in the shortfall answers.');
    byProduct.set(key, entry);
  }

  return shortLines.map((line) => {
    const answer = byProduct.get(idOf(line.product));
    if (!answer) {
      throw processingError(422, `${line.productName || 'A short line'} needs an expected availability date or an explicit "not available".`);
    }
    // Either a date or an explicit "not available". Treating a forgotten date as
    // "not available" would publish a statement to the dealer that nobody made.
    const noEta = answer.noEta === true;
    let expectedDate = null;
    if (!noEta) {
      expectedDate = new Date(answer.expectedDate);
      if (!answer.expectedDate || Number.isNaN(expectedDate.getTime())) {
        throw processingError(422, `${line.productName || 'A short line'} needs a valid expected availability date, or mark it as not available.`);
      }
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      if (expectedDate.getTime() < todayStart.getTime()) {
        throw processingError(422, `The expected availability date for ${line.productName || 'a short line'} cannot be in the past.`);
      }
    }
    // The remark is optional throughout, including on a "no ETA" line: the flag
    // already tells the dealer what they need to know.
    const staffRemark = String(answer.staffRemark || '').trim();
    if (staffRemark.length > 500) throw processingError(422, 'A shortfall remark cannot exceed 500 characters.');
    return {
      product: line.product,
      productCode: line.productCode,
      productName: line.productName,
      productImage: line.productImage,
      unit: line.unit,
      requestedQty: line.requestedQty,
      processedQty: line.allocatedQty,
      shortfallQty: line.shortfallQty,
      expectedDate,
      noEta,
      staffRemark,
      dealerResponse: 'pending',
      dealerQty: null,
      dealerRemark: '',
      respondedAt: null,
      settledQty: 0,
    };
  });
}

/**
 * Commits the plan.
 *
 * Splits the quotation, holds and reserves the available part into a Sales Order,
 * and records the shortfall as round 1 of the dealer conversation. Must run inside
 * a transaction: if the hold or the reservation fails, the Sales Order, the split
 * and the request update all roll back together and staff sees a fresh plan.
 */
export async function processDealerOrderRequest({
  requestId,
  branchId,
  actor,
  planHash,
  shortfallInput = [],
  offerRemark = '',
  includePartialLines = true,
  session,
}) {
  if (!session) throw processingError(500, 'Dealer order processing requires an open transaction session.');
  const submittedHash = String(planHash || '').trim();
  if (!submittedHash) throw processingError(422, 'planHash is required. Fetch the stock plan first.');

  const loaded = await loadProcessableRequest({ requestId, branchId, session });
  if (loaded.processedAt) {
    throw processingError(409, 'This request has already been processed.', 'REQUEST_ALREADY_PROCESSED');
  }
  const { quotation } = await prepareDealerOrderQuotation({ request: loaded, branchId, actor, session });
  if (quotation.status === 'pending_approval') {
    throw processingError(
      409,
      `Quotation ${quotation.quotationNumber} needs pricing approval before stock can be committed.`,
      'PRICING_APPROVAL_REQUIRED',
    );
  }
  // Preparation bumps `revision` when it links the quotation, so the compare-and-set
  // at the end of this function has to be built on the post-preparation revision or
  // it would always lose against itself.
  const request = await loadProcessableRequest({ requestId, branchId, session });

  // Recompute from live stock. This is the whole safety story: an approval made
  // against a picture that has since changed is refused rather than quietly
  // downgraded, in either direction.
  const plan = await computeSplitPlan(quotation, { session });
  if (plan.planHash !== submittedHash) {
    throw processingError(
      409,
      'Stock changed while this was being processed. Review the updated plan and confirm again.',
      'SPLIT_PLAN_CHANGED',
      { plan: { ...plan, readiness: undefined }, lines: planLines(plan, request.items) },
    );
  }
  if (!plan.available.length && !plan.shortfall.length) {
    throw processingError(409, 'This request\'s quotation has no remaining quantity to process.', 'QUOTATION_FULLY_CONVERTED');
  }

  const lines = planLines(plan, request.items);
  const shortfallLines = buildShortfallLines({ lines, shortfallInput, roundNumber: 1 });
  const now = new Date();
  const stockPlan = {
    computedAt: now,
    computedBy: actor._id,
    planHash: plan.planHash,
    lines: lines.map(line => ({
      product: line.product,
      productName: line.productName,
      unit: line.unit,
      requestedQty: line.requestedQty,
      availableQty: line.availableQty,
      allocatedQty: line.allocatedQty,
      shortfallQty: line.shortfallQty,
    })),
  };

  const outcomes = [];
  let availableQuotation = null;
  let salesOrder = null;
  let conversion = null;

  const convert = async (target, note) => {
    // The idempotency scope is derived from the request rather than a client
    // header, so a retried process call replays the same conversion instead of
    // reserving stock twice.
    const key = `dealer-order-request:${idOf(request._id)}:${idOf(target._id)}`;
    const result = await convertQuotationCore({
      quotationId: target._id,
      branchId,
      actor,
      mode: 'full',
      includePartialLines,
      sourceKey: conversionSourceKey(idOf(target._id), key),
      fingerprint: conversionFingerprint({ mode: 'full', includePartialLines }),
      session,
      remarksNote: note,
      // The request bookkeeping below is richer than the single-order stamp the
      // conversion core does, and a split produces more than one order.
      stampSourceRequest: false,
    });
    return result;
  };

  if (!plan.willSplit) {
    // Everything the dealer asked for is available: hold it all, convert it all,
    // and there is nothing to ask them about.
    await placeQuotationHold(quotation, {
      plan: plan.available.map(entry => ({
        itemId: entry.itemId,
        quantity: entry.quantity,
        warehouse: entry.warehouse,
        shade: entry.shade,
        batch: entry.batch,
      })),
      session,
      actor: actor._id,
      reason: `Dealer order request ${request.requestNumber} stock hold`,
    });
    ({ salesOrder, conversion } = await convert(
      quotation,
      `Dealer order request ${request.requestNumber} converted from ${quotation.quotationNumber}.`,
    ));
    availableQuotation = quotation;
    outcomes.push({ kind: 'available', quotation: quotation._id, salesOrder: salesOrder._id, at: now, by: actor._id });
  } else {
    // Something is short. Retire the quotation as the immutable record of the full
    // ask and split off only the part whose stock we can actually hold. No
    // pending-stock quotation is raised here: the short quantity is a question for
    // the dealer, and putting it on a quotation before they have answered would
    // show them a commitment that does not exist. It is raised when they accept.
    //
    // When nothing at all is available this creates no children — the parent is
    // retired and the whole quantity goes to the dealer as a question.
    const split = await executeSplit(quotation, plan, {
      session,
      actor: actor._id,
      reason: `Dealer order request ${request.requestNumber} stock split`,
      createShortfallChild: false,
    });
    availableQuotation = split.available;
    if (split.available) {
      ({ salesOrder, conversion } = await convert(
        split.available,
        `Dealer order request ${request.requestNumber} available stock converted from ${split.available.quotationNumber}.`,
      ));
      outcomes.push({ kind: 'available', quotation: split.available._id, salesOrder: salesOrder._id, at: now, by: actor._id });
    }
  }

  const hasShortfall = shortfallLines.length > 0;
  const status = !hasShortfall
    ? 'quotation_linked'
    : salesOrder ? 'partially_processed' : 'awaiting_dealer';

  const updated = await DealerOrderRequest.findOneAndUpdate(
    {
      _id: request._id,
      branch: branchId,
      revision: request.revision,
      processedAt: { $exists: false },
    },
    {
      $set: {
        status,
        stockPlan,
        processedAt: now,
        processedBy: actor._id,
        outcomes,
        ...(availableQuotation ? { availableQuotation: availableQuotation._id } : {}),
        ...(salesOrder ? { sourceSalesOrder: salesOrder._id, convertedAt: now } : {}),
        shortfallStatus: hasShortfall ? 'awaiting_dealer' : 'none',
        shortfallRounds: hasShortfall ? [{
          round: 1,
          offeredAt: now,
          offeredBy: actor._id,
          offeredByName: actor.name || '',
          offerRemark: String(offerRemark || '').trim(),
          lines: shortfallLines,
          outcome: 'pending',
        }] : [],
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session },
  );
  if (!updated) throw processingError(409, 'The dealer order request changed while it was being processed. Refresh and retry.');

  return {
    request: updated,
    plan,
    lines,
    parentQuotation: plan.willSplit ? quotation : null,
    availableQuotation,
    // Raised only when the dealer accepts the shortfall, so there is never one here.
    pendingStockQuotation: null,
    salesOrder,
    conversion,
    shortfallLines,
  };
}
