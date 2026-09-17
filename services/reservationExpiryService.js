import mongoose from 'mongoose';
import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import { releaseSalesOrderInventory, QUANTITY_TOLERANCE } from '../utils/salesOrderInventory.js';

const unsafePickStatuses = ['in_progress', 'picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch', 'loaded'];

export async function releaseExpiredApprovalReservations({ branch, actor, now = new Date(), limit = 100, shouldContinue = () => true } = {}) {
  const batchLimit = Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 100));
  const due = await SalesOrder.find({
    ...(branch ? { branch } : {}),
    approvalStatus: 'pending',
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
          approvalStatus: 'pending',
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
        if (order.items.some(line => Number(line.reservedQuantity || 0) > QUANTITY_TOLERANCE)) {
          await releaseSalesOrderInventory(order, { session, actor, reason: 'Pending approval reservation expired' });
        }
        order.reservationExpiryState = 'expired';
        order.reservationExpiredAt = now;
        order.reservationExpiryReason = 'Pending approval reservation expired without an in-progress PickList owner';
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
