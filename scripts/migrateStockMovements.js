import 'dotenv/config';
import mongoose from 'mongoose';
import Stock from '../models/Stock.js';
import StockMovement, { STOCK_BUCKET_FIELDS } from '../models/StockMovement.js';
import { stockMovementIntentHash, stockSnapshot } from '../services/stockMovementService.js';

const knownFlags = new Set(['--dry-run', '--execute']);
const flags = process.argv.slice(2);
const unknownFlags = flags.filter(flag => !knownFlags.has(flag));
if (unknownFlags.length || (flags.includes('--dry-run') && flags.includes('--execute'))) {
  throw new Error('Use either --dry-run or --execute (not both); no other arguments are supported.');
}
const execute = flags.includes('--execute');
const dryRun = !execute;
const round = value => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
const emptySnapshot = () => Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, 0]));
const openingOperationKey = stockId => `migration:stock-opening:${String(stockId)}`;

async function journalNet(stockId, session, { includeResidual = false } = {}) {
  const match = { stock: stockId, ...(includeResidual ? {} : { provenance: { $ne: 'migration_residual' } }) };
  const [row] = await StockMovement.aggregate([
    { $match: match },
    { $group: { _id: null, ...Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, { $sum: `$deltas.${field}` }])), firstOccurredAt: { $min: '$occurredAt' } } },
  ]).session(session);
  return {
    totals: Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(row?.[field] || 0)])),
    firstOccurredAt: row?.firstOccurredAt || null,
  };
}

function residualFor(stock, nonResidualNet) {
  const current = stockSnapshot(stock);
  return Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(current[field] - nonResidualNet[field])]));
}

function movementDocument(stock, residual, firstOccurredAt) {
  const occurredAt = firstOccurredAt
    ? new Date(new Date(firstOccurredAt).getTime() - 1)
    : new Date(stock.createdAt || stock.updatedAt || Date.now());
  const operationKey = openingOperationKey(stock._id);
  const document = {
    operationKey,
    intentHashVersion: 2,
    correlationKey: operationKey,
    movementType: 'migration_opening',
    phase: 'opening',
    branch: stock.branch,
    product: stock.product,
    warehouse: stock.warehouse,
    shade: stock.shade || '',
    batch: stock.batch || '',
    stock: stock._id,
    deltas: residual,
    before: emptySnapshot(),
    after: residual,
    enteredQuantity: Math.max(0, ...STOCK_BUCKET_FIELDS.map(field => Math.abs(residual[field]))),
    enteredUnit: stock.baseUnit || 'Unit',
    baseQuantity: Math.max(0, ...STOCK_BUCKET_FIELDS.map(field => Math.abs(residual[field]))),
    baseUnit: stock.baseUnit || 'Unit',
    conversionFactor: 1,
    uomVersion: Number(stock.uomVersion || 1),
    sourceType: 'Stock',
    sourceModel: 'Stock',
    sourceId: stock._id,
    sourceLineId: String(stock._id),
    sourceNumber: String(stock._id),
    occurredAt,
    recordedAt: new Date(),
    reason: 'Legacy stock opening balance at journal cutover',
    remarks: 'Residual calculated from the same transaction snapshot of current Stock and non-residual journal deltas.',
    provenance: 'migration_residual',
    confidence: 'residual',
    metadata: { migration: 'migrateStockMovements', cutoverRecordedAt: new Date() },
  };
  document.intentHash = stockMovementIntentHash(document, residual);
  return document;
}

const reconciles = (stock, totals) => {
  const current = stockSnapshot(stock);
  return STOCK_BUCKET_FIELDS.every(field => Math.abs(current[field] - totals[field]) <= 1e-6);
};

