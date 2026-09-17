import 'dotenv/config';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import DispatchTrip from '../models/DispatchTrip.js';
import PickList from '../models/PickList.js';

const flags = process.argv.slice(2);
if (flags.some(flag => !['--execute', '--dry-run'].includes(flag)) || (flags.includes('--execute') && flags.includes('--dry-run'))) throw new Error('Use --dry-run or --execute only.');
const execute = flags.includes('--execute');

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const stats = { examined: 0, safe: 0, ambiguous: 0, updated: 0 };
  for await (const delivery of Delivery.find({ status: { $in: ['assigned', 'in_transit', 'reached', 'failed', 'rescheduled'] }, 'items.0': { $exists: false }, dispatchTrip: { $ne: null }, salesOrder: { $ne: null } }).cursor()) {
    stats.examined += 1;
    const trip = await DispatchTrip.findById(delivery.dispatchTrip).lean();
    const tripOrder = trip?.orders?.find(order => String(order.salesOrder) === String(delivery.salesOrder));
    const pickList = tripOrder?.pickList ? await PickList.findById(tripOrder.pickList).lean() : null;
    if (!trip || !tripOrder || !pickList) { stats.ambiguous += 1; continue; }
    const items = (pickList.items || []).filter(item => Number(item.dispatchedQty || 0) > 0).map(item => ({
      pickList: pickList._id, pickListItem: item._id, salesOrderItem: item.salesOrderItem,
      originalDispatchOperationKey: `dispatch-trip:${trip._id}:${pickList._id}:${item._id}:consume`,
      product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '',
      dispatchedQuantity: Number(item.dispatchedQty), acceptedQuantity: 0, shortQuantity: 0, damagedRejectedQuantity: 0,
      enteredUnit: item.unit || 'Unit', baseQuantity: Number(item.dispatchedQty), baseUnit: item.unit || 'Unit', conversionFactor: 1, uomVersion: 1,
    }));
    if (!items.length || items.some(item => !item.salesOrderItem || !item.warehouse)) { stats.ambiguous += 1; continue; }
    stats.safe += 1;
    if (execute) { delivery.items = items; delivery.itemReconciliationState = 'pending'; await delivery.save(); stats.updated += 1; }
  }
  console.log(`${execute ? 'EXECUTE' : 'DRY RUN'}: delivery item lineage`);
  console.log(JSON.stringify(stats, null, 2));
  if (!execute) console.log('No documents were written; ambiguous legacy deliveries remain unchanged.');
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
