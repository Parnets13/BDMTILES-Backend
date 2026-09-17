import crypto from 'crypto';
import mongoose from 'mongoose';
import Stock from '../models/Stock.js';
import Product from '../models/Product.js';
import StockMovement, {
  STOCK_BUCKET_FIELDS,
  STOCK_MOVEMENT_TYPES,
  STOCK_SOURCE_TYPES,
} from '../models/StockMovement.js';
import { normalizeUom } from './stockUomService.js';

const EPSILON = 1e-9;
const asId = value => value?._id || value;
const idString = value => String(asId(value) || '');
const round = value => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
const serviceError = (status, message) => Object.assign(new Error(message), { status });

export const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const deterministicSourceId = value => new mongoose.Types.ObjectId(
  crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)
);
export const stockOperationKey = (...parts) => parts
  .flat()
  .map(part => String(part ?? '').trim())
  .join(':');

const canonicalValue = (value) => {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (mongoose.isValidObjectId(value) && (value._bsontype === 'ObjectId' || value instanceof mongoose.Types.ObjectId)) return String(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
};

export function stockMovementIntentHash(input, deltas = normalizeStockDeltas(input.deltas, { allowZero: Boolean(input.allowZeroDeltas) }), { legacy = false } = {}) {
  const enteredQuantity = Number(input.enteredQuantity ?? Math.max(...STOCK_BUCKET_FIELDS.map(field => Math.abs(deltas[field]))));
  const conversionFactor = Number(input.conversionFactor ?? 1);
  const baseQuantity = Number(input.baseQuantity ?? enteredQuantity * conversionFactor);
  const intent = {
    operationKey: String(input.operationKey || '').trim(),
    correlationKey: String(input.correlationKey || input.operationKey || '').trim(),
    movementType: input.movementType,
    phase: input.phase,
    branch: idString(input.branch), product: idString(input.product), warehouse: idString(input.warehouse),
    shade: String(input.shade || ''), batch: String(input.batch || ''), deltas,
    stockSet: input.stockSet || {}, minimums: input.minimums || {}, upsert: Boolean(input.upsert),
    enteredQuantity: round(enteredQuantity), enteredUnit: legacy ? String(input.enteredUnit || input.baseUnit || 'Unit') : normalizeUom(input.enteredUnit || input.baseUnit || 'Unit'),
    baseUnit: legacy ? String(input.baseUnit || input.enteredUnit || 'Unit') : normalizeUom(input.baseUnit || input.enteredUnit || 'Unit'), conversionFactor,
    ...(!legacy ? { baseQuantity: round(baseQuantity), uomVersion: Number(input.uomVersion || 1) } : {}),
    sourceType: input.sourceType, sourceModel: String(input.sourceModel || input.sourceType || ''), sourceId: idString(input.sourceId),
    sourceLineId: String(input.sourceLineId || asId(input.sourceId) || ''), sourceNumber: String(input.sourceNumber || ''),
    relatedBranch: idString(input.relatedBranch), relatedWarehouse: idString(input.relatedWarehouse), actor: idString(input.actor),
    reason: String(input.reason || ''), remarks: String(input.remarks || ''), provenance: input.provenance || 'prospective',
    confidence: input.confidence || 'exact', reversalOf: idString(input.reversalOf),
    reversalOfOperationKey: String(input.reversalOfOperationKey || ''), metadata: input.metadata || {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(intent))).digest('hex');
}

export function normalizeStockDeltas(input = {}, { allowZero = false } = {}) {
  const deltas = {};
  for (const field of STOCK_BUCKET_FIELDS) {
    const value = Number(input[field] ?? 0);
    if (!Number.isFinite(value)) throw serviceError(422, `${field} delta must be finite.`);
    deltas[field] = round(value);
  }
  if (!allowZero && STOCK_BUCKET_FIELDS.every(field => Math.abs(deltas[field]) <= EPSILON)) {
    throw serviceError(422, 'At least one stock bucket delta must be non-zero.');
  }
  return deltas;
}

export function stockSnapshot(value = {}) {
  return Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(Number(value[field] || 0))]));
}

export function subtractDeltas(after, deltas) {
  return Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(Number(after[field] || 0) - deltas[field])]));
}

