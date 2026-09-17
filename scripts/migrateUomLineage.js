import 'dotenv/config';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import StockTransfer from '../models/StockTransfer.js';
import Invoice from '../models/Invoice.js';
import SalesReturn from '../models/SalesReturn.js';
import { normalizeUom } from '../services/stockUomService.js';

const flags = process.argv.slice(2);
if (flags.some(flag => !['--execute', '--dry-run'].includes(flag)) || (flags.includes('--execute') && flags.includes('--dry-run'))) {
  throw new Error('Use --dry-run or --execute only. Execution requires the explicit --execute flag.');
}
const execute = flags.includes('--execute');
const models = [SalesOrder, PickList, StockTransfer, Invoice, SalesReturn];
const modelQuantityFields = new Map([
  [SalesOrder.modelName, ['quantity']],
  [PickList.modelName, ['requestedQty', 'quantity']],
  [StockTransfer.modelName, ['requestedQty', 'dispatchedQty']],
  [Invoice.modelName, ['quantity']],
  [SalesReturn.modelName, ['returnQty']],
]);
const validText = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const nonNegative = value => Number.isFinite(Number(value)) && Number(value) >= 0;
const validVersion = value => Number.isInteger(Number(value)) && Number(value) >= 1;
const lineComplete = line => validText(line?.baseUnit) && positive(line?.conversionFactor)
  && validVersion(line?.uomVersion) && nonNegative(line?.baseQuantity);
const productComplete = product => validText(product?.inventoryBaseUom) && validVersion(product?.inventoryUomVersion)
  && Array.isArray(product?.uomConversions) && product.uomConversions.length > 0;
const stockComplete = stock => validText(stock?.baseUnit) && validVersion(stock?.uomVersion);
const casFilter = document => document.__v === undefined
  ? { _id: document._id, __v: { $exists: false } }
  : { _id: document._id, __v: document.__v };
const versionUpdate = document => document.__v === undefined ? {} : { $inc: { __v: 1 } };
const quantityFor = (line, fields) => {
  for (const field of fields) {
    if (line[field] !== undefined && line[field] !== null && Number.isFinite(Number(line[field]))) return Number(line[field]);
  }
  return 0;
};

async function migrateProducts(stats) {
  for await (const product of Product.collection.find({}, { projection: { unit: 1, inventoryBaseUom: 1, inventoryUomVersion: 1, uomConversions: 1, __v: 1 } })) {
    if (productComplete(product)) continue;
    const base = normalizeUom(product.inventoryBaseUom || product.unit || 'Unit');
    const set = {};
    if (!validText(product.inventoryBaseUom)) set.inventoryBaseUom = base;
    if (!validVersion(product.inventoryUomVersion)) set.inventoryUomVersion = 1;
    if (!Array.isArray(product.uomConversions) || product.uomConversions.length === 0) {
      set.uomConversions = [{ uom: base, toBaseFactor: 1, precision: 6, allowFraction: true, version: 1, effectiveFrom: new Date(0) }];
    }
    stats.products.planned += 1;
    if (!execute) continue;
    const result = await Product.collection.updateOne(casFilter(product), { $set: set, ...versionUpdate(product) });
    if (result.matchedCount === 1) stats.products.applied += 1;
    else stats.products.conflicts += 1;
  }
}

async function migrateStocks(stats) {
  const productIds = await Stock.collection.distinct('product');
  const products = await Product.collection.find({ _id: { $in: productIds } }, { projection: { unit: 1, inventoryBaseUom: 1 } }).toArray();
  const productsById = new Map(products.map(product => [String(product._id), product]));
  for await (const stock of Stock.collection.find({}, { projection: { product: 1, baseUnit: 1, uomVersion: 1, __v: 1 } })) {
    if (stockComplete(stock)) continue;
    const product = productsById.get(String(stock.product));
    const set = {};
    if (!validText(stock.baseUnit)) set.baseUnit = normalizeUom(product?.inventoryBaseUom || product?.unit || 'Unit');
    if (!validVersion(stock.uomVersion)) set.uomVersion = 1;
    stats.stocks.planned += 1;
    if (!execute) continue;
    const result = await Stock.collection.updateOne(casFilter(stock), { $set: set, ...versionUpdate(stock) });
    if (result.matchedCount === 1) stats.stocks.applied += 1;
    else stats.stocks.conflicts += 1;
  }
}

