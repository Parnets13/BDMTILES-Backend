import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import Stock from '../models/Stock.js';
import { QUANTITY_TOLERANCE, releaseSalesOrderInventory } from './salesOrderInventory.js';

const conflict = message => Object.assign(new Error(message), { status: 409 });
const attachSession = (query, session) => (session ? query.session(session) : query);
const sessionOptions = session => (session ? { session } : {});

export async function releaseSalesOrderReservation(salesOrderId, { session = null } = {}) {
  const order = await attachSession(SalesOrder.findById(salesOrderId), session);
  if (!order) return null;

  const activeTrip = await attachSession(DispatchTrip.findOne({
    branch: order.branch,
    status: { $ne: 'cancelled' },
    'orders.salesOrder': order._id,
  }), session).lean();
  if (activeTrip) throw conflict(`Cancel dispatch trip ${activeTrip.tripNumber} before cancelling this sales order.`);

  const hasLineReservation = order.items.some(item => Number(item.reservedQuantity || 0) > QUANTITY_TOLERANCE);
  if (hasLineReservation || !['none', undefined, null].includes(order.reservationStatus)) {
    await releaseSalesOrderInventory(order, { session });
  } else {
    // Compatibility path for pre-lifecycle pick lists that owned their reservation.
    const legacyPickLists = await attachSession(PickList.find({
      branch: order.branch,
      salesOrder: order._id,
      stockConsumedAt: null,
      stockReserved: true,
      reservationState: { $nin: ['released', 'consumed'] },
    }), session);
    const requirements = new Map();
    for (const pickList of legacyPickLists) {
      const adjusted = ['adjusted', 'consuming'].includes(pickList.reservationState)
        || ['picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch'].includes(pickList.status);
      for (const item of pickList.items) {
        const quantity = Number(adjusted ? item.pickedQty : item.requestedQty);
        if (!(quantity > QUANTITY_TOLERANCE)) continue;
        const key = [item.product, item.warehouse, item.shade || '', item.batch || ''].map(String).join('|');
        const existing = requirements.get(key);
        if (existing) existing.quantity += quantity;
        else requirements.set(key, {
          branch: order.branch,
          product: item.product,
          warehouse: item.warehouse,
          shade: item.shade || '',
          batch: item.batch || '',
          productName: item.productName || item.productCode || 'item',
          quantity,
        });
      }
    }
    for (const requirement of requirements.values()) {
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
        { new: true, ...sessionOptions(session) }
      );
      if (!stock) throw conflict(`Reserved stock is inconsistent for ${requirement.productName}; cancellation was not applied.`);
    }
    order.reservationStatus = 'released';
    order.reservationReleasedAt = order.reservationReleasedAt || new Date();
    await order.save(sessionOptions(session));
  }

  await PickList.updateMany(
    { branch: order.branch, salesOrder: order._id, stockConsumedAt: null },
    {
      $set: {
        status: 'cancelled', stockReserved: false, reservationState: 'released',
        reservationReleasedAt: new Date(), cancellationProcessing: false,
      },
      $unset: { dispatchTrip: 1, tripClaimedAt: 1 },
    },
    sessionOptions(session)
  );
  return order;
}

export default releaseSalesOrderReservation;