const sameReplay = (movement, input, deltas) => {
  const legacy = !movement.intentHashVersion || Number(movement.intentHashVersion) < 2;
  const expectedHash = stockMovementIntentHash(input, deltas, { legacy });
  if (movement.intentHash) return movement.intentHash === expectedHash;
  return (
    idString(movement.branch) === idString(input.branch)
    && idString(movement.product) === idString(input.product)
    && idString(movement.warehouse) === idString(input.warehouse)
    && String(movement.shade || '') === String(input.shade || '')
    && String(movement.batch || '') === String(input.batch || '')
    && movement.movementType === input.movementType
    && movement.phase === input.phase
    && idString(movement.sourceId) === idString(input.sourceId)
    && String(movement.sourceLineId) === String(input.sourceLineId || asId(input.sourceId))
    && STOCK_BUCKET_FIELDS.every(field => Math.abs(Number(movement.deltas?.[field] || 0) - deltas[field]) <= EPSILON)
  );
};

async function findReplay(input, deltas, session) {
  let query = StockMovement.findOne({ operationKey: input.operationKey });
  if (session) query = query.session(session);
  const movement = await query;
  if (!movement) return null;
  if (!sameReplay(movement, input, deltas)) {
    throw serviceError(409, 'The operationKey was already used for a different stock movement.');
  }
  let stockQuery = Stock.findById(movement.stock);
  if (session) stockQuery = stockQuery.session(session);
  return { replayed: true, movement, stock: await stockQuery };
}

