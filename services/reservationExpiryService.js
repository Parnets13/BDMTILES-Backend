import mongoose from 'mongoose';
import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import { releaseSalesOrderInventory, QUANTITY_TOLERANCE } from '../utils/salesOrderInventory.js';

const unsafePickStatuses = ['in_progress', 'picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch', 'loaded'];

/**
 * Which reservations this sweeper is allowed to release.
 *
 * Two intended cases, spelled out rather than inferred from the presence of an
 * expiry date, so an order that picked one up for some other reason is never
 * swept by accident:
 *   - orders held while they wait for pricing approval (the original behaviour)
 *   - unpaid online orders, which reserve stock the moment the customer checks
 *     out and would otherwise hold it forever, since nothing is paid up front
 */
const EXPIRABLE_RESERVATIONS = [
  { approvalStatus: 'pending' },
  { orderType: 'online', paymentStatus: 'pending', status: 'confirmed' },
];

const isAbandonedOnlineOrder = order =>
  order.orderType === 'online' && order.paymentStatus === 'pending' && order.status === 'confirmed';

export async function releaseExpiredApprovalReservations({ branch, actor, now = new Date(), limit = 100, shouldContinue = () => true } = {}) {
  const batchLimit = Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 100));
  const due = await SalesOrder.find({
    ...(branch ? { branch } : {}),
    $or: EXPIRABLE_RESERVATIONS,
    reservationStatus: { $in: ['reserved', 'partial'] },
    reservationExpiresAt: { $lte: now },
    reservationExpiryState: { $nin: ['expired', 'released'] },
  }).sort({ reservationExpiresAt: 1, _id: 1 }).limit(batchLimit).select('_id').lean();
  const summary = { examined: due.length, released: 0, skippedOwnedPick: 0, conflicts: 0, orderIds: [], aborted: false };
  for (const candidate of due) {
    if (!shouldContinue()) { summary.aborted = true; break; }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const order = await SalesOrder.findOne({
          _id: candidate._id,
          $or: EXPIRABLE_RESERVATIONS,
          reservationStatus: { $in: ['reserved', 'partial'] },
          reservationExpiresAt: { $lte: now },
          reservationExpiryState: { $nin: ['expired', 'released'] },
        }).session(session);
        if (!order) return;
        const owned = await PickList.exists({
          branch: order.branch, salesOrder: order._id, stockConsumedAt: null,
          status: { $in: unsafePickStatuses },
        }).session(session);
        if (owned) { summary.skippedOwnedPick += 1; return; }
        await PickList.updateMany(
          { branch: order.branch, salesOrder: order._id, stockConsumedAt: null, status: { $in: ['generated', 'assigned'] } },
          { $set: { status: 'cancelled', stockReserved: false, reservationState: 'released', reservationReleasedAt: now, cancellationProcessing: false }, $unset: { dispatchTrip: 1, tripClaimedAt: 1 } },
          { session }
        );
        const abandonedOnline = isAbandonedOnlineOrder(order);
        const releaseReason = abandonedOnline
          ? 'Unpaid online order reservation expired'
          : 'Pending approval reservation expired';
        if (order.items.some(line => Number(line.reservedQuantity || 0) > QUANTITY_TOLERANCE)) {
          await releaseSalesOrderInventory(order, { session, actor, reason: releaseReason });
        }
        order.reservationExpiryState = 'expired';
        order.reservationExpiredAt = now;
        order.reservationExpiryReason = abandonedOnline
          ? 'Unpaid online order was not confirmed before its reservation expired'
          : 'Pending approval reservation expired without an in-progress PickList owner';
        // An online order whose stock has gone back on the shelf must not stay
        // "confirmed" — the warehouse would see an order it can no longer fulfil.
        // Cancelling it says plainly what happened and lets the customer reorder.
        if (abandonedOnline) {
          order.status = 'cancelled';
          order.remarks = [order.remarks, 'Cancelled automatically: not confirmed before the stock reservation expired.']
            .filter(Boolean).join(' ');
          summary.cancelledOnlineOrders = (summary.cancelledOnlineOrders || 0) + 1;
        }
        await order.save({ session });
        summary.released += 1;
        summary.orderIds.push(String(order._id));
      });
    } catch (error) {
      summary.conflicts += 1;
      summary.lastError = error.message;
    } finally { await session.endSession(); }
  }
  return summary;
}

export default releaseExpiredApprovalReservations;
