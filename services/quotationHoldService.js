import Quotation from '../models/Quotation.js';
import { refreshSalesOrderLine } from '../utils/salesOrderInventory.js';
import { applyStockMovement, stockOperationKey } from './stockMovementService.js';
import { stableUomSnapshot } from './stockUomService.js';

/**
 * Quotation stock holds.
 *
 * A quotation normally holds nothing — readiness is a virtual FIFO calculation
 * that never touches Stock. That makes "this quantity is available" a prediction
 * which can be wrong by the time a Sales Order is created.
 *
 * A hold turns the prediction into a fact. It moves Stock.availableQty into
 * Stock.quotedQty, so no one else can sell it, using the same atomic guard that
 * protects sales reservations:
 *
 *   { ...exactBucket, $expr: { $gte: [{ $ifNull: ['$availableQty', 0] }, q] } }
 *
 * Conversion then moves quotedQty straight to reservedQty and never touches
 * availableQty, which is why converting a held quotation cannot fail on stock.
 *
 *   place    availableQty -q   quotedQty   +q
 *   consume  quotedQty    -q   reservedQty +q
 *   release  quotedQty    -q   availableQty +q
 *
 * This mirrors the transfer_block pattern already used for stock transfers, and
 * the version-suffixed operationKeys used by sales reservations so a
 * withTransaction retry cannot double-apply a movement.
 */

export const HOLD_TOLERANCE = 0.0001;

const conflict = (message, code) => Object.assign(new Error(message), { status: 409, ...(code ? { code } : {}) });
const invalid = (message, code) => Object.assign(new Error(message), { status: 422, ...(code ? { code } : {}) });
const numeric = value => Number(value || 0);
const rounded = value => Math.round((numeric(value) + Number.EPSILON) * 1e6) / 1e6;
const idOf = value => String(value?._id || value || '');

