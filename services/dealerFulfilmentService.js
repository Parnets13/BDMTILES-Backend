import mongoose from 'mongoose';
import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import Delivery from '../models/Delivery.js';
import {resolveStage, stageLabel} from '../utils/deliveryStage.js';

/**
 * The dealer's view of work that has not become a delivery yet.
 *
 * Picking, sorting, packing and loading all happen in `PickList`, and a Delivery row is
 * not created until the pick list reaches `loaded`. Nothing on the dealer side read
 * PickList at all — so an order being picked, or already packed, appeared NOWHERE in
 * the app:
 *
 *   · not in Deliveries      — no Delivery row existed yet
 *   · not in the notification feed — which is derived from Delivery
 *   · not on the order       — SalesOrder.status has no value between "approved"
 *                              and "dispatched", so it still read as approved
 *
 * That is the single root cause behind "order is packed but in app not coming".
 *
 * PickList carries NO `dealer` ref — only denormalised dealerName/dealerCode strings —
 * so the scope has to go through the sales order. That join is exactly why this is a
 * shared helper rather than three inline queries: getting it wrong shows one dealer
 * another dealer's order.
 */

/** Pick statuses meaning "in the warehouse, not yet on a vehicle". */
export const PRE_DISPATCH_STATUSES = [
  'generated',
  'assigned',
  'in_progress',
  'picked',
  'verified',
  'sorted',
  'packed',
  'ready_for_dispatch',
];

/**
 * Only open orders are worth joining against. This is what keeps the `$in` bounded —
 * without it the pick-list query would carry every order the dealer has ever placed.
 * `dispatched` is deliberately NOT excluded: an order can be dispatched and still have
 * a second pick list waiting.
 */
const OPEN_ORDER_STATUSES = {$nin: ['cancelled', 'expired', 'delivered']};

/** Progression order, used only to pick the furthest-along stage for an order. */
const RANK = [
  'picking',
  'packing',
  'packed',
  'loading',
  'assigned',
  'dispatched',
  'in_transit',
  'reached',
  'delivered',
  // Listed rather than left out: indexOf returns -1 for anything missing, and the
  // comparison below treats -1 as "earliest", so an unlisted stage would silently lose
  // to every listed one. A part-delivery is a real outcome and must rank as one.
  'partially_delivered',
  'failed',
  'rescheduled',
  'returned',
];

