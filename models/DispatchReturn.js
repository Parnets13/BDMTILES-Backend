import mongoose from 'mongoose';

const dispatchReturnItemSchema = new mongoose.Schema({
  deliveryItem: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  pickListItem: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  salesOrderItem: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  originalDispatchOperationKey: { type: String, required: true, immutable: true, trim: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, immutable: true },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true, immutable: true },
  shade: { type: String, default: '', immutable: true },
  batch: { type: String, default: '', immutable: true },
  quantity: { type: Number, required: true, min: 0.000001 },
  condition: { type: String, enum: ['resaleable', 'damaged', 'scrap', 'lost'], required: true },
  enteredUnit: { type: String, default: 'Unit' },
  baseQuantity: { type: Number, required: true, min: 0.000001 },
  baseUnit: { type: String, default: 'Unit' },
  conversionFactor: { type: Number, default: 1, min: 0.000000001 },
  uomVersion: { type: Number, default: 1, min: 1 },
  remarks: { type: String, default: '' },
}, { _id: true });

const dispatchReturnSchema = new mongoose.Schema({
  returnNumber: { type: String, required: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true, immutable: true },
  delivery: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true, immutable: true },
  dispatchTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'DispatchTrip', required: true, immutable: true },
  salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, immutable: true },
  items: { type: [dispatchReturnItemSchema], default: [] },
  status: { type: String, enum: ['requested', 'warehouse_verified', 'approved', 'posted', 'rejected', 'cancelled'], default: 'requested' },
  reason: { type: String, required: true, trim: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestedAt: { type: Date, default: Date.now },
  warehouseVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  warehouseVerifiedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  postedAt: Date,
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: Date,
  rejectionReason: { type: String, default: '' },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancelledAt: Date,
}, { timestamps: true });

dispatchReturnSchema.index({ branch: 1, returnNumber: 1 }, { unique: true });
dispatchReturnSchema.index({ branch: 1, delivery: 1, status: 1 });
dispatchReturnSchema.index({ salesOrder: 1, 'items.salesOrderItem': 1 });

export default mongoose.model('DispatchReturn', dispatchReturnSchema);