async function applyWithSession(input, session) {
  if (!session) throw serviceError(500, 'Stock mutation requires an active transaction session.');
  const operationKey = String(input.operationKey || '').trim();
  const correlationKey = String(input.correlationKey || operationKey).trim();
  if (!operationKey || operationKey.length > 500 || !correlationKey || correlationKey.length > 500) {
    throw serviceError(422, 'Valid operationKey and correlationKey values are required.');
  }
  if (!input.branch || !input.product || !input.warehouse) {
    throw serviceError(422, 'branch, product, and warehouse are required for stock movement.');
  }
  const deltas = normalizeStockDeltas(input.deltas, { allowZero: Boolean(input.allowZeroDeltas) });
  const normalizedIntent = { ...input, operationKey, correlationKey };
  const intentHash = stockMovementIntentHash(normalizedIntent, deltas);
  const replay = await findReplay(normalizedIntent, deltas, session);
  if (replay) return replay;

  const exactKey = {
    branch: asId(input.branch),
    product: asId(input.product),
    warehouse: asId(input.warehouse),
    shade: String(input.shade || ''),
    batch: String(input.batch || ''),
  };
  const negativeFields = STOCK_BUCKET_FIELDS.filter(field => deltas[field] < -EPSILON);
  if (input.upsert && negativeFields.length) {
    throw serviceError(409, 'A missing stock bucket cannot be created by a negative movement.');
  }
  const minimums = { ...(input.minimums || {}) };
  for (const [field, value] of Object.entries(minimums)) {
    if (!STOCK_BUCKET_FIELDS.includes(field) || !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw serviceError(422, 'Stock minimum guards must use known bucket fields and finite nonnegative values.');
    }
  }
  const guards = [
    ...negativeFields.map(field => ({ $gte: [{ $ifNull: [`$${field}`, 0] }, Math.abs(deltas[field])] })),
    ...Object.entries(minimums).map(([field, value]) => ({ $gte: [{ $ifNull: [`$${field}`, 0] }, Number(value)] })),
  ];
  const filter = guards.length ? { ...exactKey, $expr: guards.length === 1 ? guards[0] : { $and: guards } } : exactKey;
  const stockSet = { ...(input.stockSet || {}) };
  for (const field of ['_id', 'branch', 'product', 'warehouse', 'shade', 'batch', ...STOCK_BUCKET_FIELDS]) delete stockSet[field];
  const increment = Object.fromEntries(STOCK_BUCKET_FIELDS.filter(field => Math.abs(deltas[field]) > EPSILON).map(field => [field, deltas[field]]));
  const hasDelta = Object.keys(increment).length > 0;
  let stock;
  if (!hasDelta) {
    stock = await Stock.findOne(exactKey).session(session);
  } else {
    const update = {
      $inc: increment,
      ...(Object.keys(stockSet).length ? { $set: stockSet } : {}),
      ...(input.upsert ? { $setOnInsert: { ...exactKey, baseUnit: normalizeUom(input.baseUnit || input.enteredUnit || 'Unit'), uomVersion: Number(input.uomVersion || 1) } } : {}),
    };
    try {
      stock = await Stock.findOneAndUpdate(filter, update, {
        new: true,
        upsert: Boolean(input.upsert),
        session,
        runValidators: true,
        setDefaultsOnInsert: true,
      });
    } catch (error) {
      if (error.code === 11000 && input.upsert) {
        throw serviceError(409, 'The stock bucket was created concurrently; retry the operation.');
      }
      throw error;
    }
  }
  if (!stock) throw serviceError(409, input.guardMessage || 'Stock is missing or changed; movement was not applied.');

  const after = stockSnapshot(stock);
  const before = subtractDeltas(after, deltas);
  for (const field of STOCK_BUCKET_FIELDS) {
    if (deltas[field] && after[field] < -EPSILON) throw serviceError(409, `${field} cannot become negative.`);
  }
  const enteredQuantity = Number(input.enteredQuantity ?? Math.max(...STOCK_BUCKET_FIELDS.map(field => Math.abs(deltas[field]))));
  const conversionFactor = Number(input.conversionFactor ?? 1);
  const baseQuantity = Number(input.baseQuantity ?? enteredQuantity * conversionFactor);
  const uomVersion = Number(input.uomVersion || 1);
  const enteredUnit = normalizeUom(input.enteredUnit || input.baseUnit || 'Unit');
  const baseUnit = normalizeUom(input.baseUnit || input.enteredUnit || 'Unit');
  const movementMagnitude = Math.max(...STOCK_BUCKET_FIELDS.map(field => Math.abs(deltas[field])));
  if (!Number.isFinite(enteredQuantity) || enteredQuantity < 0 || !Number.isFinite(conversionFactor) || conversionFactor <= 0
      || !Number.isFinite(baseQuantity) || baseQuantity < 0 || !Number.isInteger(uomVersion) || uomVersion < 1) {
    throw serviceError(422, 'Entered/base quantities and conversionFactor must be finite; conversionFactor and uomVersion must be positive.');
  }
  if (Math.abs(baseQuantity - round(enteredQuantity * conversionFactor)) > 1e-6) {
    throw serviceError(422, 'baseQuantity must equal enteredQuantity multiplied by conversionFactor.');
  }
  if (!['physical_count', 'physical_audit', 'physical_audit_reversal'].includes(input.movementType) && movementMagnitude - baseQuantity > 1e-6) {
    throw serviceError(422, 'Stock bucket deltas cannot exceed the recorded baseQuantity.');
  }
  const sourceId = asId(input.sourceId);
  if (!sourceId || !mongoose.isValidObjectId(sourceId)) throw serviceError(422, 'A valid sourceId is required.');

  let movement;
  try {
    [movement] = await StockMovement.create([{
    operationKey,
    intentHash,
    intentHashVersion: 2,
    correlationKey,
    movementType: input.movementType,
    phase: input.phase,
    ...exactKey,
    stock: stock._id,
    deltas,
    before,
    after,
    enteredQuantity: round(enteredQuantity),
    enteredUnit,
    baseQuantity: round(baseQuantity),
    baseUnit,
    conversionFactor,
    uomVersion,
    sourceType: input.sourceType,
    sourceModel: String(input.sourceModel || input.sourceType || ''),
    sourceId,
    sourceLineId: String(input.sourceLineId || sourceId),
    sourceNumber: String(input.sourceNumber || ''),
    relatedBranch: asId(input.relatedBranch) || undefined,
    relatedWarehouse: asId(input.relatedWarehouse) || undefined,
    actor: asId(input.actor) || undefined,
    occurredAt: input.occurredAt || new Date(),
    recordedAt: new Date(),
    reason: String(input.reason || ''),
    remarks: String(input.remarks || ''),
    provenance: input.provenance || 'prospective',
    confidence: input.confidence || 'exact',
    reversalOf: asId(input.reversalOf) || undefined,
    reversalOfOperationKey: String(input.reversalOfOperationKey || ''),
    metadata: input.metadata || {},
    }], { session });
  } catch (error) {
    if (error.code === 11000) throw serviceError(409, 'A concurrent duplicate stock operation was aborted safely; retry to replay it.');
    throw error;
  }
  return { replayed: false, movement, stock };
}

