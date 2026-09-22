import DealerOrderRequest from '../models/DealerOrderRequest.js';
import Quotation from '../models/Quotation.js';
import { buildShortfallLines } from './dealerOrderProcessingService.js';
import { createPendingStockChild } from './quotationSplitService.js';

/**
 * The shortfall conversation.
 *
 * After processing, the part of a dealer's request that could not be reserved is
 * put to the dealer as a question: "we can get you this much, expected by this
 * date — still want it?" They may accept, change the quantity, or decline.
 *
 * Two invariants run through everything here:
 *
 *   1. A round only ever talks about the shortfall. The Sales Order created for
 *      the available part is already reserved and is never reopened, whatever the
 *      dealer answers. So no function in this file touches stock.
 *   2. A quantity the dealer changed is not agreed until staff have re-confirmed
 *      the availability date for it. Going from 10 to 15 boxes can easily change
 *      "next Tuesday" into "no idea", so a changed round lands in
 *      'needs_reconfirmation' and waits for a fresh offer rather than settling.
 */

const SHORTFALL_TOLERANCE = 0.0001;
const shortfallError = (status, message, code, details) => Object.assign(
  new Error(message),
  { status, ...(code ? { code } : {}), ...(details ? { details } : {}) },
);
const idOf = value => String(value?._id || value || '');
const qty = value => Math.round((Number(value || 0) + Number.EPSILON) * 1e6) / 1e6;

export const OPEN_SHORTFALL_STATUSES = new Set(['awaiting_dealer', 'needs_reconfirmation']);

/** The round currently on the table, or null when there is no open conversation. */
export function currentRound(request) {
  const rounds = request?.shortfallRounds || [];
  if (!rounds.length) return null;
  const last = rounds[rounds.length - 1];
  return last.outcome === 'superseded' ? null : last;
}

/**
 * The lines a new round should ask about, derived from how the dealer answered the
 * last one.
 *
 * A changed quantity becomes the new ask. A rejected line drops out of the
 * conversation entirely — the dealer said no, so there is nothing left to agree.
 * An accepted line is carried forward unchanged so the dealer is not asked to
 * confirm the same thing twice, but it still needs a date from staff because the
 * whole round is being re-quoted together.
 */
export function carryForwardLines(round) {
  return (round?.lines || [])
    .filter(line => line.dealerResponse !== 'rejected')
    .map((line) => {
      const asked = line.dealerResponse === 'changed' && Number.isFinite(Number(line.dealerQty))
        ? qty(line.dealerQty)
        : qty(line.shortfallQty);
      return {
        product: line.product,
        productCode: line.productCode || '',
        productName: line.productName || '',
        productImage: line.productImage || '',
        unit: line.unit || 'Box',
        requestedQty: qty(line.requestedQty),
        allocatedQty: qty(line.processedQty),
        availableQty: qty(line.processedQty),
        shortfallQty: asked,
      };
    })
    .filter(line => line.shortfallQty > SHORTFALL_TOLERANCE);
}

/**
 * Puts a new offer to the dealer, superseding the one on the table.
 *
 * Used for every round after the first: staff re-confirming a date after the
 * dealer changed a quantity, and staff correcting a date on an offer the dealer
 * has not answered yet.
 */
