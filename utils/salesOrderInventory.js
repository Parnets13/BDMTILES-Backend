import Stock from '../models/Stock.js';

export const QUANTITY_TOLERANCE = 0.0001;

const conflict = message => Object.assign(new Error(message), { status: 409 });
const options = session => (session ? { session } : {});
const numeric = value => Number(value || 0);
const rounded = value => Math.round((numeric(value) + Number.EPSILON) * 1e6) / 1e6;

export function refreshSalesOrderLine(line) {
  const ordered = numeric(line.quantity);
  const dispatched = Math.min(ordered, numeric(line.dispatchedQuantity));
  const reserved = Math.max(0, numeric(line.reservedQuantity));
  line.fulfilledQuantity = rounded(dispatched);
  line.remainingQuantity = rounded(Math.max(0, ordered - dispatched));
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

export async function reserveSalesOrderInventory(order, { session = null } = {}) {
  if (!order) throw conflict('Sales Order is required for stock reservation.');
  const missingByLine = order.items.map((line) => {
    refreshSalesOrderLine(line);
    return rounded(Math.max(0, numeric(line.remainingQuantity) - numeric(line.reservedQuantity)));
  });
  const missingById = new Map(order.items.map((line, index) => [String(line._id), missingByLine[index]]));
  const requirements = aggregate(order.items, line => missingById.get(String(line._id)), order.branch);
  if (!requirements.length) {
    order.reservationStatus = order.items.every(line => numeric(line.remainingQuantity) <= QUANTITY_TOLERANCE)
      ? 'consumed'
      : 'reserved';
    await order.save(options(session));
    return order;
  }

  for (const requirement of requirements) {
    const stock = await Stock.findOneAndUpdate(
      {
        branch: requirement.branch,
        product: requirement.product,
        warehouse: requirement.warehouse,
        shade: requirement.shade,
        batch: requirement.batch,
        availableQty: { $gte: requirement.quantity },
      },
      { $inc: { availableQty: -requirement.quantity, reservedQty: requirement.quantity } },
      { new: true, ...options(session) }
    );
    if (!stock) {
      throw conflict(`Insufficient available stock for ${requirement.productName} (shade ${requirement.shade || 'default'}, batch ${requirement.batch || 'default'}).`);
    }
  }

  order.items.forEach((line, index) => {
    line.reservedQuantity = rounded(numeric(line.reservedQuantity) + missingByLine[index]);
    line.allocatedQuantity = rounded(line.allocatedQuantity);
    line.pickedQuantity = rounded(line.pickedQuantity);
    line.shortQuantity = rounded(line.shortQuantity);
    line.damagedQuantity = rounded(line.damagedQuantity);
    line.dispatchedQuantity = rounded(line.dispatchedQuantity);
    refreshSalesOrderLine(line);
  });
  order.reservationStatus = 'reserved';
  order.reservedAt = order.reservedAt || new Date();
  order.reservationReleasedAt = undefined;
  await order.save(options(session));
  return order;
}

export async function releaseSalesOrderInventory(order, { session = null } = {}) {
  if (!order) return null;
  if (['released', 'consumed'].includes(order.reservationStatus)
      && order.items.every(line => numeric(line.reservedQuantity) <= QUANTITY_TOLERANCE)) return order;

  const requirements = aggregate(order.items, line => line.reservedQuantity, order.branch);
  for (const requirement of requirements) {
    const stock = await Stock.findOneAndUpdate(
      {
        branch: requirement.branch,
        product: requirement.product,
        warehouse: requirement.warehouse,
        shade: requirement.shade,
        batch: requirement.batch,
        reservedQty: { $gte: requirement.quantity },
      },
      { $inc: { reservedQty: -requirement.quantity, availableQty: requirement.quantity } },
      { new: true, ...options(session) }
    );
    if (!stock) throw conflict(`Reserved stock is inconsistent for ${requirement.productName}; cancellation was not applied.`);
  }

  for (const line of order.items) {
    line.reservedQuantity = 0;
    line.allocatedQuantity = 0;
    refreshSalesOrderLine(line);
  }
  order.reservationStatus = requirements.length ? 'released' : order.reservationStatus === 'consumed' ? 'consumed' : 'released';
  order.reservationReleasedAt = order.reservationReleasedAt || new Date();
  await order.save(options(session));
  return order;
}

export function salesOrderIsFullyDispatched(order) {
  return (order.items || []).every(line => numeric(line.remainingQuantity) <= QUANTITY_TOLERANCE);
}
