/**
 * One-time fix: patches existing Delivery documents that have no
 * deliveryExecutive by reading the value from their linked PickList
 * (where the DriverVehicleModal stored it during loading verification).
 *
 * Run once after deploying the dispatchTripRoutes.js fix:
 *   node scripts/fixDeliveryExecutives.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

// Load all models to satisfy populate refs
await import('../models/User.js');
await import('../models/Branch.js');
await import('../models/Vehicle.js');
await import('../models/SalesOrder.js');
await import('../models/PickList.js');
await import('../models/DispatchTrip.js');
await import('../models/Delivery.js');

await mongoose.connect(process.env.MONGODB_URI);

const Delivery = mongoose.model('Delivery');
const PickList = mongoose.model('PickList');
const DispatchTrip = mongoose.model('DispatchTrip');

// Find all deliveries with no deliveryExecutive that are not yet completed
const broken = await Delivery.find({
  deliveryExecutive: { $in: [null, undefined] },
  status: { $nin: ['delivered', 'partially_delivered', 'failed'] },
}).lean();

console.log(`Found ${broken.length} deliveries without a delivery executive.`);

let fixed = 0;
for (const del of broken) {
  let deId = null;
  let deName = '';

  // Try to get from DispatchTrip
  if (del.dispatchTrip) {
    const trip = await DispatchTrip.findById(del.dispatchTrip)
      .select('deliveryExecutive deliveryExecutiveName orders')
      .populate('deliveryExecutive', 'name')
      .lean();

    if (trip?.deliveryExecutive) {
      deId = trip.deliveryExecutive._id || trip.deliveryExecutive;
      deName = trip.deliveryExecutive.name || trip.deliveryExecutiveName || '';
    }

    // If trip has no DE either, check linked PickLists
    if (!deId && trip?.orders?.length) {
      const pickListIds = trip.orders.map(o => o.pickList).filter(Boolean);
      const pl = await PickList.findOne({
        _id: { $in: pickListIds },
        deliveryExecutive: { $exists: true, $ne: null },
      })
        .select('deliveryExecutive')
        .populate('deliveryExecutive', 'name')
        .lean();
      if (pl?.deliveryExecutive) {
        deId = pl.deliveryExecutive._id || pl.deliveryExecutive;
        deName = pl.deliveryExecutive.name || '';
      }
    }
  }

  if (deId) {
    await Delivery.updateOne(
      { _id: del._id },
      { $set: { deliveryExecutive: deId, deliveryExecutiveName: deName } },
    );
    console.log(`Fixed DEL ${del.deliveryNumber} → ${deName} (${deId})`);
    fixed++;
  } else {
    console.log(`Skipped DEL ${del.deliveryNumber} — no deliveryExecutive found in trip or picklist`);
  }
}

console.log(`\nDone. Fixed ${fixed} / ${broken.length} deliveries.`);
await mongoose.disconnect();