export async function openNextRound({
  requestId,
  branchId,
  actor,
  shortfallInput = [],
  offerRemark = '',
  session,
}) {
  if (!session) throw shortfallError(500, 'Opening a shortfall round requires an open transaction session.');

  const request = await DealerOrderRequest.findOne({ _id: requestId, branch: branchId }).session(session);
  if (!request) throw shortfallError(404, 'Dealer order request not found.');
  if (!request.processedAt) {
    throw shortfallError(409, 'This request has not been stock-processed yet, so there is no shortfall to offer.');
  }
  if (!OPEN_SHORTFALL_STATUSES.has(request.shortfallStatus)) {
    throw shortfallError(
      409,
      `There is no open shortfall on this request; it is "${request.shortfallStatus}".`,
      'SHORTFALL_NOT_OPEN',
    );
  }
  const round = currentRound(request);
  if (!round) throw shortfallError(409, 'This request has no shortfall round to replace.');

  const lines = carryForwardLines(round);
  if (!lines.length) {
    throw shortfallError(409, 'The dealer declined every short line, so there is nothing left to offer. Settle the shortfall instead.');
  }
  const nextLines = buildShortfallLines({ lines, shortfallInput });
  const now = new Date();
  const roundNumber = request.shortfallRounds.length + 1;

  // Retiring the old round and appending the new one has to be two updates:
  // MongoDB refuses to $set a path inside an array and $push to that same array in
  // one statement. They share this transaction, so the pair is still atomic, and
  // each one is guarded on the round count so two staff members cannot both open
  // "round 3".
  const index = request.shortfallRounds.length - 1;
  const retired = await DealerOrderRequest.findOneAndUpdate(
    {
      _id: request._id,
      branch: branchId,
      revision: request.revision,
      shortfallStatus: request.shortfallStatus,
      [`shortfallRounds.${index}.outcome`]: round.outcome,
      shortfallRounds: { $size: request.shortfallRounds.length },
    },
    {
      $set: {
        [`shortfallRounds.${index}.outcome`]: 'superseded',
        [`shortfallRounds.${index}.settledAt`]: now,
        [`shortfallRounds.${index}.settledBy`]: actor._id,
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session },
  );
  if (!retired) throw shortfallError(409, 'The shortfall changed while a new offer was being prepared. Refresh and retry.');

  const updated = await DealerOrderRequest.findOneAndUpdate(
    {
      _id: request._id,
      branch: branchId,
      revision: retired.revision,
      shortfallRounds: { $size: request.shortfallRounds.length },
    },
    {
      $set: { shortfallStatus: 'awaiting_dealer' },
      $push: {
        shortfallRounds: {
          round: roundNumber,
          offeredAt: now,
          offeredBy: actor._id,
          offeredByName: actor.name || '',
          offerRemark: String(offerRemark || '').trim(),
          lines: nextLines,
          outcome: 'pending',
        },
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session },
  );
  if (!updated) throw shortfallError(409, 'The shortfall changed while a new offer was being prepared. Refresh and retry.');

  return { request: updated, round: updated.shortfallRounds[updated.shortfallRounds.length - 1], lines };
}

const DEALER_RESPONSES = new Set(['accepted', 'changed', 'rejected']);
const MAX_DEALER_QTY = 1000000;

/**
 * Applies the dealer's answers to a round's lines and decides the round outcome.
 *
 * Pure so the rules that decide whether a round is agreed or goes back to staff can
 * be read and tested on their own:
 *   every line declined      -> 'rejected'
 *   any quantity increased   -> 'changed'  (a bigger ask can move the date, so a
 *                                           person has to re-confirm it)
 *   otherwise                -> 'accepted' (a decrease never makes a date harder
 *                                           to keep, so it settles immediately)
 *
 * settledQty is only written on a settled round. A round going back for a new date
 * has nothing agreed in it yet, and writing a quantity there would let a later step
 * quote something the branch never confirmed.
 */
export function resolveDealerAnswers(roundLines, responses, at = new Date()) {
  if (!Array.isArray(responses)) throw shortfallError(422, 'lines must be an array.');
  const byProduct = new Map();
  for (const entry of responses) {
    const key = idOf(entry.product);
    if (!key) throw shortfallError(422, 'Each answer needs a product.');
    if (byProduct.has(key)) throw shortfallError(422, 'Each product may be answered only once.');
    byProduct.set(key, entry);
  }

  const answered = (roundLines || []).map((line) => {
    const entry = byProduct.get(idOf(line.product));
    if (!entry) throw shortfallError(422, `Please answer for ${line.productName || 'every item'}.`);
    const response = String(entry.response || '').trim();
    if (!DEALER_RESPONSES.has(response)) {
      throw shortfallError(422, `The answer for ${line.productName || 'an item'} must be accepted, changed, or rejected.`);
    }
    const remark = String(entry.remark || '').trim();
    if (remark.length > 500) throw shortfallError(422, 'A remark cannot exceed 500 characters.');

    let dealerResponse = response;
    let dealerQty = null;
    if (response === 'changed') {
      dealerQty = qty(entry.quantity);
      if (!Number.isFinite(dealerQty) || dealerQty <= 0) {
        throw shortfallError(422, `Enter the quantity you want for ${line.productName || 'the changed item'}.`);
      }
      if (dealerQty > MAX_DEALER_QTY) throw shortfallError(422, 'That quantity is too large.');
      // Asking for exactly what was offered is an acceptance, not a change, and
      // recording it as a change would pointlessly send the round back to staff.
      if (Math.abs(dealerQty - qty(line.shortfallQty)) <= SHORTFALL_TOLERANCE) {
        dealerResponse = 'accepted';
        dealerQty = null;
      }
    }
    return { line, dealerResponse, dealerQty, remark };
  });

  if (!answered.length) throw shortfallError(409, 'This offer has no lines to answer.');
  const increased = answered.some(entry =>
    entry.dealerResponse === 'changed' && entry.dealerQty > qty(entry.line.shortfallQty) + SHORTFALL_TOLERANCE);
  const allRejected = answered.every(entry => entry.dealerResponse === 'rejected');
  const outcome = increased ? 'changed' : allRejected ? 'rejected' : 'accepted';
  const settled = outcome === 'accepted' || outcome === 'rejected';

  const lines = answered.map(({ line, dealerResponse, dealerQty, remark }) => {
    const plain = line.toObject ? line.toObject() : { ...line };
    return {
      ...plain,
      dealerResponse,
      dealerQty,
      dealerRemark: remark,
      respondedAt: at,
      settledQty: !settled || dealerResponse === 'rejected'
        ? 0
        : dealerResponse === 'changed' ? dealerQty : qty(line.shortfallQty),
    };
  });
  return { lines, outcome, settled };
}

/**
 * Records the dealer's answer to the open round.
 *
 * Scoped to the dealer's own request and to a specific round number, so an answer
 * to an offer that has since been revised is refused instead of being applied to
 * the wrong numbers.
 *
 * The outcome decides what happens next:
 *   every line declined            -> 'rejected', the conversation is over
 *   any quantity increased         -> 'changed', staff must re-confirm the date
 *   otherwise                      -> 'accepted', ready to become a quotation
 *
 * An increase is the only change that needs a person to look again: asking for more
 * can turn "next Tuesday" into "no idea", while asking for less never can. A
 * decrease is therefore settled on the spot at the smaller quantity.
 */
export async function recordDealerResponse({
  requestId,
  dealerId,
  round: roundNumber,
  responses = [],
  dealerRemark = '',
  session,
}) {
  if (!session) throw shortfallError(500, 'Recording a shortfall response requires an open transaction session.');

  const request = await DealerOrderRequest.findOne({ _id: requestId, dealer: dealerId }).session(session);
  if (!request) throw shortfallError(404, 'Order request not found.');
  if (request.shortfallStatus !== 'awaiting_dealer') {
    throw shortfallError(
      409,
      request.shortfallStatus === 'needs_reconfirmation'
        ? 'Your changes are with the branch. You will be asked again once they confirm the new date.'
        : 'There is nothing waiting for your response on this request.',
      'SHORTFALL_NOT_AWAITING_DEALER',
    );
  }
  const round = currentRound(request);
  if (!round) throw shortfallError(409, 'There is no open offer on this request.', 'SHORTFALL_NOT_OPEN');
  if (round.outcome !== 'pending') {
    throw shortfallError(409, 'This offer has already been answered.', 'SHORTFALL_ALREADY_ANSWERED');
  }
  if (Number(roundNumber) !== Number(round.round)) {
    throw shortfallError(
      409,
      'This offer has been updated. Open the request again to see the current one.',
      'SHORTFALL_ROUND_STALE',
      { currentRound: round.round },
    );
  }

  const now = new Date();
  const { lines: nextLines, outcome } = resolveDealerAnswers(round.lines, responses, now);
  const index = request.shortfallRounds.length - 1;

  const updated = await DealerOrderRequest.findOneAndUpdate(
    {
      _id: request._id,
      dealer: dealerId,
      revision: request.revision,
      shortfallStatus: 'awaiting_dealer',
      [`shortfallRounds.${index}.round`]: round.round,
      [`shortfallRounds.${index}.outcome`]: 'pending',
    },
    {
      $set: {
        [`shortfallRounds.${index}.lines`]: nextLines,
        [`shortfallRounds.${index}.outcome`]: outcome,
        [`shortfallRounds.${index}.respondedAt`]: now,
        [`shortfallRounds.${index}.dealerRemark`]: String(dealerRemark || '').trim().slice(0, 1000),
        shortfallStatus: outcome === 'changed' ? 'needs_reconfirmation' : outcome,
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session },
  );
  if (!updated) throw shortfallError(409, 'This offer changed while you were answering. Open the request again.');

  // A settled answer closes the loop immediately rather than sitting in a queue
  // waiting for someone to press another button: the dealer said yes, so the
  // pending-stock quotation is raised here and now, for exactly what they agreed.
  // A 'changed' round settles nothing and goes back to staff instead.
  const settled = outcome === 'accepted' || outcome === 'rejected';
  const result = settled
    ? await settleShortfall({ request: updated, session })
    : { request: updated, pendingStockQuotation: null };

  return { request: result.request, round: result.request.shortfallRounds[index], outcome };
}

/**
 * Closes the shortfall conversation and, if anything was agreed, raises the
 * pending-stock quotation for exactly that quantity.
 *
 * This is the only place a pending-stock quotation is born for a dealer order. The
 * split deliberately left the short quantity without one, because until the dealer
 * answers there is nothing to put on paper. By the time we get here the quantity is
 * settled, so the quotation is created once, at the right figure.
 *
 * Touches no stock whatsoever. The Sales Order raised earlier for the available
 * quantity is not read, let alone modified — keeping the two apart is the whole
 * reason the shortfall is settled separately.
 */
export async function settleShortfall({ request, session }) {
  if (!session) throw shortfallError(500, 'Settling a shortfall requires an open transaction session.');
  const round = currentRound(request);
  if (!round) throw shortfallError(409, 'This request has no shortfall round to settle.');
  if (!['accepted', 'rejected'].includes(round.outcome)) {
    throw shortfallError(409, `A shortfall round with outcome "${round.outcome}" cannot be settled.`);
  }

  const settledByProduct = new Map();
  for (const line of round.lines || []) {
    const amount = qty(line.settledQty);
    if (amount > SHORTFALL_TOLERANCE) settledByProduct.set(idOf(line.product), amount);
  }

  let pendingStockQuotation = null;
  if (settledByProduct.size) {
    // The split parent is the immutable record of the full original ask, and the
    // only place the agreed lines can be priced from.
    const parent = await Quotation.findOne({
      _id: request.sourceQuotation,
      branch: request.branch,
    }).session(session);
    if (!parent) throw shortfallError(409, 'The request quotation could not be found.');
    if (parent.status !== 'split') {
      throw shortfallError(
        409,
        `This request's quotation is "${parent.status}", so a pending-stock quotation cannot be raised against it.`,
        'QUOTATION_NOT_SPLIT',
      );
    }
    pendingStockQuotation = await createPendingStockChild(parent, settledByProduct, {
      session,
      actor: request.processedBy,
      reason: `Dealer confirmed the pending quantity on request ${request.requestNumber}`,
    });
  }

  const hasOrder = (request.outcomes || []).some(outcome => outcome.salesOrder);
  const stillWaiting = Boolean(pendingStockQuotation);
  const now = new Date();
  const index = request.shortfallRounds.length - 1;

  // The request's status has to say what is actually still coming:
  //   an order was raised and something is still queued  -> partially processed
  //   an order was raised and nothing is left            -> done
  //   nothing was reserved but a quantity is queued      -> waiting on stock
  //   nothing was reserved and the dealer walked away    -> withdrawn
  const status = hasOrder
    ? (stillWaiting ? 'partially_processed' : 'quotation_linked')
    : (stillWaiting ? 'awaiting_stock' : 'cancelled');

  const updated = await DealerOrderRequest.findOneAndUpdate(
    {
      _id: request._id,
      branch: request.branch,
      revision: request.revision,
      shortfallStatus: request.shortfallStatus,
    },
    {
      $set: {
        status,
        shortfallStatus: 'closed',
        shortfallSettledAt: now,
        [`shortfallRounds.${index}.settledAt`]: now,
        ...(status === 'cancelled' ? {
          cancelledBy: request.dealer,
          cancelledAt: now,
          cancellationReason: 'Dealer declined the quantity that was not available.',
        } : {}),
        ...(pendingStockQuotation ? { pendingStockQuotation: pendingStockQuotation._id } : {}),
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true, session },
  );
  if (!updated) throw shortfallError(409, 'The request changed while the shortfall was being settled. Refresh and retry.');

  return { request: updated, pendingStockQuotation };
}

/** Flattens the open round into the shape the apps and the admin table render. */
export function shortfallDto(request) {
  const round = currentRound(request);
  return {
    status: request?.shortfallStatus || 'none',
    settledAt: request?.shortfallSettledAt || null,
    totalRounds: (request?.shortfallRounds || []).length,
    round: round ? {
      round: round.round,
      offeredAt: round.offeredAt,
      offeredByName: round.offeredByName || '',
      offerRemark: round.offerRemark || '',
      outcome: round.outcome,
      respondedAt: round.respondedAt || null,
      dealerRemark: round.dealerRemark || '',
      lines: (round.lines || []).map(line => ({
        product: idOf(line.product),
        productCode: line.productCode || '',
        productName: line.productName || '',
        productImage: line.productImage || '',
        unit: line.unit || 'Box',
        requestedQty: qty(line.requestedQty),
        processedQty: qty(line.processedQty),
        shortfallQty: qty(line.shortfallQty),
        expectedDate: line.expectedDate || null,
        noEta: line.noEta === true,
        staffRemark: line.staffRemark || '',
        dealerResponse: line.dealerResponse || 'pending',
        dealerQty: line.dealerQty === null || line.dealerQty === undefined ? null : qty(line.dealerQty),
        dealerRemark: line.dealerRemark || '',
        respondedAt: line.respondedAt || null,
        settledQty: qty(line.settledQty),
      })),
    } : null,
    history: (request?.shortfallRounds || []).map(entry => ({
      round: entry.round,
      offeredAt: entry.offeredAt,
      offeredByName: entry.offeredByName || '',
      outcome: entry.outcome,
      respondedAt: entry.respondedAt || null,
      lineCount: (entry.lines || []).length,
    })),
  };
}
