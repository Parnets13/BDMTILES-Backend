import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import { applyStockMovement, stockOperationKey } from '../services/stockMovementService.js';
import { QUANTITY_TOLERANCE, releaseSalesOrderInventory } from './salesOrderInventory.js';
import { stableUomSnapshot } from '../services/stockUomService.js';

const conflict = message => Object.assign(new Error(message), { status: 409 });
const attachSession = (query, session) => (session ? query.session(session) : query);
const sessionOptions = session => (session ? { session } : {});

export async function releaseSalesOrderReservation(salesOrderId, { session = null, actor = null } = {}) {
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
    await releaseSalesOrderInventory(order, { session, actor });
  } else {
    // Compatibility path for pre-lifecycle pick lists that owned their reservation.
    const legacyPickLists = await attachSession(PickList.find({
      branch: order.branch,
      salesOrder: order._id,
      stockConsumedAt: null,
      stockReserved: true,
      reservationState: { $nin: ['released', 'consumed'] },
    }), session);
    for (const pickList of legacyPickLists) {
      const adjusted = ['adjusted', 'consuming'].includes(pickList.reservationState)
        || ['picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch'].includes(pickList.status);
      for (const item of pickList.items) {
        const quantity = Number(adjusted ? item.pickedQty : item.requestedQty);
        if (!(quantity > QUANTITY_TOLERANCE)) continue;
        const snapshot = stableUomSnapshot(item);
        const baseQuantity = quantity * snapshot.conversionFactor;
        await applyStockMovement({
          operationKey: stockOperationKey('legacy-pick-list', pickList._id, item._id, 'reservation-release'),
          correlationKey: stockOperationKey('sales-order', order._id, 'reservation-release'),
          movementType: 'sales_reservation_release', phase: 'released',
          branch: order.branch, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '',
          deltas: { reservedQty: -baseQuantity, availableQty: baseQuantity },
          enteredQuantity: quantity, ...snapshot, baseQuantity,
          sourceType: 'PickList', sourceModel: 'PickList', sourceId: pickList._id, sourceLineId: item._id,
          sourceNumber: pickList.pickListNumber, actor: actor || order.createdBy, occurredAt: new Date(),
          reason: 'Legacy PickList reservation release',
          guardMessage: `Reserved stock is inconsistent for ${item.productName || item.productCode || 'item'}; cancellation was not applied.`,
        }, { session });
      }
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
