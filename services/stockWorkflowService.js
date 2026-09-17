import crypto from 'crypto';
import mongoose from 'mongoose';
import ApprovalRequest from '../models/ApprovalRequest.js';
import PhysicalStockAudit from '../models/PhysicalStockAudit.js';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import StockAdjustment, { STOCK_ADJUSTMENT_OPERATIONS } from '../models/StockAdjustment.js';
import StockMovement, { STOCK_BUCKET_FIELDS } from '../models/StockMovement.js';
import Warehouse from '../models/Warehouse.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { applyStockMovement, stockSnapshot } from './stockMovementService.js';
import { resolveStockUom } from './stockUomService.js';

const EPSILON = 1e-6;
const ADJUSTMENT_MAX_LINES = 200;
const AUDIT_MAX_LINES = 2000;
const asId = (value) => value?._id || value;
const id = (value) => String(asId(value) || '');
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
export const workflowError = (status, message, details) => Object.assign(new Error(message), { status, details });

const canonical = (value) => {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (mongoose.isValidObjectId(value) && value._bsontype === 'ObjectId') return String(value);
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
export const workflowFingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const zeroVector = () => Object.fromEntries(STOCK_BUCKET_FIELDS.map((field) => [field, 0]));

export function adjustmentVector(operation, quantity, scrapSource = '') {
  const q = round(quantity);
  if (!STOCK_ADJUSTMENT_OPERATIONS.includes(operation)) throw workflowError(422, `Unsupported adjustment operation: ${operation}.`);
  if (!Number.isFinite(q) || q <= 0) throw workflowError(422, 'Adjustment quantity must be a positive finite number.');
  const vector = zeroVector();
  const pair = (from, to) => { vector[from] = -q; vector[to] = q; };
  if (['add', 'found', 'opening_correction'].includes(operation)) { vector.totalQty = q; vector.availableQty = q; }
  else if (['remove', 'loss'].includes(operation)) { vector.totalQty = -q; vector.availableQty = -q; }
  else if (operation === 'reclassify_damaged') pair('availableQty', 'damagedQty');
  else if (operation === 'restore_damaged') pair('damagedQty', 'availableQty');
  else if (operation === 'reclassify_blocked') pair('availableQty', 'blockedQty');
  else if (operation === 'release_blocked') pair('blockedQty', 'availableQty');
  else if (operation === 'issue_sample') pair('availableQty', 'sampleQty');
  else if (operation === 'return_sample') pair('sampleQty', 'availableQty');
  else {
    if (!['damagedQty', 'blockedQty', 'sampleQty'].includes(scrapSource)) {
      throw workflowError(422, 'Scrap requires scrapSource damagedQty, blockedQty, or sampleQty.');
    }
    vector.totalQty = -q;
    vector[scrapSource] = -q;
  }
  return vector;
}

export function verifyCanonicalAdjustmentVector(operation, quantity, vector, scrapSource = '') {
  const expected = adjustmentVector(operation, quantity, scrapSource);
  const actual = Object.fromEntries(STOCK_BUCKET_FIELDS.map((field) => [field, round(Number(vector?.[field] || 0))]));
  if (STOCK_BUCKET_FIELDS.some((field) => Math.abs(expected[field] - actual[field]) > EPSILON)) {
    throw workflowError(422, 'Adjustment deltas do not match the canonical operation vector.');
  }
  return expected;
}

const exactKey = (line, branch) => ({
  branch: asId(branch), product: asId(line.product), warehouse: asId(line.warehouse),
  shade: String(line.shade || ''), batch: String(line.batch || ''),
});
const sameSnapshot = (left, right) => STOCK_BUCKET_FIELDS.every((field) => Math.abs(Number(left?.[field] || 0) - Number(right?.[field] || 0)) <= EPSILON);
const latestTail = async (stockId, session) => {
  if (!stockId) return { movementId: undefined, operationKey: '', recordedAt: undefined };
  const movement = await StockMovement.findOne({ stock: stockId }).sort({ recordedAt: -1, _id: -1 }).session(session).select('_id operationKey recordedAt').lean();
  return { movementId: movement?._id, operationKey: movement?.operationKey || '', recordedAt: movement?.recordedAt };
};
const sameTail = (left, right) => id(left?.movementId) === id(right?.movementId) && String(left?.operationKey || '') === String(right?.operationKey || '');
const lineRate = (stock, product) => Number(stock?.landingCost || stock?.purchaseRate || product?.landingCost || product?.purchaseRate || product?.basicPrice || 0);
const isPositiveCreation = (deltas) => STOCK_BUCKET_FIELDS.every((field) => Number(deltas[field] || 0) >= -EPSILON);

async function activeWarehouse(branchId, warehouseId, session) {
  const warehouse = await Warehouse.findOne({ _id: warehouseId, branch: branchId, status: 'active' }).session(session).lean();
  if (!warehouse) throw workflowError(422, 'Warehouse must be active and belong to the selected branch.');
  return warehouse;
}
async function activeProduct(productId, session) {
  const product = await Product.findOne({ _id: productId, status: 'active' }).session(session).lean();
  if (!product) throw workflowError(422, 'Product must be active.');
  return product;
}

async function withTransaction(session, work) {
  if (session) return work(session);
  const owned = await mongoose.startSession();
  try {
    let result;
    await owned.withTransaction(async () => { result = await work(owned); });
    return result;
  } finally { await owned.endSession(); }
}

const cleanEvidence = (rows) => (Array.isArray(rows) ? rows.slice(0, 25).map((row) => ({
  ...(row.documentId ? { documentId: row.documentId } : {}), name: String(row.name || ''), type: String(row.type || ''), url: String(row.url || ''),
})) : []);

async function hydrateAdjustmentLines(branchId, lines, session, { submission = false } = {}) {
  if (!Array.isArray(lines) || !lines.length || lines.length > ADJUSTMENT_MAX_LINES) throw workflowError(422, `lines must contain 1 to ${ADJUSTMENT_MAX_LINES} entries.`);
  const hydrated = [];
  for (let index = 0; index < lines.length; index += 1) {
    const input = lines[index] || {};
    if (!input.product || !input.warehouse) throw workflowError(422, `lines[${index}] requires product and warehouse.`);
    const [product] = await Promise.all([activeProduct(input.product, session), activeWarehouse(branchId, input.warehouse, session)]);
    const uom = await resolveStockUom({ product, enteredQuantity: input.enteredQuantity ?? input.quantity, enteredUnit: input.enteredUnit || input.unit || product.unit, session });
    if (uom.baseQuantity <= 0) throw workflowError(422, `lines[${index}] quantity must be greater than zero.`);
    const operation = String(input.operation || '').trim();
    const scrapSource = String(input.scrapSource || '');
    const deltas = adjustmentVector(operation, uom.baseQuantity, scrapSource);
    const stock = await Stock.findOne(exactKey(input, branchId)).session(session);
    if (!stock && !isPositiveCreation(deltas)) throw workflowError(409, `lines[${index}] exact stock bucket does not exist.`);
    const snapshot = stockSnapshot(stock || {});
    const rate = lineRate(stock, product);
    hydrated.push({
      ...(input._id ? { _id: input._id } : {}), product: product._id, warehouse: asId(input.warehouse),
      shade: String(input.shade || ''), batch: String(input.batch || ''), operation, scrapSource,
      ...uom, deltas, stock: stock?._id, beforeSnapshot: snapshot,
      ...(submission ? { submissionSnapshot: snapshot, submissionJournalTail: await latestTail(stock?._id, session) } : {}),
      valuationRate: rate, valueImpact: round(Number(deltas.totalQty || 0) * rate),
    });
  }
  return hydrated;
}

const adjustmentPayload = (document) => ({
  reason: String(document.reason || ''), remarks: String(document.remarks || ''),
  evidence: (document.evidence || []).map((row) => ({ documentId: id(row.documentId), name: String(row.name || ''), type: String(row.type || ''), url: String(row.url || '') })),
  lines: document.lines.map((line) => ({ product: id(line.product), warehouse: id(line.warehouse), shade: String(line.shade || ''), batch: String(line.batch || ''),
    operation: line.operation, scrapSource: line.scrapSource, enteredQuantity: Number(line.enteredQuantity), enteredUnit: line.enteredUnit,
    baseQuantity: Number(line.baseQuantity), baseUnit: line.baseUnit, conversionFactor: Number(line.conversionFactor), uomVersion: Number(line.uomVersion),
    deltas: Object.fromEntries(STOCK_BUCKET_FIELDS.map((field) => [field, Number(line.deltas?.[field] || 0)])) })),
});

async function createApproval({ branchId, type, referenceModel, referenceId, referenceNumber, title, description, actorId, fingerprint, session }) {
  const existing = await ApprovalRequest.findOne({ branch: branchId, type, referenceModel, referenceId, status: 'pending' }).session(session);
  if (existing) {
    if (existing.status !== 'pending') throw workflowError(409, 'This document already has an actioned approval request.');
    existing.title = title; existing.description = description; existing.referenceNumber = referenceNumber;
    existing.requestedBy = actorId; existing.exposureFingerprint = fingerprint; existing.isAutomatic = false;
    await existing.save({ session });
    return existing;
  }
  const requestNumber = await generateBranchNumber(branchId, 'approval', new Date(), { session });
  const [approval] = await ApprovalRequest.create([{
    requestNumber, branch: branchId, type, title, description, referenceModel, referenceId, referenceNumber,
    requestedBy: actorId, status: 'pending', priority: 'normal', exposureFingerprint: fingerprint,
  }], { session });
  return approval;
}

export async function createStockAdjustment({ branchId, actorId, payload, sourceKey = '' }, options = {}) {
  const requestFingerprint = workflowFingerprint(payload || {});
  try {
    return await withTransaction(options.session, async (session) => {
      if (sourceKey) {
        const replay = await StockAdjustment.findOne({ branch: branchId, sourceKey }).session(session);
        if (replay) {
          if (replay.requestFingerprint !== requestFingerprint) throw workflowError(409, 'This source key was already used for a different stock adjustment.');
          return { document: replay, replayed: true };
        }
      }
      const reason = String(payload?.reason || '').trim();
      if (!reason) throw workflowError(422, 'reason is required.');
      const lines = await hydrateAdjustmentLines(branchId, payload.lines, session);
      const adjustmentNumber = await generateBranchNumber(branchId, 'stockAdjustment', new Date(), { session });
      const [document] = await StockAdjustment.create([{
        branch: branchId, adjustmentNumber, reason, remarks: String(payload.remarks || ''), evidence: cleanEvidence(payload.evidence),
        lines, totalValueImpact: round(lines.reduce((sum, line) => sum + line.valueImpact, 0)),
        sourceKey: sourceKey || undefined, requestFingerprint, createdBy: actorId,
      }], { session });
      return { document, replayed: false };
    });
  } catch (error) {
    if (error?.code !== 11000 || !sourceKey || options.session) throw error;
    const replay = await StockAdjustment.findOne({ branch: branchId, sourceKey });
    if (!replay) throw error;
    if (replay.requestFingerprint !== requestFingerprint) throw workflowError(409, 'This source key was already used for a different stock adjustment.');
    return { document: replay, replayed: true };
  }
}

export async function updateStockAdjustment({ branchId, actorId, adjustmentId, payload }, options = {}) {
  return withTransaction(options.session, async (session) => {
    const current = await StockAdjustment.findOne({ _id: adjustmentId, branch: branchId, status: 'draft' }).session(session);
    if (!current) throw workflowError(409, 'Only an existing draft adjustment can be edited.');
    if (id(current.createdBy) !== id(actorId)) throw workflowError(403, 'Only the maker can edit this draft.');
    const reason = String(payload?.reason ?? current.reason).trim();
    if (!reason) throw workflowError(422, 'reason is required.');
    const lines = await hydrateAdjustmentLines(branchId, payload?.lines || current.lines, session);
    current.reason = reason; current.remarks = String(payload?.remarks ?? current.remarks ?? '');
    current.evidence = payload?.evidence === undefined ? current.evidence : cleanEvidence(payload.evidence);
    current.lines = lines; current.totalValueImpact = round(lines.reduce((sum, line) => sum + line.valueImpact, 0));
    await current.save({ session });
    return current;
  });
}

export async function submitStockAdjustment({ branchId, actorId, adjustmentId }, options = {}) {
  return withTransaction(options.session, async (session) => {
    const current = await StockAdjustment.findOne({ _id: adjustmentId, branch: branchId }).session(session);
    if (!current) throw workflowError(404, 'Stock adjustment not found.');
    if (current.status === 'submitted') return current;
    if (current.status !== 'draft') throw workflowError(409, 'Only a draft adjustment can be submitted.');
    const lines = await hydrateAdjustmentLines(branchId, current.lines, session, { submission: true });
    current.lines = lines;
    current.totalValueImpact = round(lines.reduce((sum, line) => sum + line.valueImpact, 0));
    current.submittedFingerprint = workflowFingerprint(adjustmentPayload({ ...current.toObject(), lines }));
    const approval = await createApproval({ branchId, type: 'stock_adjustment', referenceModel: 'StockAdjustment', referenceId: current._id,
      referenceNumber: current.adjustmentNumber, title: `Stock adjustment ${current.adjustmentNumber}`, description: current.reason,
      actorId, fingerprint: current.submittedFingerprint, session });
    current.status = 'submitted'; current.submittedBy = actorId; current.submittedAt = new Date(); current.approvalRequest = approval._id;
    await current.save({ session });
    return current;
  });
}

async function verifyAdjustmentSubmission(document, session) {
  if (workflowFingerprint(adjustmentPayload(document)) !== document.submittedFingerprint) throw workflowError(409, 'Submitted adjustment payload changed after submission.');
  for (let index = 0; index < document.lines.length; index += 1) {
    const line = document.lines[index];
    const stock = await Stock.findOne(exactKey(line, document.branch)).session(session);
    if (id(stock?._id) !== id(line.stock) || !sameSnapshot(stockSnapshot(stock || {}), line.submissionSnapshot)) {
      throw workflowError(409, `Stock changed after submission for line ${index + 1}.`);
    }
    if (!sameTail(await latestTail(stock?._id, session), line.submissionJournalTail)) throw workflowError(409, `Stock journal changed after submission for line ${index + 1}.`);
    verifyCanonicalAdjustmentVector(line.operation, line.baseQuantity, line.deltas, line.scrapSource);
  }
}

const ensureChecker = (document, actorId) => {
  if ([document.createdBy, document.submittedBy].some((maker) => maker && id(maker) === id(actorId))) {
    throw workflowError(403, 'Maker-checker is mandatory; the maker/submitting actor cannot action this document.');
  }
};
const syncApprovalDecision = async (document, status, actorId, remarks, session, approvalRequestId) => {
  const filter = { _id: approvalRequestId || document.approvalRequest, branch: document.branch, status: 'pending' };
  const approval = await ApprovalRequest.findOneAndUpdate(filter, { $set: { status, approvedBy: actorId, approvedAt: new Date(), approvalRemarks: remarks || '' } }, { new: true, session });
  if (!approval) throw workflowError(409, 'Approval request is missing or already actioned.');
  return approval;
};

export async function actionStockAdjustmentApproval({ branchId, actorId, adjustmentId, nextStatus, remarks = '', approvalRequestId }, options = {}) {
  if (!['approved', 'rejected'].includes(nextStatus)) throw workflowError(422, 'Unsupported approval action.');
  return withTransaction(options.session, async (session) => {
    const document = await StockAdjustment.findOne({ _id: adjustmentId, branch: branchId }).session(session);
    if (!document) throw workflowError(404, 'Stock adjustment not found.');
    if (document.status !== 'submitted') throw workflowError(409, 'Only a submitted adjustment can be actioned.');
    ensureChecker(document, actorId);
    if (nextStatus === 'rejected') {
      document.status = 'rejected'; document.rejectedBy = actorId; document.rejectedAt = new Date(); document.rejectionReason = remarks;
      await document.save({ session }); await syncApprovalDecision(document, 'rejected', actorId, remarks, session, approvalRequestId);
      return { document, movements: [], stocks: [] };
    }
    await verifyAdjustmentSubmission(document, session);
    const postingVersion = Number(document.postingVersion || 0) + 1;
    const movements = []; const stocks = [];
    for (const line of document.lines) {
      const operationKey = `${branchId}:stock-adjustment:${document._id}:v${postingVersion}:${line._id}:post`;
      const result = await applyStockMovement({
        operationKey, correlationKey: `${branchId}:stock-adjustment:${document._id}:v${postingVersion}`,
        movementType: 'stock_adjustment', phase: 'posted', branch: branchId, product: line.product, warehouse: line.warehouse,
        shade: line.shade, batch: line.batch, deltas: line.deltas, upsert: isPositiveCreation(line.deltas),
        enteredQuantity: line.enteredQuantity, enteredUnit: line.enteredUnit, baseQuantity: line.baseQuantity, baseUnit: line.baseUnit,
        conversionFactor: line.conversionFactor, uomVersion: line.uomVersion,
        sourceType: 'StockAdjustment', sourceModel: 'StockAdjustment', sourceId: document._id, sourceLineId: line._id, sourceNumber: document.adjustmentNumber,
        actor: actorId, occurredAt: new Date(), reason: document.reason, remarks: document.remarks,
        metadata: { operation: line.operation, scrapSource: line.scrapSource, postingVersion, submittedFingerprint: document.submittedFingerprint },
        guardMessage: 'Stock changed or is insufficient for this adjustment.',
      }, { session });
      line.stock = result.stock._id; line.movement = result.movement._id; line.operationKey = operationKey;
      movements.push(result.movement._id); stocks.push(result.stock._id);
    }
    document.status = 'approved'; document.approvedBy = actorId; document.approvedAt = new Date(); document.approvalReason = remarks; document.postingVersion = postingVersion;
    await document.save({ session }); await syncApprovalDecision(document, 'approved', actorId, remarks, session, approvalRequestId);
    return { document, movements, stocks };
  });
}

export async function reverseStockAdjustment({ branchId, actorId, adjustmentId, reason }, options = {}) {
  return withTransaction(options.session, async (session) => {
    const document = await StockAdjustment.findOne({ _id: adjustmentId, branch: branchId }).session(session);
    if (!document) throw workflowError(404, 'Stock adjustment not found.');
    if (document.status !== 'approved') throw workflowError(409, 'Only an approved adjustment can be reversed.');
    if (!String(reason || '').trim()) throw workflowError(422, 'A reversal reason is required.');
    if ([document.createdBy, document.submittedBy, document.approvedBy].some((actor) => actor && id(actor) === id(actorId))) {
      throw workflowError(403, 'Reversal requires an independent third actor.');
    }
    const movements = []; const stocks = []; const version = Number(document.postingVersion || 1) + 1;
    for (const line of document.lines) {
      const original = await StockMovement.findById(line.movement).session(session);
      if (!original || id(original.sourceId) !== id(document._id)) throw workflowError(409, 'Original posted movement is missing.');
      const operationKey = `${branchId}:stock-adjustment:${document._id}:v${version}:${line._id}:reverse`;
      const deltas = Object.fromEntries(STOCK_BUCKET_FIELDS.map((field) => [field, round(-Number(original.deltas[field] || 0))]));
      const result = await applyStockMovement({
        operationKey, correlationKey: `${branchId}:stock-adjustment:${document._id}:v${version}`, movementType: 'stock_adjustment_reversal', phase: 'reversed',
        branch: branchId, product: original.product, warehouse: original.warehouse, shade: original.shade, batch: original.batch, deltas,
        enteredQuantity: original.enteredQuantity, enteredUnit: original.enteredUnit, baseQuantity: original.baseQuantity, baseUnit: original.baseUnit,
        conversionFactor: original.conversionFactor, uomVersion: original.uomVersion,
        sourceType: 'StockAdjustment', sourceModel: 'StockAdjustment', sourceId: document._id, sourceLineId: line._id, sourceNumber: document.adjustmentNumber,
        actor: actorId, occurredAt: new Date(), reason: String(reason).trim(), reversalOf: original._id, reversalOfOperationKey: original.operationKey,
        metadata: { postingVersion: version, reversesPostingVersion: document.postingVersion }, guardMessage: 'Current stock cannot support the exact reversal.',
      }, { session });
      line.reversalMovement = result.movement._id; line.reversalOperationKey = operationKey; movements.push(result.movement._id); stocks.push(result.stock._id);
    }
    document.status = 'reversed'; document.reversedBy = actorId; document.reversedAt = new Date(); document.reversalReason = String(reason).trim(); document.postingVersion = version;
    await document.save({ session });
    return { document, movements, stocks };
  });
}

async function auditScopeFilter(branchId, warehouseId, scopeFilters = {}, session) {
  const filter = { branch: asId(branchId), warehouse: asId(warehouseId) };
  const suppliedStockIds = Array.isArray(scopeFilters.stockIds) ? scopeFilters.stockIds : [];
  const suppliedProductIds = Array.isArray(scopeFilters.productIds) ? scopeFilters.productIds : [];
  if (suppliedStockIds.some((value) => !mongoose.isValidObjectId(value)) || suppliedProductIds.some((value) => !mongoose.isValidObjectId(value))) {
    throw workflowError(422, 'Audit scope stockIds and productIds must contain only valid identifiers.');
  }
  const stockIds = suppliedStockIds;
  const productIds = suppliedProductIds;
  if (stockIds.length) filter._id = { $in: stockIds };
  if (productIds.length) filter.product = { $in: productIds };
  if (scopeFilters.shade !== undefined && scopeFilters.shade !== '') filter.shade = String(scopeFilters.shade);
  if (scopeFilters.batch !== undefined && scopeFilters.batch !== '') filter.batch = String(scopeFilters.batch);
  if (scopeFilters.brand || scopeFilters.category) {
    const productFilter = { status: 'active', ...(scopeFilters.brand ? { brand: scopeFilters.brand } : {}), ...(scopeFilters.category ? { category: scopeFilters.category } : {}) };
    const products = await Product.find(productFilter).session(session).distinct('_id');
    filter.product = filter.product ? { $in: productIds.filter((value) => products.some((candidate) => id(candidate) === id(value))) } : { $in: products };
  }
  return filter;
}

async function buildAuditLines(branchId, warehouseId, scopeFilters, session) {
  const stocks = await Stock.find(await auditScopeFilter(branchId, warehouseId, scopeFilters, session)).sort({ product: 1, shade: 1, batch: 1 }).limit(AUDIT_MAX_LINES + 1).session(session);
  if (!stocks.length) throw workflowError(422, 'No stock buckets match the selected audit scope.');
  if (stocks.length > AUDIT_MAX_LINES) throw workflowError(422, `Audit scope exceeds the ${AUDIT_MAX_LINES}-line limit; narrow the scope.`);
  const lines = [];
  for (const stock of stocks) {
    const product = await activeProduct(stock.product, session);
    const baselineSnapshot = stockSnapshot(stock);
    const expectedOwnedTotal = round(stock.totalQty); const transitQty = round(stock.transitQty);
    const baseUnit = stock.baseUnit || product.inventoryBaseUom || product.unit || 'Unit';
    lines.push({
      stock: stock._id, product: stock.product, warehouse: stock.warehouse, shade: stock.shade, batch: stock.batch,
      enteredUnit: baseUnit, baseUnit,
      conversionFactor: 1, uomVersion: stock.uomVersion || product.inventoryUomVersion || 1,
      baselineSnapshot, submissionJournalTail: await latestTail(stock._id, session),
      expectedOwnedTotal, transitQty, expectedPhysicalOnPremise: round(expectedOwnedTotal - transitQty),
      valuationRate: lineRate(stock, product), classification: 'not_counted',
    });
  }
  return lines;
}

async function applyCounts(document, counts, actorId, session) {
  if (!Array.isArray(counts)) return;
  const byKey = new Map(document.lines.flatMap((line) => [[id(line._id), line], [id(line.stock), line]]));
  for (let index = 0; index < counts.length; index += 1) {
    const input = counts[index] || {}; const line = byKey.get(id(input.lineId || input.stockId));
    if (!line) throw workflowError(422, `counts[${index}] does not belong to this audit.`);
    const stock = await Stock.findOne(exactKey(line, document.branch)).session(session);
    if (!stock) throw workflowError(409, 'An audited stock bucket no longer exists.');
    if (line.recountRequired) {
      line.baselineSnapshot = stockSnapshot(stock); line.submissionJournalTail = await latestTail(stock._id, session);
      line.expectedOwnedTotal = round(stock.totalQty); line.transitQty = round(stock.transitQty);
      line.expectedPhysicalOnPremise = round(line.expectedOwnedTotal - line.transitQty); line.recountRequired = false; line.recountReason = '';
    }
    const product = await activeProduct(line.product, session);
    const uom = await resolveStockUom({ product, enteredQuantity: input.physicalCount, enteredUnit: input.unit || line.enteredUnit || product.unit, session });
    const variance = round(uom.baseQuantity - line.expectedPhysicalOnPremise);
    line.physicalCount = uom.enteredQuantity; line.physicalBaseQuantity = uom.baseQuantity; line.enteredUnit = uom.enteredUnit; line.baseUnit = uom.baseUnit;
    line.conversionFactor = uom.conversionFactor; line.uomVersion = uom.uomVersion; line.variance = variance;
    line.classification = Math.abs(variance) <= EPSILON ? 'matched' : variance < 0 ? 'short' : 'excess';
    line.countedBy = actorId; line.countedAt = new Date(); line.valueImpact = round(variance * line.valuationRate);
  }
}

function recomputeAuditAggregates(document) {
  document.matchedCount = document.lines.filter((line) => line.classification === 'matched').length;
  document.shortCount = document.lines.filter((line) => line.classification === 'short').length;
  document.excessCount = document.lines.filter((line) => line.classification === 'excess').length;
  document.totalVariance = round(document.lines.reduce((sum, line) => sum + Number(line.variance || 0), 0));
  document.totalValueImpact = round(document.lines.reduce((sum, line) => sum + Number(line.valueImpact || 0), 0));
}

const auditPayload = (document) => ({ warehouse: id(document.warehouse), scope: document.scope, scopeHash: document.scopeHash, remarks: document.remarks,
  lines: document.lines.map((line) => ({ stock: id(line.stock), physicalCount: line.physicalCount, physicalBaseQuantity: line.physicalBaseQuantity,
    enteredUnit: line.enteredUnit, baseUnit: line.baseUnit, conversionFactor: line.conversionFactor, uomVersion: line.uomVersion,
    variance: line.variance, classification: line.classification, expectedPhysicalOnPremise: line.expectedPhysicalOnPremise })) });

export async function createPhysicalStockAudit({ branchId, actorId, payload, sourceKey = '' }, options = {}) {
  const requestFingerprint = workflowFingerprint(payload || {});
  try {
    return await withTransaction(options.session, async (session) => {
      if (sourceKey) {
        const replay = await PhysicalStockAudit.findOne({ branch: branchId, sourceKey }).session(session);
        if (replay) {
          if (replay.requestFingerprint !== requestFingerprint) throw workflowError(409, 'This source key was already used for a different physical audit.');
          return { document: replay, replayed: true };
        }
      }
      const scope = payload?.scope || 'spot_check';
    if (!['full_warehouse', 'cycle_count', 'spot_check'].includes(scope)) throw workflowError(422, 'Unsupported audit scope.');
    if (!payload?.warehouse) throw workflowError(422, 'warehouse is required.');
    await activeWarehouse(branchId, payload.warehouse, session);
    const scopeFilters = scope === 'full_warehouse' ? {} : (payload.scopeFilters || {});
    if (scope !== 'full_warehouse') {
      const hasSupportedFilter = ['brand', 'category', 'shade', 'batch'].some((key) => scopeFilters[key] !== undefined && scopeFilters[key] !== '')
        || (Array.isArray(scopeFilters.stockIds) && scopeFilters.stockIds.length > 0)
        || (Array.isArray(scopeFilters.productIds) && scopeFilters.productIds.length > 0);
      if (!hasSupportedFilter) throw workflowError(422, 'Cycle-count and spot-check audits require at least one explicit supported scope filter.');
    }
    const lines = await buildAuditLines(branchId, payload.warehouse, scopeFilters, session);
    const auditNumber = await generateBranchNumber(branchId, 'physicalStockAudit', new Date(), { session });
    const [document] = await PhysicalStockAudit.create([{
      branch: branchId, auditNumber, warehouse: payload.warehouse, scope, scopeFilters, scopeHash: workflowFingerprint({ warehouse: id(payload.warehouse), scope, scopeFilters }),
      baselineAt: new Date(), lines, remarks: String(payload.remarks || ''), evidence: cleanEvidence(payload.evidence),
      sourceKey: sourceKey || undefined, requestFingerprint, createdBy: actorId,
    }], { session });
    await applyCounts(document, payload.counts || [], actorId, session);
    recomputeAuditAggregates(document);
    await document.save({ session });
      return { document, replayed: false };
    });
  } catch (error) {
    if (error?.code !== 11000 || !sourceKey || options.session) throw error;
    const replay = await PhysicalStockAudit.findOne({ branch: branchId, sourceKey });
    if (!replay) throw error;
    if (replay.requestFingerprint !== requestFingerprint) throw workflowError(409, 'This source key was already used for a different physical audit.');
    return { document: replay, replayed: true };
  }
}

export async function savePhysicalAuditCounts({ branchId, actorId, auditId, counts, remarks }, options = {}) {
  return withTransaction(options.session, async (session) => {
    const document = await PhysicalStockAudit.findOne({ _id: auditId, branch: branchId, status: { $in: ['draft', 'submitted'] } }).session(session);
    if (!document) throw workflowError(409, 'Only a draft audit or submitted audit requiring recount can be counted.');
    const reopening = document.status === 'submitted';
    if (reopening) {
      const requiredIds = document.lines.filter((line) => line.recountRequired).map((line) => id(line._id));
      const suppliedIds = new Set((counts || []).map((row) => id(row.lineId || row.stockId)));
      if (!requiredIds.length || requiredIds.some((lineId) => !suppliedIds.has(lineId))) {
        throw workflowError(409, 'A submitted audit can only be reopened by explicitly recounting every affected line.');
      }
      if ((counts || []).some((row) => !requiredIds.includes(id(row.lineId || row.stockId)))) {
        throw workflowError(422, 'Only recount-required lines may be changed while reopening a submitted audit.');
      }
      await ApprovalRequest.updateOne(
        { _id: document.approvalRequest, branch: branchId, status: 'pending' },
        { $set: { status: 'cancelled', approvalRemarks: 'Cancelled because stock changed and an explicit recount was recorded.' } },
        { session }
      );
      document.status = 'draft'; document.approvalRequest = undefined; document.submittedFingerprint = undefined;
      document.submittedBy = undefined; document.submittedAt = undefined;
    }
    await applyCounts(document, counts, actorId, session);
    if (remarks !== undefined) document.remarks = String(remarks || '');
    recomputeAuditAggregates(document);
    await document.save({ session }); return document;
  });
}

async function auditConflicts(document, session, { compareSubmission = false } = {}) {
  const conflicts = [];
  for (const line of document.lines) {
    const stock = await Stock.findOne(exactKey(line, document.branch)).session(session);
    const expected = compareSubmission ? line.submissionSnapshot : line.baselineSnapshot;
    if (!stock || id(stock._id) !== id(line.stock) || !sameSnapshot(stockSnapshot(stock || {}), expected)
      || !sameTail(await latestTail(stock?._id, session), line.submissionJournalTail)) conflicts.push(line);
  }
  return conflicts;
}

export async function submitPhysicalStockAudit({ branchId, actorId, auditId }, options = {}) {
  let conflictIds = [];
  const document = await withTransaction(options.session, async (session) => {
    const current = await PhysicalStockAudit.findOne({ _id: auditId, branch: branchId }).session(session);
    if (!current) throw workflowError(404, 'Physical audit not found.');
    if (current.status === 'submitted') return current;
    if (current.status !== 'draft') throw workflowError(409, 'Only a draft audit can be submitted.');
    const uncounted = current.lines.filter((line) => line.physicalCount === undefined || line.physicalCount === null);
    if (current.scope === 'full_warehouse' && uncounted.length) throw workflowError(422, 'Every line must be counted for a full-warehouse audit.');
    if (current.lines.length === uncounted.length) throw workflowError(422, 'At least one count is required.');
    recomputeAuditAggregates(current);
    if (current.scope === 'full_warehouse') {
      const scoped = await Stock.find({ branch: branchId, warehouse: current.warehouse }).session(session).distinct('_id');
      const included = new Set(current.lines.map((line) => id(line.stock)));
      if (scoped.length !== included.size || scoped.some((stockId) => !included.has(id(stockId)))) throw workflowError(409, 'Full-warehouse scope changed; create a fresh audit sheet.');
    }
    const conflicts = await auditConflicts(current, session);
    if (conflicts.length) {
      conflictIds = conflicts.map((line) => id(line._id));
      for (const line of conflicts) { line.recountRequired = true; line.recountReason = 'Stock or journal changed after the audit baseline.'; }
      await current.save({ session }); return current;
    }
    for (const line of current.lines) line.submissionSnapshot = stockSnapshot(line.baselineSnapshot);
    current.submittedFingerprint = workflowFingerprint(auditPayload(current));
    const approval = await createApproval({ branchId, type: 'physical_stock_audit', referenceModel: 'PhysicalStockAudit', referenceId: current._id,
      referenceNumber: current.auditNumber, title: `Physical stock audit ${current.auditNumber}`, description: current.remarks || `${current.scope} count`,
      actorId, fingerprint: current.submittedFingerprint, session });
    current.status = 'submitted'; current.submittedBy = actorId; current.submittedAt = new Date(); current.approvalRequest = approval._id;
    await current.save({ session }); return current;
  });
  if (conflictIds.length) throw workflowError(409, 'Stock changed after the audit baseline. Affected lines require an explicit recount.', { recountLineIds: conflictIds });
  return document;
}

export async function actionPhysicalAuditApproval({ branchId, actorId, auditId, nextStatus, remarks = '', approvalRequestId }, options = {}) {
  if (!['approved', 'rejected'].includes(nextStatus)) throw workflowError(422, 'Unsupported approval action.');
  let conflictIds = [];
  const result = await withTransaction(options.session, async (session) => {
    const document = await PhysicalStockAudit.findOne({ _id: auditId, branch: branchId }).session(session);
    if (!document) throw workflowError(404, 'Physical audit not found.');
    if (document.status !== 'submitted') throw workflowError(409, 'Only a submitted audit can be actioned.');
    ensureChecker(document, actorId);
    if (nextStatus === 'approved' && document.lines.some((line) => line.countedBy && id(line.countedBy) === id(actorId))) {
      throw workflowError(403, 'Maker-checker is mandatory; an actor who counted any submitted line cannot approve this audit.');
    }
    if (nextStatus === 'rejected') {
      document.status = 'rejected'; document.rejectedBy = actorId; document.rejectedAt = new Date(); document.rejectionReason = remarks;
      await document.save({ session }); await syncApprovalDecision(document, 'rejected', actorId, remarks, session, approvalRequestId);
      return { document, movements: [], stocks: [] };
    }
    if (workflowFingerprint(auditPayload(document)) !== document.submittedFingerprint) throw workflowError(409, 'Submitted audit payload changed after submission.');
    const conflicts = await auditConflicts(document, session, { compareSubmission: true });
    if (conflicts.length) {
      conflictIds = conflicts.map((line) => id(line._id));
      for (const line of conflicts) { line.recountRequired = true; line.recountReason = 'Stock or journal changed after audit submission.'; }
      await document.save({ session }); return { document, movements: [], stocks: [] };
    }
    const postingVersion = Number(document.postingVersion || 0) + 1; const movements = []; const stocks = [];
    for (const line of document.lines.filter((row) => row.physicalCount !== undefined && row.physicalCount !== null)) {
      const operationKey = `${branchId}:physical-stock-audit:${document._id}:v${postingVersion}:${line._id}:post`;
      const resultLine = await applyStockMovement({
        operationKey, correlationKey: `${branchId}:physical-stock-audit:${document._id}:v${postingVersion}`, movementType: 'physical_audit', phase: 'counted',
        branch: branchId, product: line.product, warehouse: line.warehouse, shade: line.shade, batch: line.batch,
        deltas: { totalQty: line.variance, availableQty: line.variance }, allowZeroDeltas: true,
        enteredQuantity: line.physicalCount, enteredUnit: line.enteredUnit, baseQuantity: line.physicalBaseQuantity, baseUnit: line.baseUnit,
        conversionFactor: line.conversionFactor, uomVersion: line.uomVersion,
        sourceType: 'PhysicalStockAudit', sourceModel: 'PhysicalStockAudit', sourceId: document._id, sourceLineId: line._id, sourceNumber: document.auditNumber,
        actor: actorId, occurredAt: new Date(), reason: 'Approved physical stock audit', remarks: document.remarks,
        metadata: { expectedOwnedTotal: line.expectedOwnedTotal, transitQty: line.transitQty, expectedPhysicalOnPremise: line.expectedPhysicalOnPremise,
          physicalCount: line.physicalCount, physicalBaseQuantity: line.physicalBaseQuantity, classification: line.classification, postingVersion },
        guardMessage: 'Stock changed or classified stock prevents this physical audit posting.',
      }, { session });
      line.movement = resultLine.movement._id; line.operationKey = operationKey; movements.push(resultLine.movement._id); stocks.push(resultLine.stock._id);
    }
    document.status = 'approved'; document.approvedBy = actorId; document.approvedAt = new Date(); document.approvalReason = remarks; document.postingVersion = postingVersion;
    await document.save({ session }); await syncApprovalDecision(document, 'approved', actorId, remarks, session, approvalRequestId);
    return { document, movements, stocks };
  });
  if (conflictIds.length) throw workflowError(409, 'Stock changed after audit submission. Affected lines are marked recount required.', { recountLineIds: conflictIds });
  return result;
}

export async function reversePhysicalStockAudit({ branchId, actorId, auditId, reason }, options = {}) {
  return withTransaction(options.session, async (session) => {
    const document = await PhysicalStockAudit.findOne({ _id: auditId, branch: branchId }).session(session);
    if (!document) throw workflowError(404, 'Physical audit not found.');
    if (document.status !== 'approved') throw workflowError(409, 'Only an approved audit can be reversed.');
    if (!String(reason || '').trim()) throw workflowError(422, 'A reversal reason is required.');
    if ([document.createdBy, document.submittedBy, document.approvedBy].some((actor) => actor && id(actor) === id(actorId))) throw workflowError(403, 'Reversal requires an independent third actor.');
    const version = Number(document.postingVersion || 1) + 1; const movements = []; const stocks = [];
    for (const line of document.lines.filter((row) => row.movement)) {
      const original = await StockMovement.findById(line.movement).session(session);
      if (!original || id(original.sourceId) !== id(document._id)) throw workflowError(409, 'Original audit movement is missing.');
      const operationKey = `${branchId}:physical-stock-audit:${document._id}:v${version}:${line._id}:reverse`;
      const deltas = Object.fromEntries(STOCK_BUCKET_FIELDS.map((field) => [field, round(-Number(original.deltas[field] || 0))]));
      const reversed = await applyStockMovement({
        operationKey, correlationKey: `${branchId}:physical-stock-audit:${document._id}:v${version}`, movementType: 'physical_audit_reversal', phase: 'reversed',
        branch: branchId, product: original.product, warehouse: original.warehouse, shade: original.shade, batch: original.batch, deltas, allowZeroDeltas: true,
        enteredQuantity: original.enteredQuantity, enteredUnit: original.enteredUnit, baseQuantity: original.baseQuantity, baseUnit: original.baseUnit,
        conversionFactor: original.conversionFactor, uomVersion: original.uomVersion,
        sourceType: 'PhysicalStockAudit', sourceModel: 'PhysicalStockAudit', sourceId: document._id, sourceLineId: line._id, sourceNumber: document.auditNumber,
        actor: actorId, occurredAt: new Date(), reason: String(reason).trim(), reversalOf: original._id, reversalOfOperationKey: original.operationKey,
        metadata: { postingVersion: version, reversesPostingVersion: document.postingVersion }, guardMessage: 'Current stock cannot support the exact audit reversal.',
      }, { session });
      line.reversalMovement = reversed.movement._id; line.reversalOperationKey = operationKey; movements.push(reversed.movement._id); stocks.push(reversed.stock._id);
    }
    document.status = 'reversed'; document.reversedBy = actorId; document.reversedAt = new Date(); document.reversalReason = String(reason).trim(); document.postingVersion = version;
    await document.save({ session }); return { document, movements, stocks };
  });
}

const populateDocument = (query, kind) => {
  query.populate('createdBy submittedBy approvedBy rejectedBy reversedBy', 'name email role').populate('approvalRequest');
  if (kind === 'adjustment') query.populate('lines.product', 'productCode itemName unit inventoryBaseUom uomConversions images').populate('lines.warehouse', 'warehouseCode name');
  else query.populate('warehouse', 'warehouseCode name').populate('lines.product', 'productCode itemName unit inventoryBaseUom images').populate('lines.countedBy', 'name email');
  return query;
};
export async function getWorkflowDocument(kind, branchId, documentId) {
  const Model = kind === 'adjustment' ? StockAdjustment : PhysicalStockAudit;
  const document = await populateDocument(Model.findOne({ _id: documentId, branch: branchId }), kind).lean();
  if (!document) throw workflowError(404, 'Document not found.');
  return document;
}
export async function listWorkflowDocuments(kind, branchId, query = {}) {
  const Model = kind === 'adjustment' ? StockAdjustment : PhysicalStockAudit;
  const page = Math.max(1, Number(query.page) || 1); const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const filter = { branch: branchId };
  if (query.status) filter.status = query.status;
  if (kind === 'audit' && query.warehouse) filter.warehouse = query.warehouse;
  if (query.search) {
    const regex = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = kind === 'adjustment' ? [{ adjustmentNumber: regex }, { reason: regex }, { remarks: regex }] : [{ auditNumber: regex }, { remarks: regex }];
  }
  const [data, total] = await Promise.all([
    populateDocument(Model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), kind).lean(),
    Model.countDocuments(filter),
  ]);
  return { data, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, itemsPerPage: limit } };
}
export async function workflowStats(kind, branchId, query = {}) {
  const Model = kind === 'adjustment' ? StockAdjustment : PhysicalStockAudit;
  const filter = { branch: asId(branchId), ...(kind === 'audit' && query.warehouse ? { warehouse: asId(query.warehouse) } : {}) };
  const rows = await Model.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 }, valueImpact: { $sum: '$totalValueImpact' } } }]);
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, { count: row.count, valueImpact: round(row.valueImpact) }]));
  return { total: rows.reduce((sum, row) => sum + row.count, 0), byStatus };
}

