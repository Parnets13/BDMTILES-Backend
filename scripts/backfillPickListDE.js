/**
 * Back-fills the deliveryExecutive ObjectId on loaded PickLists that
 * have a driverPhone/driverName but no linked User account yet.
 * Run once: node scripts/backfillPickListDE.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await import('../models/User.js');
await import('../models/PickList.js');
await import('../models/DispatchTrip.js');
await import('../models/Delivery.js');
await import('../models/Vehicle.js');
await import('../models/Branch.js');
await import('../models/SalesOrder.js');

await mongoose.connect(process.env.MONGODB_URI);

const User = mongoose.model('User');
const PickList = mongoose.model('PickList');

// All loaded PickLists missing a deliveryExecutive ObjectId
const loadedPLs = await PickList.find({
  status: 'loaded',
  deliveryExecutive: { $exists: false },
}).lean();

console.log(`PickLists missing deliveryExecutive: ${loadedPLs.length}`);

let fixed = 0;
for (const pl of loadedPLs) {
  if (!pl.driverPhone && !pl.driverName) {
    console.log(`Skip ${pl.pickListNumber} — no driver info at all`);
    continue;
  }

  let user = null;

  // Try phone match first (most reliable)
  if (pl.driverPhone) {
    user = await User.findOne({
      phone: pl.driverPhone.trim(),
      role: 'delivery_executive',
    }).select('_id name').lean();
  }

  // Fall back to name match
  if (!user && pl.driverName) {
    user = await User.findOne({
      name: new RegExp(`^${pl.driverName.trim()}$`, 'i'),
      role: 'delivery_executive',
    }).select('_id name').lean();
  }

  if (user) {
    await PickList.updateOne(
      { _id: pl._id },
      { $set: { deliveryExecutive: user._id } },
    );
    console.log(`Fixed  ${pl.pickListNumber}  →  ${user.name}  (${user._id})`);
    fixed++;
  } else {
    console.log(`No match for ${pl.pickListNumber} — driver: "${pl.driverName}" / "${pl.driverPhone}"`);
  }
}

console.log(`\nDone. Fixed ${fixed} / ${loadedPLs.length} PickLists.`);
await mongoose.disconnect();
