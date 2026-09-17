import { applyStockMovement, stockOperationKey } from '../services/stockMovementService.js';
import { stableUomSnapshot } from '../services/stockUomService.js';

export const QUANTITY_TOLERANCE = 0.0001;

const conflict = message => Object.assign(new Error(message), { status: 409 });
const options = session => (session ? { session } : {});
const numeric = value => Number(value || 0);
const rounded = value => Math.round((numeric(value) + Number.EPSILON) * 1e6) / 1e6;

export function refreshSalesOrderLine(line) {
  const ordered = numeric(line.quantity);
  const dispatched = Math.min(ordered, numeric(line.dispatchedQuantity));
  const dispatchReversed = Math.min(dispatched, numeric(line.dispatchReversedQuantity));
  const maxCancellable = Math.max(0, ordered - dispatched + dispatchReversed);
  const cancelled = Math.min(maxCancellable, numeric(line.cancelledRemainingQuantity));
  const returned = Math.min(dispatched, numeric(line.returnedQuantity));
  const reserved = Math.max(0, numeric(line.reservedQuantity));
  // fulfilledQuantity remains the legacy gross-dispatch field for dual-read compatibility.
  line.fulfilledQuantity = rounded(dispatched);
  line.cancelledRemainingQuantity = rounded(cancelled);
  line.returnedQuantity = rounded(returned);
  line.dispatchReversedQuantity = rounded(dispatchReversed);
  line.netFulfilledQuantity = rounded(Math.max(0, dispatched - dispatchReversed - returned));
  line.remainingQuantity = rounded(Math.max(0, ordered - dispatched + dispatchReversed - cancelled));
  line.backorderQuantity = rounded(Math.max(0, line.remainingQuantity - reserved));
  return line;
}

const requirementKey = item => [
  item.product?._id || item.product,
  item.warehouse?._id || item.warehouse,
  item.shade || '',
  item.batch || '',
].map(String).join('|');

function aggregate(lines, quantitySelector, branch) {
  const requirements = new Map();
  for (const line of lines) {
    const quantity = rounded(quantitySelector(line));
    if (!(quantity > QUANTITY_TOLERANCE)) continue;
    if (!line.product || !line.warehouse) {
      throw conflict(`Warehouse is required for ${line.productName || line.productCode || 'every item'}.`);
    }
    const key = requirementKey(line);
    const current = requirements.get(key);
    if (current) current.quantity = rounded(current.quantity + quantity);
    else requirements.set(key, {
      branch,
      product: line.product?._id || line.product,
      warehouse: line.warehouse?._id || line.warehouse,
      shade: line.shade || '',
      batch: line.batch || '',
      productName: line.productName || line.productCode || 'item',
      quantity,
    });
  }
  return [...requirements.values()];
}

async function persistedLineVersions(order, session) {
  const persisted = await order.constructor.findById(order._id)
    .select('items._id items.reservationVersion items.reservationReleaseVersion')
    .session(session)
    .lean();
  if (!persisted) throw conflict('Sales Order no longer exists.');
  return new Map((persisted.items || []).map(line => [String(line._id), line]));
}

export async function reserveSalesOrderInventory(order, { session = null, actor = null, reason = 'Sales Order reservation' } = {}) {
  if (!order) throw conflict('Sales Order is required for stock reservation.');
  if (!session) throw Object.assign(new Error('Sales Order reservation requires an active transaction.'), { status: 500 });
  const missingByLine = order.items.map((line) => {
    refreshSalesOrderLine(line);
    return rounded(Math.max(0, numeric(line.remainingQuantity) - numeric(line.reservedQuantity)));
  });
  if (!missingByLine.some(quantity => quantity > QUANTITY_TOLERANCE)) {
    order.reservationStatus = order.items.every(line => numeric(line.remainingQuantity) <= QUANTITY_TOLERANCE)
      ? 'consumed'
      : 'reserved';
    await order.save(options(session));
    return order;
  }

  // Read committed versions inside this transaction. If withTransaction retries its
  // callback, the aborted in-memory document cannot advance the event namespace.
  const versions = await persistedLineVersions(order, session);
  const nextVersions = new Map();
  for (let index = 0; index < order.items.length; index += 1) {
    const line = order.items[index];
    const quantity = missingByLine[index];
    if (!(quantity > QUANTITY_TOLERANCE)) continue;
    if (!line.product || !line.warehouse) throw conflict(`Warehouse is required for ${line.productName || line.productCode || 'every item'}.`);
    const persistedLine = versions.get(String(line._id));
    if (!persistedLine) throw conflict('Sales Order line no longer exists.');
    const nextReservationVersion = numeric(persistedLine.reservationVersion) + 1;
    const targetReserved = rounded(numeric(line.reservedQuantity) + quantity);
    const snapshot = stableUomSnapshot(line);
    const baseQuantity = quantity * snapshot.conversionFactor;
    await applyStockMovement({
      operationKey: stockOperationKey('sales-order', order._id, line._id, 'reserve-event', nextReservationVersion),
      correlationKey: stockOperationKey('sales-order', order._id, 'reservation', nextReservationVersion),
      movementType: 'sales_reservation', phase: 'reserved',
      branch: order.branch, product: line.product, warehouse: line.warehouse, shade: line.shade || '', batch: line.batch || '',
      deltas: { availableQty: -baseQuantity, reservedQty: baseQuantity },
      enteredQuantity: quantity, ...snapshot, baseQuantity,
      sourceType: 'SalesOrder', sourceModel: 'SalesOrder', sourceId: order._id, sourceLineId: line._id,
      sourceNumber: order.orderNumber, actor: actor?._id || actor || order.createdBy, occurredAt: new Date(), reason,
      metadata: { reservationVersion: nextReservationVersion, reservedQuantity: quantity, targetReservedQuantity: targetReserved },
      guardMessage: `Insufficient available stock for ${line.productName || line.productCode || 'item'} (shade ${line.shade || 'default'}, batch ${line.batch || 'default'}).`,
    }, { session });
    nextVersions.set(String(line._id), nextReservationVersion);
  }

  order.items.forEach((line, index) => {
    line.reservedQuantity = rounded(numeric(line.reservedQuantity) + missingByLine[index]);
    if (nextVersions.has(String(line._id))) line.reservationVersion = nextVersions.get(String(line._id));
    line.allocatedQuantity = rounded(line.allocatedQuantity);
    line.pickedQuantity = rounded(line.pickedQuantity);
    line.shortQuantity = rounded(line.shortQuantity);
    line.damagedQuantity = rounded(line.damagedQuantity);
    line.dispatchedQuantity = rounded(line.dispatchedQuantity);
    refreshSalesOrderLine(line);
  });
  order.reservationStatus = 'reserved';
  order.reservedAt = order.reservedAt || new Date();
  if (order.approvalStatus === 'pending' && !order.reservationExpiresAt) {
    const ttlHours = Number(process.env.APPROVAL_RESERVATION_TTL_HOURS || 0);
    if (Number.isFinite(ttlHours) && ttlHours > 0) {
      order.reservationExpiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      order.reservationExpiryState = 'active';
      order.reservationExpiryVersion = Math.max(1, Number(order.reservationExpiryVersion || 0));
    }
  }
  order.reservationReleasedAt = undefined;
  await order.save(options(session));
  return order;
}

