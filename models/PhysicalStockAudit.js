import mongoose from 'mongoose';

const STOCK_FIELDS = ['totalQty', 'availableQty', 'reservedQty', 'blockedQty', 'damagedQty', 'sampleQty', 'transitQty', 'shortQty'];
const quantityShape = () => Object.fromEntries(STOCK_FIELDS.map((field) => [field, { type: Number, default: 0, required: true }]));
const snapshotSchema = new mongoose.Schema(quantityShape(), { _id: false, id: false });
const evidenceSchema = new mongoose.Schema({
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  name: { type: String, trim: true, maxlength: 250 }, type: { type: String, trim: true, maxlength: 100 },
  url: { type: String, trim: true, maxlength: 1000 },
}, { _id: true, id: false });

const auditLineSchema = new mongoose.Schema({
  stock: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  shade: { type: String, trim: true, default: '' }, batch: { type: String, trim: true, default: '' },
  enteredUnit: { type: String, trim: true, default: '' }, baseUnit: { type: String, required: true, trim: true },
  conversionFactor: { type: Number, min: 0.000000001, default: 1 }, uomVersion: { type: Number, min: 1, default: 1 },
  baselineSnapshot: { type: snapshotSchema, required: true },
  submissionSnapshot: { type: snapshotSchema },
  submissionJournalTail: { movementId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' }, operationKey: { type: String, trim: true, default: '' }, recordedAt: Date },
  expectedOwnedTotal: { type: Number, required: true }, transitQty: { type: Number, required: true }, expectedPhysicalOnPremise: { type: Number, required: true },
  physicalCount: { type: Number, min: 0 }, physicalBaseQuantity: { type: Number, min: 0 },
  variance: { type: Number, default: 0 }, classification: { type: String, enum: ['not_counted', 'matched', 'short', 'excess'], default: 'not_counted' },
  countedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, countedAt: Date,
  recountRequired: { type: Boolean, default: false }, recountReason: { type: String, trim: true, default: '' },
  valuationRate: { type: Number, default: 0 }, valueImpact: { type: Number, default: 0 },
  movement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' }, operationKey: { type: String, trim: true, default: '' },
  reversalMovement: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' }, reversalOperationKey: { type: String, trim: true, default: '' },
}, { _id: true, id: false });

const physicalStockAuditSchema = new mongoose.Schema({
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
  auditNumber: { type: String, required: true, trim: true },
  status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'reversed'], default: 'draft', index: true },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  scope: { type: String, enum: ['full_warehouse', 'cycle_count', 'spot_check'], required: true },
  scopeFilters: { type: mongoose.Schema.Types.Mixed, default: {} }, scopeHash: { type: String, required: true, minlength: 64, maxlength: 64 },
  baselineAt: { type: Date, required: true },
  lines: { type: [auditLineSchema], required: true, validate: { validator: (lines) => lines.length > 0 && lines.length <= 2000, message: 'Physical audits require 1 to 2000 lines.' } },
  remarks: { type: String, trim: true, default: '', maxlength: 4000 },
  evidence: { type: [evidenceSchema], default: [], validate: { validator: (rows) => rows.length <= 25, message: 'At most 25 evidence references are allowed.' } },
  matchedCount: { type: Number, min: 0, default: 0 }, shortCount: { type: Number, min: 0, default: 0 }, excessCount: { type: Number, min: 0, default: 0 },
  totalVariance: { type: Number, default: 0 }, totalValueImpact: { type: Number, default: 0 },
  sourceKey: { type: String, trim: true, maxlength: 500 }, requestFingerprint: { type: String, trim: true, minlength: 64, maxlength: 64 },
  submittedFingerprint: { type: String, trim: true, minlength: 64, maxlength: 64 }, postingVersion: { type: Number, min: 0, default: 0 },
  approvalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, submittedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, approvedAt: Date, approvalReason: { type: String, trim: true, default: '' },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, rejectedAt: Date, rejectionReason: { type: String, trim: true, default: '' },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reversedAt: Date, reversalReason: { type: String, trim: true, default: '' },
}, { timestamps: true, minimize: false });

physicalStockAuditSchema.index({ branch: 1, auditNumber: 1 }, { unique: true });
physicalStockAuditSchema.index({ branch: 1, sourceKey: 1 }, { unique: true, sparse: true });
physicalStockAuditSchema.index({ branch: 1, warehouse: 1, status: 1, createdAt: -1 });
physicalStockAuditSchema.index({ branch: 1, createdBy: 1, createdAt: -1 });

export default mongoose.model('PhysicalStockAudit', physicalStockAuditSchema);
