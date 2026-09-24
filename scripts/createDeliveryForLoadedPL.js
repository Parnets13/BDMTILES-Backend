/**
 * Creates a Delivery document for a loaded PickList that has no DispatchTrip.
 * This covers the case where a pick list was physically loaded onto a vehicle
 * and the driver is selected, but no web dispatch trip was created yet.
 *
 * Run: node scripts/createDeliveryForLoadedPL.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const mods = [
  'User','Branch','Vehicle','SalesOrder','PickList',
  'DispatchTrip','Delivery','Stock','Warehouse',
];
for (const m of mods) {
  try { await import(`../models/${m}.js`); } catch {}
}

await mongoose.connect(process.env.MONGODB_URI);

const PickList  = mongoose.model('PickList');
const SalesOrder = mongoose.model('SalesOrder');
const Delivery  = mongoose.model('Delivery');
const { generateBranchNumber } = await import('../utils/branchSequence.js');

// ── target: all loaded PickLists with a deliveryExecutive but no Delivery ──
const loadedPLs = await PickList.find({
  status: 'loaded',
  deliveryExecutive: { $exists: true, $ne: null },
  dispatchTrip: { $exists: false },   // no trip → no auto-created Delivery
})
  .populate('deliveryExecutive', 'name phone')
  .lean();

console.log(`Found ${loadedPLs.length} loaded PickList(s) with no dispatch trip.`);

let created = 0;
for (const pl of loadedPLs) {
  // Skip if a Delivery already exists for this salesOrder
  const existing = await Delivery.findOne({ salesOrder: pl.salesOrder, branch: pl.branch }).lean();
  if (existing) {
    console.log(`Skip ${pl.pickListNumber} — Delivery ${existing.deliveryNumber} already exists`);
    continue;
  }

  const so = await SalesOrder.findById(pl.salesOrder)
    .select('orderNumber dealer dealerName dealerCode customerName customerPhone deliveryAddress status grandTotal')
    .lean();

  if (!so) {
    console.log(`Skip ${pl.pickListNumber} — SalesOrder not found`);
    continue;
  }

  const deliveryNumber = await generateBranchNumber(pl.branch, 'delivery', new Date());
  const otp = String(Math.floor(100000 + Math.random() * 900000));

  const delivery = await Delivery.create({
    deliveryNumber,
    branch: pl.branch,
    salesOrder: pl.salesOrder,
    orderNumber: so.orderNumber,
    dealer: so.dealer || undefined,
    dealerName: so.dealerName || so.customerName || '',
    dealerCode: so.dealerCode || '',
    contactPhone: so.customerPhone || '',
    deliveryAddress: so.deliveryAddress || '',
    deliveryExecutive: pl.deliveryExecutive._id,
    deliveryExecutiveName: pl.deliveryExecutive.name || '',
    vehicleNumber: pl.vehicleNumber || '',
    vehicleType: pl.vehicleType || '',
    driverName: pl.driverName || '',
    driverPhone: pl.driverPhone || '',
    totalBoxes: pl.totalBoxes || 0,
    unfulfilledQty: 0,
    hasFulfillmentShortage: false,
    items: [],
    itemReconciliationState: 'legacy',
    otp,
    status: 'assigned',
    startTime: new Date(),
    createdBy: pl.loadingVerifiedBy || pl.createdBy,
  });

  console.log(`Created Delivery ${delivery.deliveryNumber} for ${pl.pickListNumber} → driver: ${pl.deliveryExecutive.name}`);
  created++;
}

console.log(`\nDone. Created ${created} delivery record(s).`);
await mongoose.disconnect();