async function operationKeyIndexState() {
  let indexes = [];
  try {
    indexes = await StockMovement.collection.indexes();
  } catch (error) {
    if (error.code !== 26 && error.codeName !== 'NamespaceNotFound') throw error;
  }
  const duplicates = await StockMovement.aggregate([
    { $match: { operationKey: { $type: 'string' } } },
    { $group: { _id: '$operationKey', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);
  const uniqueIndex = indexes.find(index => index.unique === true
    && Object.keys(index.key || {}).length === 1
    && index.key.operationKey === 1);
  return { duplicates, indexes, ready: Boolean(uniqueIndex), uniqueIndex };
}

async function ensureStockMovementIndexes() {
  let state = await operationKeyIndexState();
  console.log(`StockMovement operationKey unique index ready: ${state.ready ? `yes (${state.uniqueIndex.name})` : 'no'}`);
  if (state.duplicates.length) {
    throw new Error(`operationKey contains duplicate values; first duplicates: ${state.duplicates.map(row => `${row._id} (${row.count})`).join(', ')}`);
  }
  if (!execute) return state;

  // autoIndex is intentionally disabled for the migration connection. Provision every
  // index declared by the model, while accepting an already-valid uniquely named
  // operationKey index instead of attempting an equivalent duplicate definition.
  for (const [keys, options] of StockMovement.schema.indexes()) {
    const isOperationKeyIndex = Object.keys(keys).length === 1 && keys.operationKey === 1;
    if (isOperationKeyIndex && state.ready) continue;
    await StockMovement.collection.createIndex(keys, options);
  }
  state = await operationKeyIndexState();
  if (!state.ready) throw new Error('operationKey unique index creation could not be verified.');
  console.log(`Verified all declared StockMovement indexes and unique operationKey index: ${state.uniqueIndex.name}`);
  return state;
}

async function processBucket(stockId) {
  const session = await mongoose.startSession();
  try {
    let outcome;
    await session.withTransaction(async () => {
      // Stock, journal, optional opening insert, and verification share one snapshot.
      // A concurrent prospective movement is therefore wholly before or after this bucket's cutover.
      const stock = await Stock.findById(stockId).session(session).lean();
      if (!stock) { outcome = { kind: 'missing' }; return; }
      if (!stock.branch || !stock.product || !stock.warehouse) { outcome = { kind: 'failure', message: 'missing branch/product/warehouse identity' }; return; }
      const operationKey = openingOperationKey(stock._id);
      const existing = await StockMovement.findOne({ operationKey }).session(session).lean();
      if (existing) {
        const all = await journalNet(stock._id, session, { includeResidual: true });
        outcome = reconciles(stock, all.totals)
          ? { kind: 'existing' }
          : { kind: 'failure', message: 'existing residual does not reconcile current Stock' };
        return;
      }
      const nonResidual = await journalNet(stock._id, session);
      const residual = residualFor(stock, nonResidual.totals);
      if (execute) await StockMovement.create([movementDocument(stock, residual, nonResidual.firstOccurredAt)], { session });
      const expected = execute
        ? (await journalNet(stock._id, session, { includeResidual: true })).totals
        : Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, round(nonResidual.totals[field] + residual[field])]));
      outcome = reconciles(stock, expected)
        ? { kind: execute ? 'inserted' : 'planned' }
        : { kind: 'failure', message: 'snapshot residual arithmetic did not reconcile' };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return outcome;
  } finally {
    await session.endSession();
  }
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  console.log(`Connected to ${mongoose.connection.name}`);
  console.log(dryRun
    ? `DRY RUN${flags.includes('--dry-run') ? '' : ' (implicit)'}: no documents or indexes will be written. Supply --execute explicitly to create the required unique index and insert residual openings.`
    : 'EXECUTE: verifying/creating the operationKey unique index, then inserting missing deterministic migration residual openings. Stock documents will not be mutated.');

  // Execute must establish uniqueness before the stock cursor can process any bucket.
  // Dry-run performs the same inspection but never creates or changes an index.
  await ensureStockMovementIndexes();

  const stats = { stockBuckets: 0, missingBuckets: 0, residualPlanned: 0, residualInserted: 0, residualExisting: 0, reconciliationFailures: 0 };
  const failures = [];
  const cursor = Stock.find({}).select('_id').sort({ _id: 1 }).lean().cursor();
  for await (const row of cursor) {
    stats.stockBuckets += 1;
    let outcome;
    try {
      outcome = await processBucket(row._id);
    } catch (error) {
      // A concurrent migrator can win the verified unique operation key. Re-read in a fresh snapshot.
      if (error.code === 11000) outcome = await processBucket(row._id);
      else throw error;
    }
    if (outcome?.kind === 'planned') stats.residualPlanned += 1;
    else if (outcome?.kind === 'inserted') { stats.residualPlanned += 1; stats.residualInserted += 1; }
    else if (outcome?.kind === 'existing') stats.residualExisting += 1;
    else if (outcome?.kind === 'missing') stats.missingBuckets += 1;
    else if (outcome?.kind === 'failure') {
      stats.reconciliationFailures += 1;
      failures.push(`${row._id}: ${outcome.message}`);
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  if (failures.length) console.error(`Reconciliation failures (first 50):\n- ${failures.slice(0, 50).join('\n- ')}`);
  if (stats.reconciliationFailures) throw new Error(`${stats.reconciliationFailures} stock bucket(s) failed migration reconciliation checks.`);
  console.log(dryRun ? 'Dry run completed; no writes were made.' : 'Residual opening migration completed idempotently.');
}

run()
  .catch((error) => {
    console.error('Stock movement migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
