/**
 * Links historical dispatch and delivery records to Vehicle Master.
 *
 * Before this, dispatch stored the registration as free text and never set the
 * `vehicle` ref, so nothing could be reported per vehicle. Records created from
 * now on are linked at source; this walks the existing ones and connects any whose
 * registration matches a master record exactly.
 *
 * Only ever fills in what is missing:
 *   - never overwrites an existing ref
 *   - never edits the stored registration text
 *   - never invents a Vehicle Master entry for an unmatched number, it just reports it
 *
 * Run with --apply to write. Without it, reports what it would do.
 * #g
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import DispatchTrip from '../models/DispatchTrip.js';
import Delivery from '../models/Delivery.js';
import Dispatch from '../models/Dispatch.js';

const apply = process.argv.includes('--apply');
const normalise = value => String(value || '').trim().toUpperCase();

await mongoose.connect(process.env.MONGODB_URI);

const vehicles = await Vehicle.find({}).select('_id vehicleNumber vehicleType driverName driverPhone').lean();
const byNumber = new Map(vehicles.map(v => [normalise(v.vehicleNumber), v]));
console.log(`Vehicle Master: ${vehicles.length} vehicle(s)\n`);

const unmatched = new Map();
const report = { trips: { linked: 0, unmatched: 0, blank: 0 }, deliveries: { linked: 0, unmatched: 0, blank: 0 }, dispatches: { linked: 0, unmatched: 0, blank: 0 } };

const noteUnmatched = (number, where) => {
  const key = normalise(number);
  if (!unmatched.has(key)) unmatched.set(key, new Set());
  unmatched.get(key).add(where);
};

// ── Dispatch trips ──────────────────────────────────────────────────────────
for (const trip of await DispatchTrip.find({ vehicle: { $exists: false } }).select('_id tripNumber vehicleNumber vehicleType').lean()) {
  if (!normalise(trip.vehicleNumber)) { report.trips.blank += 1; continue; }
  const match = byNumber.get(normalise(trip.vehicleNumber));
  if (!match) { report.trips.unmatched += 1; noteUnmatched(trip.vehicleNumber, `trip ${trip.tripNumber}`); continue; }
  report.trips.linked += 1;
  if (apply) {
    await DispatchTrip.updateOne(
      { _id: trip._id, vehicle: { $exists: false } },
      // Fill the type only when the trip has none, so an existing value is kept.
      { $set: { vehicle: match._id, ...(trip.vehicleType ? {} : { vehicleType: match.vehicleType || '' }) } },
    );
  }
}

// ── Deliveries ──────────────────────────────────────────────────────────────
// Deliveries had no vehicle field at all, so their number comes from the trip.
for (const delivery of await Delivery.find({ vehicle: { $exists: false } })
  .select('_id deliveryNumber vehicleNumber dispatchTrip').lean()) {
  let number = delivery.vehicleNumber;
  let tripDoc = null;
  if (!normalise(number) && delivery.dispatchTrip) {
    tripDoc = await DispatchTrip.findById(delivery.dispatchTrip).select('vehicleNumber vehicleType driverName driverPhone').lean();
    number = tripDoc?.vehicleNumber;
  }
  if (!normalise(number)) { report.deliveries.blank += 1; continue; }
  const match = byNumber.get(normalise(number));
  if (!match) { report.deliveries.unmatched += 1; noteUnmatched(number, `delivery ${delivery.deliveryNumber}`); continue; }
  report.deliveries.linked += 1;
  if (apply) {
    await Delivery.updateOne(
      { _id: delivery._id, vehicle: { $exists: false } },
      {
        $set: {
          vehicle: match._id,
          vehicleNumber: match.vehicleNumber,
          vehicleType: match.vehicleType || '',
          // Driver is taken from the trip that actually ran, falling back to the
          // vehicle's usual driver only when the trip recorded none.
          driverName: tripDoc?.driverName || match.driverName || '',
          driverPhone: tripDoc?.driverPhone || match.driverPhone || '',
        },
      },
    );
  }
}

// ── Legacy dispatches ───────────────────────────────────────────────────────
for (const dispatch of await Dispatch.find({ vehicleRef: { $exists: false } }).select('_id dispatchNumber vehicle').lean()) {
  if (!normalise(dispatch.vehicle)) { report.dispatches.blank += 1; continue; }
  const match = byNumber.get(normalise(dispatch.vehicle));
  if (!match) { report.dispatches.unmatched += 1; noteUnmatched(dispatch.vehicle, `dispatch ${dispatch.dispatchNumber}`); continue; }
  report.dispatches.linked += 1;
  if (apply) {
    await Dispatch.updateOne(
      { _id: dispatch._id, vehicleRef: { $exists: false } },
      { $set: { vehicleRef: match._id, vehicleType: match.vehicleType || '' } },
    );
  }
}

for (const [name, counts] of Object.entries(report)) {
  console.log(`${name}: ${counts.linked} linked, ${counts.unmatched} unmatched, ${counts.blank} with no vehicle recorded`);
}

if (unmatched.size) {
  console.log('\nRegistrations not in Vehicle Master (add them there, then re-run):');
  for (const [number, where] of unmatched) {
    const list = [...where];
    console.log(`  ${number}  —  ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''}`);
  }
}

console.log(apply ? '\nApplied.' : '\nDry run. Re-run with --apply to write these links.');
await mongoose.disconnect();