export async function applyStockMovement(input, { session = null } = {}) {
  if (session) return applyWithSession(input, session);
  const ownSession = await mongoose.startSession();
  try {
    let result;
    await ownSession.withTransaction(async () => { result = await applyWithSession(input, ownSession); });
    return result;
  } catch (error) {
    if (error.code === 11000) {
      const deltas = normalizeStockDeltas(input.deltas, { allowZero: Boolean(input.allowZeroDeltas) });
      const replay = await findReplay(input, deltas, null);
      if (replay) return replay;
    }
    throw error;
  } finally {
    await ownSession.endSession();
  }
}

const validId = (value, name) => {
  if (!mongoose.isValidObjectId(value)) throw serviceError(422, `${name} must be a valid identifier.`);
  return new mongoose.Types.ObjectId(String(value));
};
const finiteFilter = (value, name) => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw serviceError(422, `${name} must be finite.`);
  return parsed;
};
const validDate = (value, name, endOfDay = false) => {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw serviceError(422, `${name} must be a valid date.`);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) date.setUTCHours(23, 59, 59, 999);
  return date;
};
export const pagination = query => {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw serviceError(422, 'page and limit must be integers; limit must be between 1 and 200.');
  }
  return { page, limit };
};
const listFilter = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

export async function listStocks(branchId, query = {}) {
  const { page, limit } = pagination(query);
  const match = { branch: validId(branchId, 'branch') };
  for (const [field, name] of [['product', 'product'], ['warehouse', 'warehouse']]) {
    if (query[field]) match[field] = validId(query[field], name);
  }
  if (query.shade !== undefined) match.shade = String(query.shade);
  if (query.batch !== undefined) match.batch = String(query.batch);
  const updatedFrom = validDate(query.updatedFrom || query.dateFrom, 'updatedFrom');
  const updatedTo = validDate(query.updatedTo || query.dateTo, 'updatedTo', true);
  if (updatedFrom || updatedTo) match.updatedAt = { ...(updatedFrom ? { $gte: updatedFrom } : {}), ...(updatedTo ? { $lte: updatedTo } : {}) };

  const pipeline = [
    { $match: match },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'warehouses', localField: 'warehouse', foreignField: '_id', as: 'warehouse' } },
    { $unwind: { path: '$warehouse', preserveNullAndEmptyArrays: true } },
  ];
  const joinedMatch = {};
  if (query.search) {
    if (String(query.search).length > 200) throw serviceError(422, 'search is too long.');
    const regex = new RegExp(escapeRegex(query.search), 'i');
    joinedMatch.$or = [
      { 'product.productCode': regex }, { 'product.itemName': regex }, { 'product.aliasName': regex },
      { 'warehouse.name': regex }, { 'warehouse.warehouseCode': regex }, { shade: regex }, { batch: regex },
    ];
  }
  if (query.brand) joinedMatch['product.brand'] = validId(query.brand, 'brand');
  if (query.category) joinedMatch['product.category'] = validId(query.category, 'category');
  if (Object.keys(joinedMatch).length) pipeline.push({ $match: joinedMatch });
  pipeline.push({ $addFields: {
    valuationRate: { $cond: [{ $gt: [{ $ifNull: ['$landingCost', 0] }, 0] }, '$landingCost', { $ifNull: ['$purchaseRate', 0] }] },
    stockValue: { $multiply: ['$totalQty', { $cond: [{ $gt: [{ $ifNull: ['$landingCost', 0] }, 0] }, '$landingCost', { $ifNull: ['$purchaseRate', 0] }] }] },
  } });

  const quantityField = STOCK_BUCKET_FIELDS.includes(query.quantityField) ? query.quantityField : 'totalQty';
  if (query.quantityField && !STOCK_BUCKET_FIELDS.includes(query.quantityField)) throw serviceError(422, 'quantityField is not supported.');
  const minQty = finiteFilter(query.minQty, 'minQty');
  const maxQty = finiteFilter(query.maxQty, 'maxQty');
  const minValue = finiteFilter(query.minValue, 'minValue');
  const maxValue = finiteFilter(query.maxValue, 'maxValue');
  if (minQty !== undefined && maxQty !== undefined && minQty > maxQty) throw serviceError(422, 'minQty cannot exceed maxQty.');
  if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) throw serviceError(422, 'minValue cannot exceed maxValue.');
  if (minQty !== undefined || maxQty !== undefined) pipeline.push({ $match: { [quantityField]: { ...(minQty !== undefined ? { $gte: minQty } : {}), ...(maxQty !== undefined ? { $lte: maxQty } : {}) } } });
  if (minValue !== undefined || maxValue !== undefined) pipeline.push({ $match: { stockValue: { ...(minValue !== undefined ? { $gte: minValue } : {}), ...(maxValue !== undefined ? { $lte: maxValue } : {}) } } });

  const statusExpressions = {
    in_stock: { $gt: ['$availableQty', { $ifNull: ['$product.reorderLevel', 0] }] },
    low_stock: { $and: [{ $gt: ['$availableQty', 0] }, { $lte: ['$availableQty', { $ifNull: ['$product.reorderLevel', 0] }] }] },
    out_of_stock: { $lte: ['$availableQty', 0] },
    reserved: { $gt: ['$reservedQty', 0] },
    damaged: { $gt: ['$damagedQty', 0] },
    blocked: { $gt: ['$blockedQty', 0] },
    in_transit: { $gt: ['$transitQty', 0] },
    short: { $gt: ['$shortQty', 0] },
  };
  const statuses = listFilter(query.status || query.availability);
  if (statuses.some(status => !statusExpressions[status])) throw serviceError(422, 'Unsupported stock status filter.');
  if (statuses.length) pipeline.push({ $match: { $expr: statuses.length === 1 ? statusExpressions[statuses[0]] : { $or: statuses.map(status => statusExpressions[status]) } } });

  const sortFields = { updatedAt: 'updatedAt', createdAt: 'createdAt', totalQty: 'totalQty', availableQty: 'availableQty', reservedQty: 'reservedQty', damagedQty: 'damagedQty', transitQty: 'transitQty', shortQty: 'shortQty', stockValue: 'stockValue', productName: 'product.itemName', warehouseName: 'warehouse.name' };
  const sortBy = query.sortBy || 'updatedAt';
  if (!sortFields[sortBy]) throw serviceError(422, 'Unsupported sortBy value.');
  const sortOrder = query.sortOrder === 'asc' ? 1 : query.sortOrder === 'desc' || !query.sortOrder ? -1 : null;
  if (!sortOrder) throw serviceError(422, 'sortOrder must be asc or desc.');
  const [result] = await Stock.aggregate([...pipeline, { $facet: {
    data: [{ $sort: { [sortFields[sortBy]]: sortOrder, _id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
    totals: [{ $group: { _id: null, rows: { $sum: 1 }, ...Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, { $sum: `$${field}` }])), totalValue: { $sum: '$stockValue' } } }],
  } }]);
  const totals = result?.totals?.[0] || { rows: 0, ...Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, 0])), totalValue: 0 };
  return { data: result?.data || [], totals, pagination: { currentPage: page, totalPages: Math.ceil(totals.rows / limit), totalItems: totals.rows, itemsPerPage: limit } };
}