export async function createSubmittedLegacyAdjustment({ branchId, actorId, body, idempotencyKey }) {
  const adjustmentType = String(body.adjustmentType || body.type || '').toLowerCase();
  let signed;
  if (body.adjustmentQty !== undefined) signed = Number(body.adjustmentQty);
  else {
    const raw = Number(body.quantity);
    if (['increase', 'add', 'in', 'positive'].includes(adjustmentType)) signed = raw;
    else if (['decrease', 'subtract', 'remove', 'out', 'negative'].includes(adjustmentType)) signed = -raw;
    else throw workflowError(422, 'adjustmentType must identify an increase or decrease.');
  }
  if (!Number.isFinite(signed) || signed === 0) throw workflowError(422, 'A non-zero finite adjustment quantity is required.');
  const operation = signed > 0 ? 'add' : 'remove';
  const payload = { reason: body.reason, remarks: body.remarks || '', lines: [{ product: body.product, warehouse: body.warehouse, shade: body.shade, batch: body.batch,
    operation, quantity: Math.abs(signed), unit: body.unit }] };
  return withTransaction(null, async (session) => {
    const created = await createStockAdjustment({ branchId, actorId, payload, sourceKey: `${branchId}:legacy-stock-adjustment:${idempotencyKey}` }, { session });
    const document = created.document.status === 'draft'
      ? await submitStockAdjustment({ branchId, actorId, adjustmentId: created.document._id }, { session })
      : created.document;
    return { document, replayed: created.replayed };
  });
}
export async function createSubmittedLegacyAudit({ branchId, actorId, body, idempotencyKey }) {
  const stockIds = (body.counts || []).map((count) => count.stockId);
  const payload = { warehouse: body.warehouse, scope: 'spot_check', scopeFilters: { stockIds }, remarks: body.remarks || '', counts: (body.counts || []).map((count) => ({ stockId: count.stockId, physicalCount: count.physicalCount, unit: count.unit || body.unit })) };
  return withTransaction(null, async (session) => {
    const created = await createPhysicalStockAudit({ branchId, actorId, payload, sourceKey: `${branchId}:legacy-physical-audit:${idempotencyKey}` }, { session });
    const document = created.document.status === 'draft'
      ? await submitPhysicalStockAudit({ branchId, actorId, auditId: created.document._id }, { session })
      : created.document;
    return { document, replayed: created.replayed };
  });
}