/** Trip id → status, for a batch of pick lists. One query, never one per row. */
const tripStatusById = async (tripIds = []) => {
  const ids = [...new Set(tripIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await DispatchTrip.find({_id: {$in: ids}}).select('status').lean();
  return new Map(rows.map((t) => [String(t._id), t.status]));
};

/**
 * Pick list ids that a Delivery already accounts for.
 *
 * Read through the delivery's own item lineage, so this stays scoped to rows the dealer
 * can already see.
 */
const coveredPickListIds = async (dealerId, pickListIds = []) => {
  const ids = [...new Set(pickListIds.filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  const rows = await Delivery.find({dealer: dealerId, 'items.pickList': {$in: ids}})
    .select('items.pickList')
    .lean();
  const out = new Set();
  for (const d of rows) for (const it of d.items || []) if (it.pickList) out.add(String(it.pickList));
  return out;
};

/**
 * The dealer's pick lists that are still in the warehouse.
 *
 * `includeLoaded` adds `loaded` — on a vehicle, delivery not started. Callers that
 * already show the delivery leg (the deliveries list) leave it off to avoid listing the
 * same order twice; callers that do not (the notification feed, the order row) want it.
 */
export const findDealerPickLists = async (dealerId, {limit = 20, includeLoaded = false} = {}) => {
  const statuses = includeLoaded ? [...PRE_DISPATCH_STATUSES, 'loaded'] : PRE_DISPATCH_STATUSES;

  const orderIds = await SalesOrder.find({dealer: dealerId, status: OPEN_ORDER_STATUSES})
    .distinct('_id');
  if (!orderIds.length) return [];

  const found = await PickList.find({salesOrder: {$in: orderIds}, status: {$in: statuses}})
    .select(
      'pickListNumber salesOrder orderNumber status dispatchTrip pickDate assignedAt ' +
        'pickingStartTime sortingStartTime packingEndTime loadingEndTime ' +
        'totalRequestedQty totalPickedQty items',
    )
    .sort({pickDate: -1})
    .limit(limit)
    .lean();

  // Drop anything that has already produced a delivery.
  //
  // A pick list is claimed by a trip and KEEPS `ready_for_dispatch` right through to
  // dispatch (the dispatch route claims it by that status), so once the trip was
  // dispatched this helper still returned it. The dealer then saw the same order twice:
  // once as a "not dispatched yet" row and once as its actual delivery — with the
  // dispatch row even reading "In transit" while carrying no delivery number.
  const covered = await coveredPickListIds(dealerId, found.map((r) => r._id));
  const rows = found.filter((r) => !covered.has(String(r._id)));

  // The trip, because a pick list stops being the authority once it is claimed.
  const tripById = await tripStatusById(rows.map(r => r.dispatchTrip));

  return rows.map((p) => {
    const stage = resolveStage({
      pickListStatus: p.status,
      tripStatus: tripById.get(String(p.dispatchTrip)) || '',
    });
    return {
      _id: p._id,
      pickListNumber: p.pickListNumber,
      salesOrder: p.salesOrder,
      orderNumber: p.orderNumber || '',
      status: p.status,
      stage,
      stageLabel: stageLabel(stage),
      // The earliest timestamp that says when this stage began, so callers can sort and
      // date the entry without knowing the warehouse's field names.
      since: p.pickingStartTime || p.assignedAt || p.pickDate || null,
      pickDate: p.pickDate || null,
      itemCount: (p.items || []).length,
      totalRequestedQty: Number(p.totalRequestedQty || 0),
      totalPickedQty: Number(p.totalPickedQty || 0),
    };
  });
};

/**
 * Fulfilment stage per sales order, for annotating an order list.
 *
 * Returns a Map of order id → {stage, stageLabel}. An order with no pick list yet is
 * simply absent, and the caller should leave its own status alone rather than inventing
 * a stage.
 */
export const stagesByOrder = async (dealerId, orderIds = []) => {
  if (!orderIds.length) return new Map();

  const [picks, deliveries] = await Promise.all([
    PickList.find({salesOrder: {$in: orderIds}, status: {$nin: ['cancelled']}})
      .select('salesOrder status dispatchTrip')
      .lean(),
    Delivery.find({salesOrder: {$in: orderIds}, dealer: dealerId})
      .select('salesOrder status')
      .lean(),
  ]);

  const tripById = await tripStatusById(picks.map(r => r.dispatchTrip));

  // The delivery, once one exists, is the authority — the same precedence resolveStage
  // already applies, and for the same reason: the warehouse statuses lag behind it.
  //
  // Without this, a delivered order's pick list and its completed trip resolved to
  // "In transit", so the Orders row said In transit for an order whose Deliveries row
  // correctly said Delivered. Two screens, one order, two answers.
  const deliveryStageByOrder = new Map();
  for (const d of deliveries) {
    const key = String(d.salesOrder);
    const stage = resolveStage({deliveryStatus: d.status});
    if (!stage) continue;
    const prev = deliveryStageByOrder.get(key);
    if (!prev || RANK.indexOf(prev) < RANK.indexOf(stage)) deliveryStageByOrder.set(key, stage);
  }

  const out = new Map();
  // Furthest-along wins: an order split across several pick lists has moved on as far as
  // its most advanced part.
  const consider = (key, stage) => {
    if (!stage) return;
    const prev = out.get(key);
    if (prev && RANK.indexOf(prev.stage) >= RANK.indexOf(stage)) return;
    out.set(key, {stage, stageLabel: stageLabel(stage)});
  };

  for (const row of picks) {
    consider(
      String(row.salesOrder),
      resolveStage({
        pickListStatus: row.status,
        tripStatus: tripById.get(String(row.dispatchTrip)) || '',
      }),
    );
  }
  for (const [key, stage] of deliveryStageByOrder) consider(key, stage);

  return out;
};

/**
 * Shape a warehouse pick list as the detail screen's payload.
 *
 * The screen renders every field behind a "only if present" guard, so the delivery-only
 * fields — OTP, POD, vehicle, receiver — are simply left out rather than sent empty. The
 * delivery leg of the timeline IS sent, with no timestamps, so the dealer sees the steps
 * still to come instead of a track that stops halfway with no explanation.
 *
 * No OTP is ever included: the handover code is generated when the goods are on a
 * vehicle, and showing one for stock still on the warehouse floor would invite a dealer
 * to hand it out early.
 */
const preDispatchDetail = (row) => {
  const stage = resolveStage({pickListStatus: row.status});
  return {
    // Lets the app label this as an order in progress rather than a delivery.
    preDispatch: true,
    deliveryNumber: row.orderNumber || row.pickListNumber,
    pickListNumber: row.pickListNumber || '',
    deliveryDate: row.pickDate || null,
    completionTime: null,
    status: row.status,
    stage,
    stageLabel: stageLabel(stage),
    orderNumber: row.orderNumber || '',
    invoiceNumber: '',
    tripNumber: '',
    otp: '',
    otpVerified: false,
    otpVerifiedAt: null,
    timeline: [
      {key: 'picking', label: 'Picking', at: row.pickingStartTime || row.assignedAt || row.pickDate || null},
      {key: 'packing', label: 'Packing', at: row.sortingStartTime || row.packingEndTime || null},
      {key: 'loading', label: 'Loading', at: row.loadingEndTime || null},
      // Not started. Null, so they render as pending rather than pretending to be done.
      {key: 'assigned', label: 'Assigned', at: null},
      {key: 'in_transit', label: 'In transit', at: null},
      {key: 'reached', label: 'Reached location', at: null},
      {key: 'delivered', label: 'Delivered', at: null},
    ],
    pod: {image: '', signature: '', document: ''},
    items: (row.items || []).map((it) => ({
      productName: it.productName || '',
      productCode: it.productCode || '',
      unit: it.unit || 'Box',
      // What has been picked so far — the app labels this "Picked" rather than
      // "Dispatched" when preDispatch is set.
      dispatchedQuantity: Number(it.pickedQty || it.requestedQty || 0),
      acceptedQuantity: 0,
      shortQuantity: Number(it.shortQty || 0),
      damagedQuantity: Number(it.damagedQty || 0),
    })),
  };
};

/**
 * One pick list, scoped to the dealer, shaped for the detail screen.
 *
 * The deliveries list carries rows for orders still in the warehouse, whose `_id` is a
 * PickList rather than a Delivery. The detail endpoint only looked in Delivery, so
 * opening one of those rows 404'd with "Delivery not found".
 *
 * Scoped through the sales order, exactly like findDealerPickLists. PickList has no
 * dealer ref, so an unscoped findById here would let any dealer read any pick list on
 * the system just by guessing an id.
 */
export const findDealerPickListDetail = async (dealerId, pickListId) => {
  // A malformed id would otherwise throw a CastError out of findById and surface as a
  // 500 rather than a clean "not found".
  if (!pickListId || !mongoose.Types.ObjectId.isValid(String(pickListId))) return null;

  const row = await PickList.findById(pickListId)
    .select(
      'pickListNumber salesOrder orderNumber status pickDate assignedAt ' +
        'pickingStartTime sortingStartTime packingEndTime loadingEndTime ' +
        'totalRequestedQty totalPickedQty items',
    )
    .lean();
  if (!row) return null;

  const owned = await SalesOrder.exists({_id: row.salesOrder, dealer: dealerId});
  if (!owned) return null;

  return preDispatchDetail(row);
};