export async function getStockSummary(branchId) {
  const branch = validId(branchId, 'branch');
  const [summary] = await Stock.aggregate([
    { $match: { branch } },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    { $addFields: { rate: { $cond: [{ $gt: [{ $ifNull: ['$landingCost', 0] }, 0] }, '$landingCost', { $ifNull: ['$purchaseRate', 0] }] } } },
    { $group: {
      _id: null,
      ...Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, { $sum: `$${field}` }])),
      totalValue: { $sum: { $multiply: ['$totalQty', '$rate'] } },
      availableValue: { $sum: { $multiply: ['$availableQty', '$rate'] } },
      skuBuckets: { $sum: 1 }, products: { $addToSet: '$product._id' }, warehouses: { $addToSet: '$warehouse' },
      inStockCount: { $sum: { $cond: [{ $gt: ['$availableQty', { $ifNull: ['$product.reorderLevel', 0] }] }, 1, 0] } },
      lowStockCount: { $sum: { $cond: [{ $and: [{ $gt: ['$availableQty', 0] }, { $lte: ['$availableQty', { $ifNull: ['$product.reorderLevel', 0] }] }] }, 1, 0] } },
      outOfStockCount: { $sum: { $cond: [{ $lte: ['$availableQty', 0] }, 1, 0] } },
      reservedCount: { $sum: { $cond: [{ $gt: ['$reservedQty', 0] }, 1, 0] } },
      damagedCount: { $sum: { $cond: [{ $gt: ['$damagedQty', 0] }, 1, 0] } },
      transitCount: { $sum: { $cond: [{ $gt: ['$transitQty', 0] }, 1, 0] } },
      shortCount: { $sum: { $cond: [{ $gt: ['$shortQty', 0] }, 1, 0] } },
    } },
    { $project: { _id: 0, ...Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, 1])), totalValue: 1, availableValue: 1, skuBuckets: 1, uniqueProducts: { $size: '$products' }, warehouseCount: { $size: '$warehouses' }, inStockCount: 1, lowStockCount: 1, outOfStockCount: 1, reservedCount: 1, damagedCount: 1, transitCount: 1, shortCount: 1 } },
  ]);
  return summary || { ...Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, 0])), totalValue: 0, availableValue: 0, skuBuckets: 0, uniqueProducts: 0, warehouseCount: 0, inStockCount: 0, lowStockCount: 0, outOfStockCount: 0, reservedCount: 0, damagedCount: 0, transitCount: 0, shortCount: 0 };
}