export async function releaseSalesOrderInventory(order, { session = null, actor = null, reason = 'Sales Order reservation release' } = {}) {
  if (!order) return null;
  if (!session) throw Object.assign(new Error('Sales Order reservation release requires an active transaction.'), { status: 500 });
  if (['released', 'consumed'].includes(order.reservationStatus)
      && order.items.every(line => numeric(line.reservedQuantity) <= QUANTITY_TOLERANCE)) return order;

  const releasableLines = order.items.filter(line => rounded(line.reservedQuantity) > QUANTITY_TOLERANCE);
  const versions = releasableLines.length ? await persistedLineVersions(order, session) : new Map();
  const nextVersions = new Map();
  let released = false;
  for (const line of releasableLines) {
    const quantity = rounded(line.reservedQuantity);
    if (!line.product || !line.warehouse) throw conflict(`Warehouse is required for ${line.productName || line.productCode || 'every item'}.`);
    const persistedLine = versions.get(String(line._id));
    if (!persistedLine) throw conflict('Sales Order line no longer exists.');
    const nextReleaseVersion = numeric(persistedLine.reservationReleaseVersion) + 1;
    const snapshot = stableUomSnapshot(line);
    const baseQuantity = quantity * snapshot.conversionFactor;
    await applyStockMovement({
      operationKey: stockOperationKey('sales-order', order._id, line._id, 'release-event', nextReleaseVersion),
      correlationKey: stockOperationKey('sales-order', order._id, 'reservation-release', nextReleaseVersion),
      movementType: 'sales_reservation_release', phase: 'released',
      branch: order.branch, product: line.product, warehouse: line.warehouse, shade: line.shade || '', batch: line.batch || '',
      deltas: { reservedQty: -baseQuantity, availableQty: baseQuantity },
      enteredQuantity: quantity, ...snapshot, baseQuantity,
      sourceType: 'SalesOrder', sourceModel: 'SalesOrder', sourceId: order._id, sourceLineId: line._id,
      sourceNumber: order.orderNumber, actor: actor?._id || actor || order.createdBy, occurredAt: new Date(), reason,
      metadata: { reservationReleaseVersion: nextReleaseVersion, releasedQuantity: quantity },
      guardMessage: `Reserved stock is inconsistent for ${line.productName || line.productCode || 'item'}; cancellation was not applied.`,
    }, { session });
    nextVersions.set(String(line._id), nextReleaseVersion);
    released = true;
  }

  for (const line of order.items) {
    if (nextVersions.has(String(line._id))) line.reservationReleaseVersion = nextVersions.get(String(line._id));
    line.reservedQuantity = 0;
    line.allocatedQuantity = 0;
    refreshSalesOrderLine(line);
  }
  order.reservationStatus = released ? 'released' : order.reservationStatus === 'consumed' ? 'consumed' : 'released';
  order.reservationReleasedAt = order.reservationReleasedAt || new Date();
  await order.save(options(session));
  return order;
}

export function salesOrderIsFullyDispatched(order) {
  return (order.items || []).every(line => numeric(line.remainingQuantity) <= QUANTITY_TOLERANCE);
}
