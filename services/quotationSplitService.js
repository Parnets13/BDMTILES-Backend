import crypto from 'crypto';
import mongoose from 'mongoose';
import Quotation from '../models/Quotation.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { getQuotationReadiness, quotationStockEligibility } from './quotationStockService.js';
import { placeQuotationHold } from './quotationHoldService.js';

/**
 * Quotation stock split.
 *
 * An approved quotation whose lines are not all available becomes three records:
 *
 *   parent      status 'split'         immutable record of what the dealer asked
 *     ├─ available   status 'approved'      holds real stock, convertible now
 *     └─ shortfall   status 'pending_stock' queued, convertible when stock lands
 *
 * When every line is fully available there is nothing to split: the quotation
 * stays as it is and only takes a hold.
 *
 * The split boundary is decided from the FIFO readiness allocation and fingerprinted
 * as a planHash. The commit step recomputes the plan and refuses to act on a stale
 * one, so an approver can never unknowingly approve quantities they did not see.
 *
 * Money and pricing are never re-derived. Per-unit values (rate, discount,
 * gstPercentage) are copied verbatim and amount fields are apportioned, because
 * splitting c=20 into 10+10 must not re-run quantity discount slabs — the dealer
 * was quoted a price for 20.
 */

export const SPLIT_TOLERANCE = 0.0001;

const routeError = (status, message, code, details) => Object.assign(
  new Error(message),
  { status, ...(code ? { code } : {}), ...(details ? { details } : {}) },
);
const numeric = value => Number(value || 0);
const qty = value => Math.round((numeric(value) + Number.EPSILON) * 1e6) / 1e6;
const money = value => Math.round((numeric(value) + Number.EPSILON) * 100) / 100;
const idOf = value => String(value?._id || value || '');

// Per-line amount fields are apportioned; everything else is a per-unit or
// descriptive value that must survive the split untouched.
const AMOUNT_FIELDS = ['taxableAmount', 'cgst', 'sgst', 'igst', 'gstAmount', 'totalAmount'];
const CHARGE_FIELDS = ['freightCharges', 'loadingCharges', 'installationCharges', 'otherCharges'];

/**
 * Build the split plan from live FIFO readiness.
 *
 * `allocatedQty` becomes the available side, `shortfallQty` the shortfall side.
 * A line can appear on both when it is partially available.
 */
export async function computeSplitPlan(quotation, { session = null } = {}) {
  const readiness = await getQuotationReadiness(quotation, { session });
  const items = quotation.items || [];

  const available = [];
  const shortfall = [];

  for (const ready of readiness.items) {
    const line = items[ready.itemIndex];
    if (!line) continue;
    const remaining = qty(ready.remainingQty);
    if (remaining <= SPLIT_TOLERANCE) continue; // already converted

    const allocated = qty(Math.min(ready.allocatedQty, remaining));
    const short = qty(remaining - allocated);

    if (allocated > SPLIT_TOLERANCE) {
      available.push({
        itemIndex: ready.itemIndex,
        itemId: idOf(line._id),
        productId: idOf(line.product),
        productName: line.productName || '',
        productCode: line.productCode || '',
        unit: line.unit || '',
        quantity: allocated,
        // The exact bucket FIFO chose. Pinned so the hold, the line and the later
        // reservation all target the same Stock row.
        stockId: idOf(ready.allocation?.stockId),
        warehouse: idOf(ready.allocation?.warehouse) || idOf(line.warehouse),
        shade: ready.allocation?.shade ?? (line.shade || ''),
        batch: ready.allocation?.batch ?? (line.batch || ''),
      });
    }
    if (short > SPLIT_TOLERANCE) {
      shortfall.push({
        itemIndex: ready.itemIndex,
        itemId: idOf(line._id),
        productId: idOf(line.product),
        productName: line.productName || '',
        productCode: line.productCode || '',
        unit: line.unit || '',
        quantity: short,
      });
    }
  }

  const plan = {
    quotation: idOf(quotation._id),
    quotationNumber: quotation.quotationNumber,
    conversionVersion: numeric(quotation.conversionVersion),
    // Nothing to split when every remaining line is fully available.
    willSplit: shortfall.length > 0,
    // Nothing to do at all when no stock can be held and everything is short.
    canHold: available.length > 0,
    available,
    shortfall,
    totals: {
      availableLines: available.length,
      shortfallLines: shortfall.length,
      availableQty: qty(available.reduce((sum, entry) => sum + entry.quantity, 0)),
      shortfallQty: qty(shortfall.reduce((sum, entry) => sum + entry.quantity, 0)),
    },
    checkedAt: readiness.checkedAt,
    readiness,
  };
  plan.planHash = splitPlanHash(plan);
  return plan;
}