async function migrateEmbeddedLines(stats) {
  for (const Model of models) {
    const entry = stats.models[Model.modelName];
    const fields = modelQuantityFields.get(Model.modelName);
    for await (const document of Model.collection.find(
      { items: { $type: 'array', $ne: [] } },
      { projection: { items: 1, __v: 1 } }
    )) {
      const incomplete = (document.items || []).filter(line => !lineComplete(line));
      if (!incomplete.length) continue;
      const patchedItems = (document.items || []).map(line => {
        if (lineComplete(line)) return line;
        const unit = normalizeUom(line.enteredUnit || line.unit || line.baseUnit || 'Unit');
        const factor = positive(line.conversionFactor) ? Number(line.conversionFactor) : 1;
        const quantity = quantityFor(line, fields);
        return {
          ...line,
          ...(!validText(line.baseUnit) ? { baseUnit: unit } : {}),
          ...(!positive(line.conversionFactor) ? { conversionFactor: factor } : {}),
          ...(!validVersion(line.uomVersion) ? { uomVersion: 1 } : {}),
          ...(!nonNegative(line.baseQuantity) ? { baseQuantity: quantity * factor } : {}),
        };
      });
      entry.documentsPlanned += 1;
      entry.linesPlanned += incomplete.length;
      if (!execute) continue;
      const result = await Model.collection.updateOne(casFilter(document), { $set: { items: patchedItems }, ...versionUpdate(document) });
      if (result.matchedCount === 1) {
        entry.documentsApplied += 1;
        entry.linesApplied += incomplete.length;
      } else {
        entry.conflicts += 1;
        if (entry.conflictSamples.length < 10) entry.conflictSamples.push(String(document._id));
      }
    }
  }
}

async function residualReport(stats) {
  stats.products.residual = 0;
  for await (const product of Product.collection.find({}, { projection: { unit: 1, inventoryBaseUom: 1, inventoryUomVersion: 1, uomConversions: 1 } })) {
    if (!productComplete(product)) stats.products.residual += 1;
  }
  stats.stocks.residual = 0;
  for await (const stock of Stock.collection.find({}, { projection: { baseUnit: 1, uomVersion: 1 } })) {
    if (!stockComplete(stock)) stats.stocks.residual += 1;
  }
  for (const Model of models) {
    const entry = stats.models[Model.modelName];
    for await (const document of Model.collection.find({ items: { $type: 'array', $ne: [] } }, { projection: { items: 1 } })) {
      const residualLines = (document.items || []).filter(line => !lineComplete(line));
      if (!residualLines.length) continue;
      entry.residualDocuments += 1;
      entry.residualLines += residualLines.length;
      if (entry.residualSamples.length < 10) entry.residualSamples.push(String(document._id));
    }
  }
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const stats = {
    mode: execute ? 'EXECUTE' : 'DRY RUN',
    products: { planned: 0, applied: 0, conflicts: 0, residual: 0 },
    stocks: { planned: 0, applied: 0, conflicts: 0, residual: 0 },
    models: Object.fromEntries(models.map(Model => [Model.modelName, {
      documentsPlanned: 0, linesPlanned: 0, documentsApplied: 0, linesApplied: 0,
      conflicts: 0, conflictSamples: [], residualDocuments: 0, residualLines: 0, residualSamples: [],
    }])),
  };
  await migrateProducts(stats);
  await migrateStocks(stats);
  await migrateEmbeddedLines(stats);
  await residualReport(stats);
  console.log(`${stats.mode}: additive factor-1 UOM lineage with compare-and-set updates`);
  console.log(JSON.stringify(stats, null, 2));
  if (!execute) console.log('No documents were written. Supply --execute explicitly to apply. Residual counts show current stored gaps; planned counts show what execution would attempt.');
  const conflicts = stats.products.conflicts + stats.stocks.conflicts
    + Object.values(stats.models).reduce((sum, item) => sum + item.conflicts, 0);
  if (execute && conflicts > 0) process.exitCode = 1;
}

run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
