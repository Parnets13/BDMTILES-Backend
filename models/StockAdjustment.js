import mongoose from 'mongoose';

export const STOCK_ADJUSTMENT_OPERATIONS = Object.freeze([
  'add', 'found', 'opening_correction', 'remove', 'loss',
  'reclassify_damaged', 'restore_damaged', 'reclassify_blocked', 'release_blocked',
  'issue_sample', 'return_sample', 'scrap',
]);

const STOCK_FIELDS = ['totalQty', 'availableQty', 'reservedQty', 'blockedQty', 'damagedQty', 'sampleQty', 'transitQty', 'shortQty'];
const quantityShape = () => Object.fromEntries(STOCK_FIELDS.map((field) => [field, { type: Number, default: 0, required: true }]));
const snapshotSchema = new mongoose.Schema(quantityShape(), { _id: false, id: false });
const evidenceSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  name: { type: String, trim: true, maxlength: 250 },
  type: { type: String, trim: true, maxlength: 100 },
  url: { type: String, trim: true, maxlength: 1000 },
}, { _id: true, id: false });

const lineSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  shade: { type: String, trim: true, default: '' },
  batch: { type: String, trim: true, default: '' },
  operation: { type: String, enum: STOCK_ADJUSTMENT_OPERATIONS, required: true },
  scrapSource: { type: String, enum: ['', 'damagedQty', 'blockedQty', 'sampleQty'], default: '' },
  enteredQuantity: { type: Number, required: true, min: 0.000001 },
  enteredUnit: { type: String, required: true, trim: true },
  baseQuantity: { type: Number, required: true, min: 0.000001 },
  baseUnit: { type: String, required: true, trim: true },
  conversionFactor: { type: Number, required: true, min: 0.000000001 },
  uomVersion: { type: Number, required: true, min: 1 },
  deltas: { type: snapshotSchema, required: true },
  stock: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock' },
  beforeSnapshot: { type: snapshotSchema, required: true },
  submissionSnapshot: { type: snapshotSchema },
  submissionJournalTail: {
    movementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' },
    operationKey: { type: String, trim: true, default: '' },
    recordedAt: Date,
  },
  valuationRate: { type: Number, default: 0 },
  valueImpact: { type: Number, default: 0 },
  movement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' },
  operationKey: { type: String, trim: true, default: '' },
  reversalMovement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' },
  reversalOperationKey: { type: String, trim: true, default: '' },
}, { _id: true, id: false });

const actorSchema = {
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, submittedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, approvedAt: Date, approvalReason: { type: String, trim: true, default: '' },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, rejectedAt: Date, rejectionReason: { type: String, trim: true, default: '' },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reversedAt: Date, reversalReason: { type: String, trim: true, default: '' },
};

const stockAdjustmentSchema = new mongoose.Schema({
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
  adjustmentNumber: { type: String, required: true, trim: true },
  status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'reversed'], default: 'draft', index: true },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  remarks: { type: String, trim: true, default: '', maxlength: 4000 },
  lines: { type: [lineSchema], required: true, validate: { validator: (lines) => lines.length > 0 && lines.length <= 200, message: 'Stock adjustments require 1 to 200 lines.' } },
  totalValueImpact: { type: Number, default: 0 },
  evidence: { type: [evidenceSchema], default: [], validate: { validator: (rows) => rows.length <= 25, message: 'At most 25 evidence references are allowed.' } },
  sourceKey: { type: String, trim: true, maxlength: 500 },
  requestFingerprint: { type: String, trim: true, minlength: 64, maxlength: 64 },
  submittedFingerprint: { type: String, trim: true, minlength: 64, maxlength: 64 },
  postingVersion: { type: Number, min: 0, default: 0 },
  approvalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest' },
  ...actorSchema,
}, { timestamps: true, minimize: false });

stockAdjustmentSchema.index({ branch: 1, adjustmentNumber: 1 }, { unique: true });
stockAdjustmentSchema.index({ branch: 1, sourceKey: 1 }, { unique: true, sparse: true });
stockAdjustmentSchema.index({ branch: 1, status: 1, createdAt: -1 });
stockAdjustmentSchema.index({ branch: 1, createdBy: 1, createdAt: -1 });

export default mongoose.model('StockAdjustment', stockAdjustmentSchema);