async function buildMovementFilter(branchId, query = {}, exactStockId = null) {
  const filter = { branch: validId(branchId, 'branch') };
  if (exactStockId) filter.stock = validId(exactStockId, 'stock');
  for (const [field, name] of [['product', 'product'], ['warehouse', 'warehouse'], ['sourceId', 'sourceId'], ['actor', 'actor']]) {
    if (query[field]) filter[field] = validId(query[field], name);
  }
  if (query.shade !== undefined) filter.shade = String(query.shade);
  if (query.batch !== undefined) filter.batch = String(query.batch);
  for (const [field, allowed] of [['movementType', STOCK_MOVEMENT_TYPES], ['sourceType', STOCK_SOURCE_TYPES]]) {
    const values = listFilter(query[field]);
    if (values.some(value => !allowed.includes(value))) throw serviceError(422, `Unsupported ${field}.`);
    if (values.length) filter[field] = values.length === 1 ? values[0] : { $in: values };
  }
  if (query.sourceNumber) filter.sourceNumber = new RegExp(escapeRegex(query.sourceNumber), 'i');
  const from = validDate(query.dateFrom, 'dateFrom');
  const to = validDate(query.dateTo, 'dateTo', true);
  if (from || to) filter.occurredAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const deltaField = query.deltaField || 'totalQty';
  if (!STOCK_BUCKET_FIELDS.includes(deltaField)) throw serviceError(422, 'Unsupported deltaField.');
  const minDelta = finiteFilter(query.minDelta ?? query.minQuantity, 'minDelta');
  const maxDelta = finiteFilter(query.maxDelta ?? query.maxQuantity, 'maxDelta');
  if (minDelta !== undefined && maxDelta !== undefined && minDelta > maxDelta) throw serviceError(422, 'minDelta cannot exceed maxDelta.');
  if (minDelta !== undefined || maxDelta !== undefined) filter[`deltas.${deltaField}`] = { ...(minDelta !== undefined ? { $gte: minDelta } : {}), ...(maxDelta !== undefined ? { $lte: maxDelta } : {}) };
  if (query.direction === 'inbound') filter[`deltas.${deltaField}`] = { ...(filter[`deltas.${deltaField}`] || {}), $gt: 0 };
  else if (query.direction === 'outbound') filter[`deltas.${deltaField}`] = { ...(filter[`deltas.${deltaField}`] || {}), $lt: 0 };
  else if (query.direction && query.direction !== 'all') throw serviceError(422, 'direction must be inbound, outbound, or all.');

  if (query.search) {
    const search = String(query.search).trim();
    if (search.length > 200) throw serviceError(422, 'search is too long.');
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      const products = await Product.find({ $or: [{ productCode: regex }, { itemName: regex }, { aliasName: regex }] }).select('_id').lean();
      filter.$and = [...(filter.$and || []), { $or: [
        ...(products.length ? [{ product: { $in: products.map(product => product._id) } }] : []),
        { sourceNumber: regex }, { shade: regex }, { batch: regex },
      ] }];
    }
  }
  return filter;
}

