/**
 * The fulfilment stage a DEALER sees.
 *
 * Three separate status machines sit behind one delivery, and none of them is written
 * for an outside audience:
 *
 *   PickList      9 states  generated → assigned → in_progress → picked → verified →
 *                           sorted → packed → ready_for_dispatch → loaded
 *   DispatchTrip  7 states  planning → loading → loaded → dispatched → in_transit → completed
 *   Delivery      8 states  assigned → in_transit → reached → delivered → …
 *
 * A dealer does not need to know the difference between "sorted" and "packed". From
 * outside, the message is "we are picking your order" until it becomes "it is on the
 * vehicle". This collapses all three into the stages worth telling them about.
 *
 * The warehouse screens keep their own granularity — only this outward view is
 * simplified. Nothing here mutates a status; it is a read-time projection.
 */

// PickList — stock is being pulled off the rack.
const PICKING = new Set(['generated', 'assigned', 'in_progress', 'picked']);
// PickList — pulled and checked, being made ready to go on a vehicle.
const PACKING = new Set(['verified', 'sorted']);
// PickList — packed and waiting for a vehicle.
//
// Deliberately distinct from `packing`. This is the state a dealer actually notices and
// asks about ("my order is packed, why does the app not show it"), so reporting it as
// "Packing" would understate a finished job as work in progress.
const PACKED = new Set(['packed', 'ready_for_dispatch']);
// PickList — on the vehicle, delivery not started yet.
const LOADING = new Set(['loaded']);

// Delivery status → stage. `assigned` is deliberately absent: on its own it means
// "allocated to a driver", and whether that is Loading or Dispatched depends on the
// trip, which resolveStage checks before falling back to it.
const FROM_DELIVERY = {
  in_transit: 'in_transit',
  reached: 'reached',
  delivered: 'delivered',
  partially_delivered: 'partially_delivered',
  failed: 'failed',
  rescheduled: 'rescheduled',
  returned: 'returned',
};

const LABELS = {
  picking: 'Picking',
  packing: 'Packing',
  packed: 'Packed',
  loading: 'Loading',
  assigned: 'Assigned',
  dispatched: 'Dispatched',
  in_transit: 'In transit',
  reached: 'Reached',
  delivered: 'Delivered',
  partially_delivered: 'Part delivered',
  failed: 'Failed',
  rescheduled: 'Rescheduled',
  returned: 'Returned',
};

export const stageLabel = (stage) => LABELS[stage] || '';

/**
 * Resolve one dealer-facing stage from whatever the three machines currently say.
 *
 * Precedence, and why:
 *  1. The Delivery status wins as soon as it has moved past `assigned`. It is the record
 *     the proof of delivery hangs off, and the warehouse statuses lag behind it — a pick
 *     list stays `loaded` for a long time after the truck has left.
 *  2. The DispatchTrip wins on "has the vehicle actually gone", for the same reason: it
 *     is the only record that knows the truck departed.
 *  3. Only then does the PickList decide, because that is the only machine that knows
 *     anything before a Delivery row exists at all.
 *
 * Returns '' when nothing knows where the order is — callers should render that as
 * "no stage" rather than inventing one.
 */
export const resolveStage = ({pickListStatus, tripStatus, deliveryStatus} = {}) => {
  const delivery = String(deliveryStatus || '').toLowerCase();

  if (delivery && delivery !== 'assigned') return FROM_DELIVERY[delivery] || delivery;

  const trip = String(tripStatus || '').toLowerCase();
  // dispatched / in_transit / completed all mean the vehicle is no longer at the yard.
  if (trip === 'dispatched' || trip === 'in_transit' || trip === 'completed') return 'in_transit';
  // `loading` and `loaded` are both "on the vehicle, not yet departed", and the TRIP is
  // the authority for both — not the pick list.
  //
  // A pick list deliberately stays `ready_for_dispatch` right through loading: the
  // dispatch route claims it by that exact status, so advancing it at loading time would
  // make the pick list unclaimable and break dispatch. That is also why
  // `PickList.status = 'loaded'` is never reached in practice. Reading the pick list
  // alone therefore reported "Packed" for goods already loaded onto a truck.
  if (trip === 'loading' || trip === 'loaded') return 'loading';

  const pick = String(pickListStatus || '').toLowerCase();
  if (LOADING.has(pick)) return 'loading';
  if (PACKED.has(pick)) return 'packed';
  if (PACKING.has(pick)) return 'packing';
  if (PICKING.has(pick)) return 'picking';

  // A delivery exists but nothing upstream has a status: allocated to a driver and
  // waiting. That is a real state, not a missing one.
  if (delivery === 'assigned') return 'assigned';

  return '';
};
