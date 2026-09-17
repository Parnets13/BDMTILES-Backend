import 'dotenv/config';
import mongoose from 'mongoose';
import Quotation from '../models/Quotation.js';
import QuotationConversion from '../models/QuotationConversion.js';
import SalesOrder from '../models/SalesOrder.js';
import { requestFingerprint } from '../utils/idempotency.js';

const tolerance = 0.0001;
const flags = process.argv.slice(2);
if (flags.some(flag => !['--dry-run', '--execute'].includes(flag)) || (flags.includes('--dry-run') && flags.includes('--execute'))) {
  throw new Error('Use --dry-run or --execute only. Execution requires the explicit --execute flag.');
}
const execute = flags.includes('--execute');
const dryRun = !execute;
const idOf = value => String(value?._id || value || '');
const numberOf = value => Number(value || 0);
const sameId = (left, right) => idOf(left) === idOf(right);

function matchQuotationLine(orderItem, quotationItems, remainingByItem) {
  if (orderItem.sourceQuotationItem) {
    const exact = quotationItems.find(item => sameId(item._id, orderItem.sourceQuotationItem));
    if (exact) return exact;
  }
  return quotationItems.find(item => (
    sameId(item.product, orderItem.product)
    && (!orderItem.shade || !item.shade || orderItem.shade === item.shade)
    && (!orderItem.batch || !item.batch || orderItem.batch === item.batch)
    && numberOf(remainingByItem.get(idOf(item._id))) > tolerance
  ));
}

async function linkedOrders(quotation) {
  const linkedIds = [quotation.convertedToSO, ...(quotation.convertedSalesOrders || [])]
    .map(value => value?._id || value)
    .filter(value => value && mongoose.isValidObjectId(value));
  const active = await SalesOrder.find({
    branch: quotation.branch,
    $or: [
      { sourceQuotation: quotation._id },
      ...(linkedIds.length ? [{ _id: { $in: linkedIds } }] : []),
    ],
  }).sort({ createdAt: 1, _id: 1 }).lean();
  const activeIds = new Set(active.map(order => idOf(order._id)));
  const missingIds = linkedIds.filter(id => !activeIds.has(idOf(id)));
  const recycledRows = missingIds.length
    ? await mongoose.connection.collection('recyclebins').find({
      branch: quotation.branch,
      originalModel: 'SalesOrder',
      originalId: { $in: missingIds },
    }).toArray()
    : [];
  const recycled = recycledRows.map(row => ({
    ...row.data,
    _id: row.originalId,
    branch: row.data?.branch || row.branch,
    createdAt: row.data?.createdAt || row.deletedAt,
    updatedAt: row.data?.updatedAt || row.deletedAt,
    __recycled: true,
  }));
  return [...active, ...recycled].sort((left, right) =>
    new Date(left.createdAt || 0) - new Date(right.createdAt || 0)
    || idOf(left._id).localeCompare(idOf(right._id))
  );
}

async function preflight() {
  const failures = [];
  const cursor = Quotation.collection.find({
    $or: [
      { status: 'converted' },
      { convertedToSO: { $type: 'objectId' } },
      { convertedSalesOrders: { $exists: true, $ne: [] } },
    ],
  });
  for await (const quotation of cursor) {
    const orders = await linkedOrders(quotation);
    if (!orders.length) {
      failures.push(`${quotation.quotationNumber || quotation._id}: converted quotation has no verifiable source Sales Order`);
      continue;
    }
    if (!(quotation.items || []).every(item => item._id)) {
      failures.push(`${quotation.quotationNumber || quotation._id}: one or more quotation items have no _id`);
      continue;
    }
    const remaining = new Map((quotation.items || []).map(item => [idOf(item._id), numberOf(item.quantity)]));
    for (const order of orders) {
      for (const orderItem of order.items || []) {
        const source = matchQuotationLine(orderItem, quotation.items || [], remaining);
        if (!source) {
          failures.push(`${quotation.quotationNumber || quotation._id}/${order.orderNumber}: cannot map Sales Order item ${orderItem.productCode || orderItem._id}`);
          continue;
        }
        remaining.set(idOf(source._id), numberOf(remaining.get(idOf(source._id))) - numberOf(orderItem.quantity));
      }
    }
    for (const item of quotation.items || []) {
      const unconverted = numberOf(remaining.get(idOf(item._id)));
      if (unconverted < -tolerance) {
        failures.push(`${quotation.quotationNumber || quotation._id}: linked Sales Orders exceed quotation item ${item.productCode || item._id} by ${Math.abs(unconverted)}`);
      } else if (quotation.status === 'converted' && Math.abs(unconverted) > tolerance) {
        failures.push(`${quotation.quotationNumber || quotation._id}: linked Sales Order quantities differ from quotation item ${item.productCode || item._id} by ${unconverted}`);
      }
    }
  }
  if (failures.length) {
    throw new Error(`Quotation conversion migration preflight failed; no writes were made:\n- ${failures.slice(0, 50).join('\n- ')}`);
  }
}