export async function listMovements(branchId, query = {}, exactStockId = null) {
  const { page, limit } = pagination(query);
  const filter = await buildMovementFilter(branchId, query, exactStockId);
  const sortFields = ['occurredAt', 'recordedAt', 'enteredQuantity', ...STOCK_BUCKET_FIELDS.map(field => `deltas.${field}`)];
  const sortBy = query.sortBy || 'occurredAt';
  if (!sortFields.includes(sortBy)) throw serviceError(422, 'Unsupported movement sortBy.');
  const sortOrder = query.sortOrder === 'asc' ? 1 : query.sortOrder === 'desc' || !query.sortOrder ? -1 : null;
  if (!sortOrder) throw serviceError(422, 'sortOrder must be asc or desc.');
  const [data, total] = await Promise.all([
    StockMovement.find(filter).sort({ [sortBy]: sortOrder, _id: sortOrder }).skip((page - 1) * limit).limit(limit)
      .populate({ path: 'product', populate: [{ path: 'brand', select: 'name code status' }, { path: 'category', select: 'name code status' }, { path: 'subcategory', select: 'name code status' }] })
      .populate('warehouse')
      .populate('relatedWarehouse')
      .populate('actor', 'name email role').lean(),
    StockMovement.countDocuments(filter),
  ]);
  return { data, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, itemsPerPage: limit } };
}

export async function movementSummary(branchId, query = {}) {
  const filter = await buildMovementFilter(branchId, query);
  const bucket = ['day', 'week', 'month'].includes(query.bucket) ? query.bucket : 'day';
  if (query.bucket && !['day', 'week', 'month'].includes(query.bucket)) throw serviceError(422, 'bucket must be day, week, or month.');
  const [totals, trend, sources] = await Promise.all([
    StockMovement.aggregate([{ $match: filter }, { $group: { _id: null,
      inboundPhysical: { $sum: { $cond: [{ $gt: ['$deltas.totalQty', 0] }, '$deltas.totalQty', 0] } },
      outboundPhysical: { $sum: { $cond: [{ $lt: ['$deltas.totalQty', 0] }, { $abs: '$deltas.totalQty' }, 0] } },
      netPhysical: { $sum: '$deltas.totalQty' }, reservations: { $sum: { $cond: [{ $eq: ['$movementType', 'sales_reservation'] }, '$deltas.reservedQty', 0] } },
      releases: { $sum: { $cond: [{ $in: ['$movementType', ['sales_reservation_release', 'pick_short_release']] }, '$deltas.availableQty', 0] } },
      damage: { $sum: '$deltas.damagedQty' },
      damageAdded: { $sum: { $cond: [{ $gt: ['$deltas.damagedQty', 0] }, '$deltas.damagedQty', 0] } },
      damageRemoved: { $sum: { $cond: [{ $lt: ['$deltas.damagedQty', 0] }, { $abs: '$deltas.damagedQty' }, 0] } },
      transit: { $sum: '$deltas.transitQty' }, returns: { $sum: { $cond: [{ $in: ['$movementType', ['purchase_return', 'purchase_return_reversal', 'sales_return', 'sales_return_reversal']] }, '$deltas.totalQty', 0] } },
      adjustments: { $sum: { $cond: [{ $in: ['$movementType', ['manual_adjustment', 'stock_adjustment', 'stock_adjustment_reversal']] }, '$deltas.totalQty', 0] } },
      counts: { $sum: { $cond: [{ $in: ['$movementType', ['physical_count', 'physical_audit', 'physical_audit_reversal']] }, '$deltas.totalQty', 0] } }, movements: { $sum: 1 },
    } }]),
    StockMovement.aggregate([{ $match: filter }, { $group: { _id: { $dateTrunc: { date: '$occurredAt', unit: bucket } }, inbound: { $sum: { $cond: [{ $gt: ['$deltas.totalQty', 0] }, '$deltas.totalQty', 0] } }, outbound: { $sum: { $cond: [{ $lt: ['$deltas.totalQty', 0] }, { $abs: '$deltas.totalQty' }, 0] } }, net: { $sum: '$deltas.totalQty' } } }, { $sort: { _id: 1 } }]),
    StockMovement.aggregate([{ $match: filter }, { $group: { _id: '$sourceType', count: { $sum: 1 }, netPhysical: { $sum: '$deltas.totalQty' } } }, { $sort: { count: -1, _id: 1 } }]),
  ]);
  return { ...(totals[0] || { inboundPhysical: 0, outboundPhysical: 0, netPhysical: 0, reservations: 0, releases: 0, damage: 0, damageAdded: 0, damageRemoved: 0, transit: 0, returns: 0, adjustments: 0, counts: 0, movements: 0 }), sourceCounts: sources, trend };
}