/**
 * Deterministic fingerprint of the decision an approver is confirming.
 *
 * Deliberately excludes checkedAt, and deliberately includes conversionVersion so
 * a concurrent conversion invalidates the plan. Because it covers the allocated
 * bucket as well as the quantity, it also catches stock moving to a different
 * shade or batch — which would fail the reservation guard later.
 */
export function splitPlanHash(plan) {
  const canonical = {
    quotation: plan.quotation,
    conversionVersion: plan.conversionVersion,
    willSplit: plan.willSplit,
    available: plan.available.map(entry => [
      entry.itemId, entry.productId, qty(entry.quantity), entry.stockId, entry.warehouse, entry.shade, entry.batch,
    ]),
    shortfall: plan.shortfall.map(entry => [entry.itemId, entry.productId, qty(entry.quantity)]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Scale a parent line down to `quantity`, keeping per-unit values verbatim. */
function scaleLine(parentLine, quantity) {
  const source = parentLine.toObject ? parentLine.toObject() : { ...parentLine };
  const parentQty = numeric(source.quantity) || 1;
  const ratio = quantity / parentQty;
  const child = {
    ...source,
    _id: new mongoose.Types.ObjectId(),
    parentQuotationItem: source._id,
    quantity: qty(quantity),
    // A child starts unconverted and unheld regardless of the parent's history.
    convertedQuantity: 0,
    holdQuantity: 0,
    holdVersion: 0,
    holdReleaseVersion: 0,
  };
  for (const field of AMOUNT_FIELDS) child[field] = money(numeric(source[field]) * ratio);
  // Presentation quantities follow the same ratio; boxes tracks the entered qty.
  child.boxes = qty(quantity);
  child.pieces = numeric(source.pieces) > 0 ? qty(numeric(source.pieces) * ratio) : 0;
  child.sqft = numeric(source.sqft) > 0 ? qty(numeric(source.sqft) * ratio) : 0;
  if (numeric(source.conversionFactor) > 0) {
    child.baseQuantity = qty(quantity * numeric(source.conversionFactor));
  }
  return child;
}

/**
 * The arithmetic remainder of a parent line after `taken` was scaled off it, so
 * the two children's amounts always add back up to the parent exactly instead of
 * leaking a paisa to rounding.
 */
function complementLine(parentLine, taken, quantity) {
  const child = scaleLine(parentLine, quantity);
  const source = parentLine.toObject ? parentLine.toObject() : parentLine;
  for (const field of AMOUNT_FIELDS) {
    child[field] = money(numeric(source[field]) - numeric(taken[field]));
  }
  child.pieces = qty(Math.max(0, numeric(source.pieces) - numeric(taken.pieces)));
  child.sqft = qty(Math.max(0, numeric(source.sqft) - numeric(taken.sqft)));
  return child;
}

/** Value weight used to apportion order-level charges. */
const lineWeight = line => Math.max(
  numeric(line.taxableAmount),
  numeric(line.totalAmount),
  numeric(line.quantity),
);

function totalsFor(items, charges) {
  const subtotal = money(items.reduce((sum, item) => sum + numeric(item.taxableAmount), 0));
  const totalTax = money(items.reduce((sum, item) => sum + numeric(item.gstAmount), 0));
  const totalDiscount = money(items.reduce((sum, item) => {
    const perUnit = item.discountType === 'percentage'
      ? numeric(item.rate) * numeric(item.discount) / 100
      : numeric(item.discount);
    return sum + perUnit * numeric(item.quantity);
  }, 0));
  const totalSchemeDiscount = money(items.reduce(
    (sum, item) => sum + numeric(item.schemeDiscount) * numeric(item.quantity), 0,
  ));
  const chargeTotal = money(CHARGE_FIELDS.reduce((sum, field) => sum + numeric(charges[field]), 0));
  return {
    subtotal,
    totalTax,
    totalDiscount,
    totalSchemeDiscount,
    ...charges,
    roundOff: money(charges.roundOff || 0),
    grandTotal: money(subtotal + totalTax + chargeTotal + numeric(charges.roundOff)),
  };
}

/** Re-point below_minimum_price reasons at the child's own line indexes. */
function reindexApprovalReasons(reasons = [], childItems = []) {
  const indexByParentItem = new Map(childItems.map((item, index) => [String(item.parentQuotationItem), index]));
  return reasons.flatMap((reason) => {
    const { __parentItemId: parentItemId, ...plain } = reason.toObject ? reason.toObject() : { ...reason };
    if (plain.type !== 'below_minimum_price') return [plain];
    // The reason's itemIndex refers to the parent; drop it if the line did not
    // land in this child.
    const index = parentItemId === undefined ? undefined : indexByParentItem.get(String(parentItemId));
    return index === undefined ? [] : [{ ...plain, itemIndex: index }];
  });
}

/** Fields every child copies from its parent. */
function childBase(parent) {
  const source = parent.toObject ? parent.toObject() : parent;
  return {
    branch: source.branch,
    quotationDate: source.quotationDate,
    validUntil: source.validUntil,
    dealer: source.dealer,
    dealerType: source.dealerType,
    dealerTypeSnapshot: source.dealerTypeSnapshot,
    dealerName: source.dealerName,
    dealerCode: source.dealerCode,
    customerType: source.customerType,
    customerName: source.customerName,
    customerPhone: source.customerPhone,
    customerAddress: source.customerAddress,
    termsAndConditions: source.termsAndConditions,
    snapshotCaptured: source.snapshotCaptured,
    stockSnapshotAt: source.stockSnapshotAt,
    // Both children inherit the parent's FIFO position. The shortfall child keeps
    // it so it is served fairly the moment a GRN lands.
    stockQueuedAt: source.stockQueuedAt,
    // Pricing approval was already granted on the parent.
    approvalRequired: source.approvalRequired,
    approvalStatus: source.approvalStatus,
    approvedBy: source.approvedBy,
    approvalDate: source.approvalDate,
    approvalRemarks: source.approvalRemarks,
    createdBy: source.createdBy,
    tallySyncStatus: 'not_synced',
    // sourceDealerOrderRequest is deliberately NOT copied: it carries a unique
    // partial index per branch, and the parent remains its single linked quotation.
  };
}

/**
 * Execute a split that has already been confirmed.
 *
 * Must run inside a transaction. The caller is responsible for having verified
 * the planHash immediately beforehand; if a hold fails here the whole transaction
 * aborts and the caller re-presents a fresh plan.
 *
 * `createShortfallChild: false` retires the parent and creates only the available
 * child, leaving the short quantity with no quotation of its own. Dealer order
 * processing works this way: the short quantity is a question, not an offer, until
 * the dealer answers it, and a pending-stock quotation sitting there for a quantity
 * nobody has agreed to would read as a commitment. The parent still records the
 * full original ask, so nothing is lost by waiting.
 */
export async function executeSplit(parent, plan, {
  session,
  actor = null,
  reason = 'Quotation stock split',
  createShortfallChild = true,
}) {
  if (!session) throw Object.assign(new Error('Quotation split requires an active transaction.'), { status: 500 });

  const eligibility = quotationStockEligibility(parent.toObject ? parent.toObject() : parent);
  if (!eligibility.conversionEligible) {
    throw routeError(409, 'Only an approved or accepted quotation can take a stock hold.', 'QUOTATION_NOT_ELIGIBLE', plan.readiness);
  }

  const parentItems = parent.items || [];
  const availableByItem = new Map(plan.available.map(entry => [entry.itemId, entry]));
  const shortfallByItem = new Map(plan.shortfall.map(entry => [entry.itemId, entry]));

  // ── Build child line sets, apportioning amounts exactly ────────────────────
  const availableItems = [];
  const shortfallItems = [];
  for (const line of parentItems) {
    const key = idOf(line._id);
    const availEntry = availableByItem.get(key);
    const shortEntry = shortfallByItem.get(key);
    let taken = null;
    if (availEntry) {
      taken = scaleLine(line, availEntry.quantity);
      // Pin the allocated bucket onto the child line.
      if (availEntry.warehouse) taken.warehouse = new mongoose.Types.ObjectId(availEntry.warehouse);
      taken.shade = availEntry.shade || '';
      taken.batch = availEntry.batch || '';
      availableItems.push(taken);
    }
    if (shortEntry) {
      shortfallItems.push(taken
        ? complementLine(line, taken, shortEntry.quantity)
        : scaleLine(line, shortEntry.quantity));
    }
  }

  if (!availableItems.length && !shortfallItems.length) {
    throw routeError(409, 'Quotation has no remaining quantity to split.', 'QUOTATION_FULLY_CONVERTED');
  }

  // ── Apportion order-level charges by value weight, remainder to shortfall ──
  const parentPlain = parent.toObject ? parent.toObject() : parent;
  const totalWeight = parentItems.reduce((sum, line) => sum + lineWeight(line), 0);
  const availableWeight = availableItems.reduce((sum, line) => sum + lineWeight(line), 0);
  const chargeSplit = (field) => {
    const total = money(parentPlain[field]);
    if (!shortfallItems.length) return { available: total, shortfall: 0 };
    if (!availableItems.length) return { available: 0, shortfall: total };
    const availableShare = totalWeight > 0 ? money(total * availableWeight / totalWeight) : 0;
    return { available: availableShare, shortfall: money(total - availableShare) };
  };
  const charges = Object.fromEntries([...CHARGE_FIELDS, 'roundOff'].map(field => [field, chargeSplit(field)]));
  const chargesFor = side => Object.fromEntries(
    [...CHARGE_FIELDS, 'roundOff'].map(field => [field, charges[field][side]]),
  );

  // ── Tag approval reasons with their parent line so they can be re-indexed ──
  const taggedReasons = (parentPlain.approvalReasons || []).map((entry) => {
    if (entry.type !== 'below_minimum_price') return entry;
    const parentLine = parentItems[entry.itemIndex];
    return { ...entry, __parentItemId: parentLine ? idOf(parentLine._id) : undefined };
  });

  const splitGroupId = parent.splitGroupId || new mongoose.Types.ObjectId();
  const now = new Date();
  const created = {};

  const buildChild = async (items, role, status) => {
    const number = await generateBranchNumber(parent.branch, 'quotation', parentPlain.quotationDate || now, { session });
    const [child] = await Quotation.create([{
      ...childBase(parent),
      quotationNumber: number,
      items,
      ...totalsFor(items, chargesFor(role === 'available' ? 'available' : 'shortfall')),
      approvalReasons: reindexApprovalReasons(taggedReasons, items),
      status,
      splitGroupId,
      splitRole: role,
      splitFromQuotation: parent._id,
      splitAt: now,
      splitBy: actor?._id || actor || undefined,
      splitPlanHash: plan.planHash,
      conversionState: 'none',
      conversionVersion: 0,
      remarks: role === 'available'
        ? `Available stock split from ${parentPlain.quotationNumber}. ${parentPlain.remarks || ''}`.trim()
        : `Pending stock — subject to availability. Split from ${parentPlain.quotationNumber}. ${parentPlain.remarks || ''}`.trim(),
    }], { session });
    return child;
  };

  if (availableItems.length) {
    created.available = await buildChild(availableItems, 'available', 'approved');
    // Take the real hold. The guard here is what turns the prediction into a fact;
    // if it fails the transaction aborts and the caller re-presents a fresh plan.
    await placeQuotationHold(created.available, {
      plan: created.available.items.map(item => ({
        itemId: item._id,
        quantity: item.quantity,
        warehouse: item.warehouse,
        shade: item.shade,
        batch: item.batch,
      })),
      session,
      actor,
      reason,
    });
  }
  if (shortfallItems.length && createShortfallChild) {
    created.shortfall = await buildChild(shortfallItems, 'shortfall', 'pending_stock');
  }

  // ── Retire the parent as an immutable record ───────────────────────────────
  const childIds = [created.available?._id, created.shortfall?._id].filter(Boolean);
  const updatedParent = await Quotation.findOneAndUpdate(
    {
      _id: parent._id,
      branch: parent.branch,
      status: parent.status,
      conversionVersion: numeric(parentPlain.conversionVersion),
    },
    {
      $set: {
        status: 'split',
        splitGroupId,
        splitRole: 'parent',
        splitQuotations: childIds,
        splitAt: now,
        splitBy: actor?._id || actor || undefined,
        splitPlanHash: plan.planHash,
        // A retired parent must not keep a FIFO position or its children would
        // compete with it for the same stock.
        stockQueuedAt: null,
      },
    },
    { new: true, runValidators: true, session },
  );
  if (!updatedParent) {
    throw routeError(409, 'Quotation changed before the split could be applied. Refresh and retry.', 'SPLIT_PLAN_CHANGED');
  }

  return { parent: updatedParent, available: created.available || null, shortfall: created.shortfall || null, splitGroupId };
}

/**
 * Creates the pending-stock child of a split, once somebody has actually agreed to
 * wait for the quantity.
 *
 * Deliberately not created at split time. A pending-stock quotation is a record of
 * an agreement to wait; raising one for a quantity the customer has not yet accepted
 * would show them a commitment that does not exist. So the split leaves the short
 * quantity with no quotation, and this creates it at the finally agreed figure —
 * once, at the right number, with no cancelled drafts behind it.
 *
 * Per-unit values come from the parent's own lines rather than being re-derived. The
 * order was priced as one order; splitting it because we could not supply all of it
 * is our problem, not a reason to re-run quantity slabs against the customer for the
 * part they are still waiting for.
 *
 * Reserves nothing, and cannot: a pending-stock quotation holds no stock by
 * definition. It takes a FIFO position from the moment it is agreed, so it is served
 * in turn when a GRN lands.
 *
 * @param {object} parent            The retired split parent.
 * @param {Map<string, number>} quantityByProduct  Agreed quantity per product id.
 * @returns {Promise<object|null>}   The child, or null when nothing was agreed.
 */
export async function createPendingStockChild(parent, quantityByProduct, {
  session,
  actor = null,
  reason = 'Pending stock agreed',
}) {
  if (!session) throw Object.assign(new Error('Creating a pending-stock quotation requires an active transaction.'), { status: 500 });
  const plain = parent.toObject ? parent.toObject() : parent;
  if (plain.status !== 'split') {
    throw routeError(409, `A pending-stock child can only be added to a split quotation; its parent is "${plain.status}".`, 'QUOTATION_NOT_SPLIT');
  }

  const items = [];
  for (const line of plain.items || []) {
    const target = qty(quantityByProduct.get(idOf(line.product)) ?? 0);
    if (target <= SPLIT_TOLERANCE) continue;
    // The agreed quantity may exceed the parent line: a customer who is told part of
    // their order is delayed is allowed to ask for more of the delayed part. The
    // children then deliberately no longer sum to the parent, because the customer
    // changed what they wanted. The parent stays as the record of the original ask.
    const child = scaleLine(line, target);
    child.parentQuotationItem = line._id;
    items.push(child);
  }
  if (!items.length) return null;

  // Charges follow the value that moved onto this child.
  const totalWeight = (plain.items || []).reduce((sum, line) => sum + lineWeight(line), 0);
  const childWeight = items.reduce((sum, line) => sum + lineWeight(line), 0);
  const ratio = totalWeight > 0 ? childWeight / totalWeight : 0;
  const charges = Object.fromEntries(
    [...CHARGE_FIELDS, 'roundOff'].map(field => [field, money(numeric(plain[field]) * ratio)]),
  );

  const now = new Date();
  const number = await generateBranchNumber(plain.branch, 'quotation', plain.quotationDate || now, { session });
  const [child] = await Quotation.create([{
    ...childBase(plain),
    quotationNumber: number,
    items,
    ...totalsFor(items, charges),
    approvalReasons: reindexApprovalReasons(
      (plain.approvalReasons || []).map((entry) => {
        if (entry.type !== 'below_minimum_price') return entry;
        const sourceLine = (plain.items || [])[entry.itemIndex];
        return { ...entry, __parentItemId: sourceLine ? idOf(sourceLine._id) : undefined };
      }),
      items,
    ),
    status: 'pending_stock',
    splitGroupId: plain.splitGroupId,
    splitRole: 'shortfall',
    splitFromQuotation: plain._id,
    splitAt: now,
    splitBy: actor?._id || actor || undefined,
    splitPlanHash: plain.splitPlanHash,
    // Queued from the moment it was agreed, so an arriving GRN serves it in turn.
    stockQueuedAt: now,
    conversionState: 'none',
    conversionVersion: 0,
    remarks: `Pending stock — subject to availability. ${reason}. Split from ${plain.quotationNumber}.`,
  }], { session });

  const linked = await Quotation.findOneAndUpdate(
    { _id: plain._id, branch: plain.branch, status: 'split' },
    { $addToSet: { splitQuotations: child._id } },
    { new: true, session },
  );
  if (!linked) throw routeError(409, 'The split parent changed before its pending-stock child could be linked. Refresh and retry.', 'SPLIT_PLAN_CHANGED');

  return child;
}

/** Every member of a split family, for the detail view. */
export async function loadSplitFamily(quotation, { session = null } = {}) {
  if (!quotation?.splitGroupId) return [];
  let query = Quotation.find({ branch: quotation.branch, splitGroupId: quotation.splitGroupId })
    .select('quotationNumber status splitRole grandTotal holdStatus holdExpiresAt conversionState stockQueuedAt createdAt')
    .sort({ splitRole: 1, createdAt: 1 });
  if (session) query = query.session(session);
  return query.lean();
}
