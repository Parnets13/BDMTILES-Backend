import mongoose from 'mongoose';

const suggestionProvenanceSchema = new mongoose.Schema({
  source: { type: String, enum: ['reorder_suggestion'], required: true },
  key: { type: String, required: true },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
  warehouseName: { type: String, default: '' },
  configuredReorderLevel: { type: Number, default: 0 },
  effectiveReorderLevel: { type: Number, default: 0 },
  minimumStockLevel: { type: Number, default: 0 },
  suggestedQty: { type: Number, default: 0 },
  lastSupplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
  lastSupplierName: { type: String, default: '' },
  lastPurchaseRate: { type: Number, default: 0 },
  snapshotAt: { type: Date, required: true },
}, { _id: false });

const prItemSchema = new mongoose.Schema({
  product:      { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName:  { type: String },
  productCode:  { type: String },
  productImage: { type: String, default: '' },
  requiredQty:  { type: Number, required: true, min: 0.0001 },
  currentStock: { type: Number, default: 0 },
  stockSnapshotAt: { type: Date },
  suggestionProvenance: { type: suggestionProvenanceSchema },
  remarks:      { type: String, default: '' },
});

const purchaseRequisitionSchema = new mongoose.Schema(
  {
    prNumber:         { type: String, required: true },
    branch:           { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
    requestDate:      { type: Date, default: Date.now },
    requiredByDate:   { type: Date },
    requestedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requestedByName:  { type: String },
    department:       { type: String, default: '' },
    warehouse:        { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    warehouseName:    { type: String },
    priority:         { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    source:           { type: String, enum: ['manual', 'reorder_suggestion'], default: 'manual' },
    items:            [prItemSchema],
    remarks:          { type: String, default: '' },
    status:           { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'po_created'], default: 'draft' },
    approvedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalNotes:    { type: String },
    approvalDate:     { type: Date },
    linkedPO:         { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
    createdBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

purchaseRequisitionSchema.index({ branch: 1, prNumber: 1 }, { unique: true });
purchaseRequisitionSchema.index({ branch: 1, status: 1 });
purchaseRequisitionSchema.index({ branch: 1, requestDate: -1 });

const PurchaseRequisition = mongoose.model('PurchaseRequisition', purchaseRequisitionSchema);
export default PurchaseRequisition;