/** Hours a hold survives before the sweeper releases it. 0 disables expiry. */
export function holdTtlHours() {
  const configured = Number(process.env.QUOTATION_HOLD_TTL_HOURS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 72;
}

/**
 * Committed per-line hold counters, read inside the transaction. If
 * withTransaction retries its callback, the aborted in-memory document cannot be
 * trusted to advance the operationKey namespace.
 */
async function persistedHoldVersions(quotationId, session) {
  const persisted = await Quotation.findById(quotationId)
    .select('items._id items.holdVersion items.holdReleaseVersion')
    .session(session)
    .lean();
  if (!persisted) throw conflict('Quotation no longer exists.', 'QUOTATION_MISSING');
  return new Map((persisted.items || []).map(item => [String(item._id), item]));
}

/** Aggregate hold state from the per-line held quantities. */
export function deriveHoldStatus(items = []) {
  const lines = items.filter(item => numeric(item.quantity) > HOLD_TOLERANCE);
  if (!lines.length) return 'none';
  const held = lines.filter(item => numeric(item.holdQuantity) > HOLD_TOLERANCE);
  if (!held.length) return 'none';
  const fully = lines.every(item => numeric(item.holdQuantity) >= numeric(item.quantity) - HOLD_TOLERANCE);
  return fully ? 'held' : 'partial';
}

function assertBucket(line) {
  if (!line.product || !line.warehouse) {
    throw conflict(
      `A warehouse is required to hold stock for ${line.productName || line.productCode || 'every item'}.`,
      'HOLD_BUCKET_REQUIRED',
    );
  }
}

/**
 * Place a hold on a quotation.
 *
 * `plan` is a list of `{ itemId, quantity, warehouse, shade, batch }` produced by
 * the FIFO readiness allocation. The bucket is written back onto the line so the
 * line, the hold and the later consume all target exactly the same Stock row —
 * the guard matches the bucket exactly and cannot upsert on a negative delta, so
 * a drifting shade or batch would look identical to "no stock".
 */
export async function placeQuotationHold(quotation, {
  plan = [],
  session = null,
  actor = null,
  reason = 'Quotation stock hold',
  expiresInHours = null,
} = {}) {
  if (!quotation) throw invalid('A quotation is required to place a stock hold.');
  if (!session) throw Object.assign(new Error('Quotation stock hold requires an active transaction.'), { status: 500 });

  const byItemId = new Map(plan
    .filter(entry => rounded(entry.quantity) > HOLD_TOLERANCE)
    .map(entry => [String(entry.itemId), entry]));
  if (!byItemId.size) throw invalid('A stock hold needs at least one line with a positive quantity.', 'EMPTY_HOLD_PLAN');

  const versions = await persistedHoldVersions(quotation._id, session);
  const applied = new Map();

  for (const line of quotation.items) {
    const entry = byItemId.get(String(line._id));
    if (!entry) continue;

    const requested = rounded(entry.quantity);
    const alreadyHeld = rounded(line.holdQuantity);
    const target = rounded(alreadyHeld + requested);
    if (target > numeric(line.quantity) + HOLD_TOLERANCE) {
      throw invalid(
        `Cannot hold ${target} of ${line.productName || 'item'}; only ${numeric(line.quantity)} was quoted.`,
        'HOLD_EXCEEDS_QUANTITY',
      );
    }

    // Pin the bucket the allocation chose before the movement, so line and
    // movement can never disagree.
    if (entry.warehouse) line.warehouse = entry.warehouse;
    if (entry.shade !== undefined) line.shade = entry.shade || '';
    if (entry.batch !== undefined) line.batch = entry.batch || '';
    assertBucket(line);

    const persistedLine = versions.get(String(line._id));
    if (!persistedLine) throw conflict('Quotation line no longer exists.', 'QUOTATION_LINE_MISSING');
    const nextHoldVersion = numeric(persistedLine.holdVersion) + 1;

    const snapshot = stableUomSnapshot(line);
    const baseQuantity = requested * snapshot.conversionFactor;

    await applyStockMovement({
      operationKey: stockOperationKey('quotation', quotation._id, line._id, 'hold-event', nextHoldVersion),
      correlationKey: stockOperationKey('quotation', quotation._id, 'hold', nextHoldVersion),
      movementType: 'quotation_hold',
      phase: 'reserved',
      branch: quotation.branch,
      product: line.product,
      warehouse: line.warehouse,
      shade: line.shade || '',
      batch: line.batch || '',
      deltas: { availableQty: -baseQuantity, quotedQty: baseQuantity },
      enteredQuantity: requested,
      ...snapshot,
      baseQuantity,
      sourceType: 'Quotation',
      sourceModel: 'Quotation',
      sourceId: quotation._id,
      sourceLineId: line._id,
      sourceNumber: quotation.quotationNumber,
      actor: actor?._id || actor || quotation.createdBy,
      occurredAt: new Date(),
      reason,
      metadata: {
        holdVersion: nextHoldVersion,
        heldQuantity: requested,
        targetHoldQuantity: target,
        splitRole: quotation.splitRole || 'none',
      },
      guardMessage: `Insufficient available stock to hold ${line.productName || line.productCode || 'item'} (shade ${line.shade || 'default'}, batch ${line.batch || 'default'}).`,
    }, { session });

    applied.set(String(line._id), { holdVersion: nextHoldVersion, quantity: requested });
  }

  if (!applied.size) throw invalid('No quotation line matched the hold plan.', 'HOLD_PLAN_UNMATCHED');

  const now = new Date();
  for (const line of quotation.items) {
    const result = applied.get(String(line._id));
    if (!result) continue;
    line.holdQuantity = rounded(numeric(line.holdQuantity) + result.quantity);
    line.holdVersion = result.holdVersion;
  }

  quotation.holdStatus = deriveHoldStatus(quotation.items);
  quotation.heldAt = quotation.heldAt || now;
  quotation.heldBy = quotation.heldBy || (actor?._id || actor || undefined);
  quotation.holdReleasedAt = undefined;
  quotation.holdExpiredAt = undefined;
  quotation.holdExpiryReason = '';

  // An existing expiry is never shortened, matching the sales reservation rule.
  if (!quotation.holdExpiresAt) {
    const requestedHours = Number(expiresInHours);
    const ttlHours = Number.isFinite(requestedHours) && requestedHours > 0 ? requestedHours : holdTtlHours();
    if (Number.isFinite(ttlHours) && ttlHours > 0) {
      quotation.holdExpiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
      quotation.holdExpiryState = 'active';
      quotation.holdExpiryVersion = Math.max(1, numeric(quotation.holdExpiryVersion));
    } else {
      quotation.holdExpiryState = 'none';
    }
  }

  await quotation.save({ session });
  return quotation;
}

/**
 * Turn a quotation's hold into the Sales Order's reservation.
 *
 * This is the no-mismatch guarantee: the movement never touches availableQty, so
 * it cannot compete with anyone. Its only guard is `quotedQty >= q`, which just
 * confirms our own hold still exists — it can realistically only fail if the
 * expiry sweeper released the hold first.
 *
 * Returns the entered quantity consumed per Sales Order line id, so the caller
 * knows what still needs a normal reservation.
 */
export async function consumeQuotationHold(quotation, salesOrder, {
  session = null,
  actor = null,
  reason = 'Quotation hold consumed by Sales Order',
} = {}) {
  if (!session) throw Object.assign(new Error('Quotation hold consumption requires an active transaction.'), { status: 500 });
  const consumed = new Map();
  if (!quotation || !salesOrder) return consumed;
  if (!['held', 'partial'].includes(quotation.holdStatus)) return consumed;

  // Remaining hold per quotation line, keyed by line id.
  const remainingHold = new Map((quotation.items || [])
    .filter(item => rounded(item.holdQuantity) > HOLD_TOLERANCE)
    .map(item => [String(item._id), { line: item, remaining: rounded(item.holdQuantity) }]));
  if (!remainingHold.size) return consumed;

  for (const orderLine of salesOrder.items) {
    const sourceId = String(orderLine.sourceQuotationItem || '');
    const held = remainingHold.get(sourceId);
    if (!held || held.remaining <= HOLD_TOLERANCE) continue;

    const quantity = rounded(Math.min(numeric(orderLine.quantity), held.remaining));
    if (quantity <= HOLD_TOLERANCE) continue;

    const snapshot = stableUomSnapshot(orderLine);
    const baseQuantity = quantity * snapshot.conversionFactor;

    await applyStockMovement({
      // Keyed by the Sales Order line, so replaying one conversion replays the
      // same movement while a second conversion gets a distinct key.
      operationKey: stockOperationKey('quotation', quotation._id, held.line._id, 'hold-consume', 'sales-order', salesOrder._id, orderLine._id),
      correlationKey: stockOperationKey('quotation', quotation._id, 'hold-consume', salesOrder._id),
      movementType: 'quotation_hold_consume',
      phase: 'reclassified',
      branch: salesOrder.branch,
      product: orderLine.product,
      warehouse: orderLine.warehouse,
      shade: orderLine.shade || '',
      batch: orderLine.batch || '',
      deltas: { quotedQty: -baseQuantity, reservedQty: baseQuantity },
      enteredQuantity: quantity,
      ...snapshot,
      baseQuantity,
      sourceType: 'SalesOrder',
      sourceModel: 'SalesOrder',
      sourceId: salesOrder._id,
      sourceLineId: orderLine._id,
      sourceNumber: salesOrder.orderNumber,
      actor: actor?._id || actor || salesOrder.createdBy,
      occurredAt: new Date(),
      reason,
      metadata: {
        quotation: idOf(quotation._id),
        quotationNumber: quotation.quotationNumber,
        quotationItem: idOf(held.line._id),
        holdVersion: numeric(held.line.holdVersion),
        consumedQuantity: quantity,
      },
      guardMessage: `The stock hold for ${orderLine.productName || orderLine.productCode || 'item'} is no longer present; it may have expired. Refresh the quotation and retry.`,
    }, { session });

    held.remaining = rounded(held.remaining - quantity);
    held.line.holdQuantity = rounded(numeric(held.line.holdQuantity) - quantity);

    // Book the reservation onto the order line. Without this the stock would say
    // reservedQty while the line said nothing, and reserveSalesOrderInventory
    // would reserve the same quantity a second time.
    //
    // reservationVersion is deliberately left alone: this movement lives in its
    // own operationKey namespace (quotation:...:hold-consume:...), so it does not
    // consume a sales_reservation sequence number.
    orderLine.reservedQuantity = rounded(numeric(orderLine.reservedQuantity) + quantity);
    refreshSalesOrderLine(orderLine);
    consumed.set(String(orderLine._id), quantity);
  }

  if (!consumed.size) return consumed;

  salesOrder.reservationStatus = salesOrder.items.every(
    line => numeric(line.remainingQuantity) <= HOLD_TOLERANCE,
  ) ? 'consumed' : 'reserved';
  salesOrder.reservedAt = salesOrder.reservedAt || new Date();
  salesOrder.reservationReleasedAt = undefined;
  await salesOrder.save({ session });

  const stillHeld = (quotation.items || []).some(item => rounded(item.holdQuantity) > HOLD_TOLERANCE);
  quotation.holdStatus = stillHeld ? 'partial' : 'consumed';
  if (!stillHeld) {
    quotation.holdConsumedAt = new Date();
    quotation.holdExpiryState = 'released';
    quotation.holdExpiresAt = undefined;
  }
  await quotation.save({ session });
  return consumed;
}

/**
 * Return held stock to available. Used on cancellation and by the expiry sweeper.
 * `expiryState` distinguishes a deliberate release from a TTL lapse.
 */
export async function releaseQuotationHold(quotation, {
  session = null,
  actor = null,
  reason = 'Quotation stock hold released',
  expiryState = 'released',
} = {}) {
  if (!quotation) return null;
  if (!session) throw Object.assign(new Error('Quotation stock hold release requires an active transaction.'), { status: 500 });

  const releasable = (quotation.items || []).filter(item => rounded(item.holdQuantity) > HOLD_TOLERANCE);
  if (!releasable.length) {
    // Normalise state even when there is nothing to move, so a double release is
    // safe and leaves no misleading "held" flag behind.
    if (!['consumed', 'none'].includes(quotation.holdStatus)) {
      quotation.holdStatus = expiryState === 'expired' ? 'expired' : 'released';
      quotation.holdExpiryState = expiryState;
      quotation.holdExpiresAt = undefined;
      await quotation.save({ session });
    }
    return quotation;
  }

  const versions = await persistedHoldVersions(quotation._id, session);
  const applied = new Map();

  for (const line of releasable) {
    const quantity = rounded(line.holdQuantity);
    assertBucket(line);
    const persistedLine = versions.get(String(line._id));
    if (!persistedLine) throw conflict('Quotation line no longer exists.', 'QUOTATION_LINE_MISSING');
    const nextReleaseVersion = numeric(persistedLine.holdReleaseVersion) + 1;

    const snapshot = stableUomSnapshot(line);
    const baseQuantity = quantity * snapshot.conversionFactor;

    await applyStockMovement({
      operationKey: stockOperationKey('quotation', quotation._id, line._id, 'hold-release-event', nextReleaseVersion),
      correlationKey: stockOperationKey('quotation', quotation._id, 'hold-release', nextReleaseVersion),
      movementType: 'quotation_hold_release',
      phase: 'released',
      branch: quotation.branch,
      product: line.product,
      warehouse: line.warehouse,
      shade: line.shade || '',
      batch: line.batch || '',
      deltas: { quotedQty: -baseQuantity, availableQty: baseQuantity },
      enteredQuantity: quantity,
      ...snapshot,
      baseQuantity,
      sourceType: 'Quotation',
      sourceModel: 'Quotation',
      sourceId: quotation._id,
      sourceLineId: line._id,
      sourceNumber: quotation.quotationNumber,
      actor: actor?._id || actor || quotation.createdBy,
      occurredAt: new Date(),
      reason,
      metadata: { holdReleaseVersion: nextReleaseVersion, releasedQuantity: quantity, expiryState },
      guardMessage: `Held stock is inconsistent for ${line.productName || line.productCode || 'item'}; the release was not applied.`,
    }, { session });

    applied.set(String(line._id), nextReleaseVersion);
  }

  const now = new Date();
  for (const line of quotation.items) {
    const version = applied.get(String(line._id));
    if (version === undefined) continue;
    line.holdReleaseVersion = version;
    line.holdQuantity = 0;
  }

  quotation.holdStatus = expiryState === 'expired' ? 'expired' : 'released';
  quotation.holdExpiryState = expiryState;
  quotation.holdReleasedAt = now;
  if (expiryState === 'expired') quotation.holdExpiredAt = now;
  quotation.holdExpiresAt = undefined;
  quotation.holdExpiryReason = reason;

  await quotation.save({ session });
  return quotation;
}

/** Total entered quantity currently held across a quotation. */
export function totalHeldQuantity(quotation) {
  return rounded((quotation?.items || []).reduce((sum, item) => sum + numeric(item.holdQuantity), 0));
}
