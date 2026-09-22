import mongoose from 'mongoose';
import Quotation from '../models/Quotation.js';
import { HOLD_TOLERANCE, releaseQuotationHold } from './quotationHoldService.js';

/**
 * Releases quotation stock holds whose TTL has lapsed.
 *
 * A hold takes stock out of Stock.availableQty. Without a sweeper, a quotation
 * nobody ever converts would keep that stock unsellable forever, and anyone could
 * freeze a warehouse simply by raising quotations.
 *
 * Expiry is deliberately gentle: the quotation keeps its status and its FIFO
 * position and is never cancelled. It only loses the guarantee, so it falls back
 * to competing for stock like any other queued quotation.
 *
 * Kept separate from reservationExpiryService rather than bolted onto it: that
 * sweeper's candidate filter is an explicit two-case $or over Sales Orders, and
 * widening it to cover a different collection would make both harder to reason
 * about.
 */

/** Holds this sweeper is allowed to release. */
const expirableHoldFilter = now => ({
  holdStatus: { $in: ['held', 'partial'] },
  holdExpiresAt: { $lte: now },
  holdExpiryState: { $nin: ['expired', 'released'] },
});

export async function releaseExpiredQuotationHolds({
  branch,
  actor,
  now = new Date(),
  limit = 100,
  shouldContinue = () => true,
} = {}) {
  const batchLimit = Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 100));
  const due = await Quotation.find({
    ...(branch ? { branch } : {}),
    ...expirableHoldFilter(now),
  })
    .sort({ holdExpiresAt: 1, _id: 1 })
    .limit(batchLimit)
    .select('_id')
    .lean();

  const summary = {
    examined: due.length,
    released: 0,
    skippedNoHold: 0,
    conflicts: 0,
    quotationIds: [],
    aborted: false,
  };

  for (const candidate of due) {
    if (!shouldContinue()) { summary.aborted = true; break; }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Re-read under the same filter inside the transaction: the hold may have
        // been consumed by a conversion or released manually in the meantime.
        const quotation = await Quotation.findOne({
          _id: candidate._id,
          ...expirableHoldFilter(now),
        }).session(session);
        if (!quotation) return;

        const stillHolds = (quotation.items || [])
          .some(item => Number(item.holdQuantity || 0) > HOLD_TOLERANCE);
        if (!stillHolds) {
          // Nothing physically held; just normalise the flags so it is not picked
          // up again on every run.
          summary.skippedNoHold += 1;
          quotation.holdStatus = 'expired';
          quotation.holdExpiryState = 'expired';
          quotation.holdExpiredAt = now;
          quotation.holdExpiresAt = undefined;
          quotation.holdExpiryReason = 'Hold expired with no remaining held quantity';
          await quotation.save({ session });
          return;
        }

        await releaseQuotationHold(quotation, {
          session,
          actor,
          reason: 'Quotation stock hold expired',
          expiryState: 'expired',
        });
        summary.released += 1;
        summary.quotationIds.push(String(quotation._id));
      });
    } catch (error) {
      // A 409 here means the bucket changed under us; the next run retries.
      summary.conflicts += 1;
      console.error(`[quotation-hold-expiry] ${candidate._id} failed: ${error.message}`);
    } finally {
      await session.endSession();
    }
  }

  return summary;
}

export default releaseExpiredQuotationHolds;