async function backfillQuotation(quotation) {
  const orders = await linkedOrders(quotation);
  if (!orders.length) return false;

  const convertedByItem = new Map((quotation.items || []).map(item => [idOf(item._id), 0]));
  const remainingByItem = new Map((quotation.items || []).map(item => [idOf(item._id), numberOf(item.quantity)]));
  for (const order of orders) {
    const sourceKey = order.sourceKey || `quotation-migration:${quotation._id}:${order._id}`;
    const fingerprint = order.requestFingerprint || requestFingerprint({ migration: 'legacy-quotation-conversion', salesOrder: idOf(order._id) });
    const mappedItems = [];
    const orderItems = (order.items || []).map((orderItem) => {
      const source = matchQuotationLine(orderItem, quotation.items || [], remainingByItem);
      if (!source) throw new Error(`Unexpected item mapping failure for ${order.orderNumber}.`);
      const quantity = numberOf(orderItem.quantity);
      const key = idOf(source._id);
      remainingByItem.set(key, numberOf(remainingByItem.get(key)) - quantity);
      convertedByItem.set(key, numberOf(convertedByItem.get(key)) + quantity);
      mappedItems.push({
        quotationItem: source._id,
        product: orderItem.product,
        quantity,
        warehouse: orderItem.warehouse,
        shade: orderItem.shade || '',
        batch: orderItem.batch || '',
      });
      return { ...orderItem, sourceQuotationItem: source._id };
    });
    if (!order.__recycled) {
      await SalesOrder.collection.updateOne(
        { _id: order._id, branch: quotation.branch },
        { $set: { items: orderItems, sourceQuotation: quotation._id, sourceKey, requestFingerprint: fingerprint } },
      );
    }
    await QuotationConversion.updateOne(
      { branch: quotation.branch, quotation: quotation._id, sourceKey },
      {
        $setOnInsert: {
          branch: quotation.branch,
          quotation: quotation._id,
          salesOrder: order._id,
          sourceKey,
          requestFingerprint: fingerprint,
          mode: orders.length === 1 && quotation.status === 'converted' ? 'full' : 'available',
          sourceQuotationStatus: 'accepted',
          status: 'active',
          includePartialLines: false,
          lines: mappedItems,
          charges: {
            freightCharges: numberOf(order.freightCharges),
            loadingCharges: numberOf(order.loadingCharges),
            installationCharges: numberOf(order.installationCharges),
            otherCharges: numberOf(order.otherCharges),
          },
          createdBy: order.createdBy,
          createdAt: order.createdAt || quotation.convertedAt || new Date(),
          updatedAt: order.updatedAt || order.createdAt || new Date(),
        },
      },
      { upsert: true, timestamps: false },
    );
  }

  const isFull = (quotation.items || []).every(item =>
    numberOf(convertedByItem.get(idOf(item._id))) >= numberOf(item.quantity) - tolerance
  );
  const firstOrder = orders[0];
  const lastOrder = orders[orders.length - 1];
  const items = (quotation.items || []).map(item => ({
    ...item,
    convertedQuantity: numberOf(convertedByItem.get(idOf(item._id))),
  }));
  await Quotation.collection.updateOne(
    { _id: quotation._id, branch: quotation.branch },
    {
      $set: {
        items,
        convertedToSO: quotation.convertedToSO || firstOrder._id,
        convertedAt: quotation.convertedAt || firstOrder.createdAt || new Date(),
        convertedSalesOrders: orders.map(order => order._id),
        conversionState: isFull ? 'full' : 'partial',
        conversionVersion: Math.max(numberOf(quotation.conversionVersion), orders.length),
        firstConvertedAt: quotation.firstConvertedAt || firstOrder.createdAt || quotation.convertedAt || new Date(),
        lastConvertedAt: quotation.lastConvertedAt || lastOrder.createdAt || quotation.convertedAt || new Date(),
        ...(isFull ? { status: 'converted', fullyConvertedAt: quotation.fullyConvertedAt || lastOrder.createdAt || new Date() } : {}),
      },
    },
  );
  return true;
}

async function replaceSalesOrderIndex() {
  const collection = SalesOrder.collection;
  await collection.createIndex(
    { branch: 1, sourceQuotation: 1, createdAt: 1 },
    {
      name: 'branch_1_sourceQuotation_1_createdAt_1',
      partialFilterExpression: { sourceQuotation: { $type: 'objectId' } },
    },
  );
  const indexes = await collection.indexes();
  const replacement = indexes.find(index => index.name === 'branch_1_sourceQuotation_1_createdAt_1');
  if (!replacement || replacement.unique) throw new Error('Replacement Sales Order quotation-history index could not be verified.');
  const legacy = indexes.find(index => index.name === 'branch_1_sourceQuotation_1');
  if (legacy) {
    if (!legacy.unique) {
      console.log('Legacy branch/sourceQuotation index is already non-unique.');
    } else {
      await collection.dropIndex(legacy.name);
      console.log(`Dropped unique index ${legacy.name} after verifying its replacement.`);
    }
  }
  await QuotationConversion.createIndexes();
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  console.log(`Connected to ${mongoose.connection.name}`);
  await preflight();
  if (dryRun) {
    console.log('Dry run completed: preflight passed and no database writes or index changes were made.');
    return;
  }
  console.log('Preflight passed; creating ledger constraints before resumable backfill.');
  await QuotationConversion.createIndexes();
  console.log('Conversion ledger indexes verified; backfilling conversion lineage.');

  let updated = 0;
  const cursor = Quotation.collection.find({
    $or: [
      { status: 'converted' },
      { convertedToSO: { $type: 'objectId' } },
      { convertedSalesOrders: { $exists: true, $ne: [] } },
    ],
  });
  for await (const quotation of cursor) {
    if (await backfillQuotation(quotation)) updated += 1;
  }
  await Quotation.collection.updateMany(
    {
      status: { $ne: 'converted' },
      $or: [{ convertedSalesOrders: { $exists: false } }, { convertedSalesOrders: { $size: 0 } }],
    },
    { $set: { conversionState: 'none', conversionVersion: 0 } },
  );
  await preflight();
  console.log('Final lineage verification passed; replacing the legacy unique index.');
  await replaceSalesOrderIndex();
  console.log(`Quotation conversion migration completed; ${updated} converted quotation(s) backfilled.`);
}

run()
  .catch((error) => {
    console.error('Quotation conversion migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