export async function reconcileStockBucket(stock) {
  const [journal] = await StockMovement.aggregate([
    { $match: { stock: stock._id } },
    { $facet: {
      grouped: [{ $group: { _id: '$provenance', ...Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, { $sum: `$deltas.${field}` }])), firstMovement: { $min: '$occurredAt' }, lastMovement: { $max: '$occurredAt' }, count: { $sum: 1 } } }],
      earliestProspective: [{ $match: { provenance: 'prospective' } }, { $sort: { recordedAt: 1, _id: 1 } }, { $limit: 1 }, { $project: { before: 1, recordedAt: 1, occurredAt: 1 } }],
    } },
  ]);
  const grouped = journal?.grouped || [];
  const earliestProspective = journal?.earliestProspective?.[0] || null;
  const residual = grouped.find(row => row._id === 'migration_residual');
  const nonResidual = grouped.filter(row => row._id !== 'migration_residual');
  const journalWithoutOpening = Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(nonResidual.reduce((sum, row) => sum + Number(row[field] || 0), 0))]));
  const current = stockSnapshot(stock);
  const estimatedLegacyOpeningBalance = Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(current[field] - journalWithoutOpening[field])]));
  const hasJournalZeroOpening = !residual && earliestProspective
    && STOCK_BUCKET_FIELDS.every(field => Math.abs(Number(earliestProspective.before?.[field] || 0)) <= EPSILON);
  const legacyOpeningBalance = residual
    ? Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(residual[field] || 0)]))
    : hasJournalZeroOpening ? stockSnapshot() : null;
  const expected = legacyOpeningBalance
    ? Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(legacyOpeningBalance[field] + journalWithoutOpening[field])]))
    : null;
  const differences = expected
    ? Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(current[field] - expected[field])]))
    : null;
  const hasBaseline = Boolean(residual || hasJournalZeroOpening);
  const reconciled = hasBaseline ? STOCK_BUCKET_FIELDS.every(field => Math.abs(differences[field]) <= EPSILON) : null;
  return {
    current,
    journalWithoutOpening,
    legacyOpeningBalance,
    estimatedLegacyOpeningBalance,
    legacyOpeningSource: residual ? 'migration_residual' : hasJournalZeroOpening ? 'journal_zero_opening' : 'baseline_missing',
    expected,
    differences,
    reconciliationStatus: hasBaseline ? (reconciled ? 'reconciled' : 'mismatch') : 'baseline_missing',
    reconciled,
    movementCount: grouped.reduce((sum, row) => sum + row.count, 0),
    firstMovement: grouped.reduce((value, row) => !value || (row.firstMovement && row.firstMovement < value) ? row.firstMovement : value, null),
    lastMovement: grouped.reduce((value, row) => !value || (row.lastMovement && row.lastMovement > value) ? row.lastMovement : value, null),
  };
}

export { STOCK_BUCKET_FIELDS, STOCK_MOVEMENT_TYPES, STOCK_SOURCE_TYPES, serviceError as stockMovementError };
