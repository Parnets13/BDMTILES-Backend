import mongoose from 'mongoose';

export const STOCK_BUCKET_FIELDS = Object.freeze([
  'totalQty',
  'availableQty',
  'reservedQty',
  'blockedQty',
  'damagedQty',
  'sampleQty',
  'transitQty',
  'shortQty',
]);

export const STOCK_MOVEMENT_TYPES = Object.freeze([
  'grn_receipt',
  'manual_adjustment',
  'stock_adjustment',
  'stock_adjustment_reversal',
  'physical_count',
  'physical_audit',
  'physical_audit_reversal',
  'sales_reservation',
  'sales_reservation_release',
  'pick_short_release',
  'pick_damage',
  'sorting_short',
  'sorting_damage',
  'sales_dispatch',
  'sales_remaining_cancel',
  'sales_dispatch_reversal',
  'purchase_return',
  'purchase_return_reversal',
  'sales_return',
  'sales_return_reversal',
  'legacy_transfer',
  'transfer_block',
  'transfer_block_release',
  'transfer_dispatch',
  'transfer_receive',
  'transfer_short',
  'migration_opening',
]);

export const STOCK_MOVEMENT_PHASES = Object.freeze([
  'posted',
  'reserved',
  'released',
  'reclassified',
  'dispatched',
  'received',
  'reversed',
  'counted',
  'opening',
]);

export const STOCK_SOURCE_TYPES = Object.freeze([
  'GRN',
  'ManualStockAdjustment',
  'StockAdjustment',
  'LegacyStockTransfer',
  'PhysicalStockAudit',
  'SalesOrder',
  'PickList',
  'DispatchTrip',
  'PurchaseReturn',
  'SalesReturn',
  'StockTransfer',
  'DispatchReturn',
  'Stock',
]);

const quantityShape = () => Object.fromEntries(STOCK_BUCKET_FIELDS.map((field) => [
  field,
  { type: Number, required: true, default: 0 },
]));

const snapshotSchema = new mongoose.Schema(quantityShape(), { _id: false, id: false });

const stockMovementSchema = new mongoose.Schema({
  operationKey: { type: String, required: true, trim: true, maxlength: 500 },
  intentHash: { type: String, required: true, trim: true, minlength: 64, maxlength: 64 },
  intentHashVersion: { type: Number, min: 1 },
  correlationKey: { type: String, required: true, trim: true, maxlength: 500 },
  movementType: { type: String, required: true, enum: STOCK_MOVEMENT_TYPES },
  phase: { type: String, required: true, enum: STOCK_MOVEMENT_PHASES },

  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  stock: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock', required: true },

  deltas: { type: new mongoose.Schema(quantityShape(), { _id: false, id: false }), required: true },
  before: { type: snapshotSchema, required: true },
  after: { type: snapshotSchema, required: true },

  enteredQuantity: { type: Number, required: true },
  enteredUnit: { type: String, required: true, trim: true },
  baseQuantity: { type: Number, required: true },
  baseUnit: { type: String, required: true, trim: true },
  conversionFactor: { type: Number, required: true, min: 0.000000001 },
  uomVersion: { type: Number, required: true, min: 1, default: 1 },

  sourceType: { type: String, required: true, enum: STOCK_SOURCE_TYPES },
  sourceModel: { type: String, required: true, trim: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceLineId: { type: String, required: true, trim: true },
  sourceNumber: { type: String, default: '', trim: true },

  relatedBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
  relatedWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  occurredAt: { type: Date, required: true },
  recordedAt: { type: Date, required: true, default: Date.now },
  reason: { type: String, default: '', trim: true },
  remarks: { type: String, default: '', trim: true },

  provenance: {
    type: String,
    required: true,
    enum: ['prospective', 'migration_backfill', 'migration_residual'],
    default: 'prospective',
  },
  confidence: {
    type: String,
    required: true,
    enum: ['exact', 'derived', 'residual'],
    default: 'exact',
  },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'StockMovement' },
  reversalOfOperationKey: { type: String, default: '', trim: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, {
  versionKey: false,
  minimize: false,
  strict: true,
});

stockMovementSchema.index({ operationKey: 1 }, { unique: true });
stockMovementSchema.index({ branch: 1, occurredAt: -1, _id: -1 });
stockMovementSchema.index({ branch: 1, product: 1, warehouse: 1, shade: 1, batch: 1, occurredAt: -1 });
stockMovementSchema.index({ branch: 1, sourceType: 1, sourceId: 1, sourceLineId: 1 });
stockMovementSchema.index({ branch: 1, movementType: 1, occurredAt: -1 });
stockMovementSchema.index({ branch: 1, actor: 1, occurredAt: -1 });
stockMovementSchema.index({ stock: 1, occurredAt: -1, _id: -1 });
stockMovementSchema.index({ correlationKey: 1, occurredAt: 1 });

const immutableError = next => next(new Error('StockMovement is append-only and cannot be updated or deleted.'));
stockMovementSchema.pre('save', function preventExistingSave(next) {
  if (!this.isNew) return immutableError(next);
  return next();
});
for (const operation of [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete',
]) {
  stockMovementSchema.pre(operation, function preventMutation(next) { return immutableError(next); });
}
stockMovementSchema.pre('deleteOne', { document: true, query: false }, function preventDocumentDelete(next) { return immutableError(next); });
stockMovementSchema.pre('updateOne', { document: true, query: false }, function preventDocumentUpdate(next) { return immutableError(next); });
stockMovementSchema.pre('bulkWrite', function preventBulkMutation(next) { return immutableError(next); });

const StockMovement = mongoose.model('StockMovement', stockMovementSchema);
StockMovement.bulkWrite = async () => { throw new Error('StockMovement is append-only and cannot be updated or deleted with bulkWrite.'); };
StockMovement.bulkSave = async () => { throw new Error('StockMovement is append-only and cannot be updated or deleted with bulkSave.'); };

export default StockMovement;
