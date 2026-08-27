import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import Stock from '../models/Stock.js';

const conflict = message => {
  const error = new Error(message);
  error.status = 409;
  return error;
};

const attachSession = (query, session) => session ? query.session(session) : query;
const sessionOptions = session => session ? { session } : {};

export async function releaseSalesOrderReservation(salesOrderId, { session = null } = {}) {
  const current = await attachSession(
    PickList.findOne({ salesOrder: salesOrderId, stockConsumedAt: null }),
    session
  );
  if (!current || current.status === 'cancelled') return current;

  const activeTrip = await attachSession(DispatchTrip.findOne({
    status: { $ne: 'cancelled' },
    $or: [{ 'orders.pickList': current._id }, { 'orders.salesOrder': salesOrderId }],
  }), session).lean();
  if (activeTrip) throw conflict(`Cancel dispatch trip ${activeTrip.tripNumber} before cancelling this sales order.`);

  const pickList = await PickList.findOneAndUpdate(
    { _id: current._id, dispatchTrip: null, stockConsumedAt: null, cancellationProcessing: { $ne: true }, reservationState: { $nin: ['released', 'consumed'] } },
    { $set: { cancellationProcessing: true } },
    { new: true, ...sessionOptions(session) }
  );
  if (!pickList) throw conflict('Pick-list reservation is already claimed or being changed. Refresh before retrying cancellation.');

  if (!pickList.stockReserved) {
    pickList.status = 'cancelled';
    pickList.reservationState = 'released';
    pickList.reservationReleasedAt = new Date();
    pickList.cancellationProcessing = false;
    await pickList.save(sessionOptions(session));
    return pickList;
  }

  const adjusted = ['adjusted', 'consuming'].includes(pickList.reservationState) || ['picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch'].includes(pickList.status);
  const requirements = new Map();
  for (const item of pickList.items) {
    const quantity = Number(adjusted ? item.pickedQty : item.requestedQty);
    if (!(quantity > 0)) continue;
    const key = [item.product, item.warehouse, item.shade || '', item.batch || ''].map(String).join('|');
    const existing = requirements.get(key);
    if (existing) existing.quantity += quantity;
    else requirements.set(key, {
      product: item.product,
      warehouse: item.warehouse,
      shade: item.shade || '',
      batch: item.batch || '',
      productName: item.productName || item.productCode || 'item',
      quantity,
    });
  }

  const released = [];
  try {
    for (const requirement of requirements.values()) {
      const stock = await Stock.findOneAndUpdate(
        {
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
      released.push(requirement);
    }

    pickList.status = 'cancelled';
    pickList.stockReserved = false;
    pickList.reservationState = 'released';
    pickList.reservationReleasedAt = new Date();
    pickList.cancellationProcessing = false;
    pickList.dispatchTrip = undefined;
    pickList.dispatchTripNumber = '';
    pickList.tripClaimedAt = undefined;
    await pickList.save(sessionOptions(session));
    return pickList;
  } catch (error) {
    if (session) throw error;
    for (const requirement of [...released].reverse()) {
      await Stock.updateOne(
        { product: requirement.product, warehouse: requirement.warehouse, shade: requirement.shade, batch: requirement.batch },
        { $inc: { reservedQty: requirement.quantity, availableQty: -requirement.quantity } }
      );
    }
    await PickList.updateOne({ _id: pickList._id }, { $set: { cancellationProcessing: false } });
    throw error;
  }
}

export default releaseSalesOrderReservation;
