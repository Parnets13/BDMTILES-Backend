import mongoose from 'mongoose';

const prItemSchema = new mongoose.Schema({
  product:      { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productName:  { type: String },
  productCode:  { type: String },
  requiredQty:  { type: Number, default: 1 },
  currentStock: { type: Number, default: 0 },
  remarks:      { type: String, default: '' },
}, { _id: false });

const purchaseRequisitionSchema = new mongoose.Schema(
  {
    prNumber:         { type: String, unique: true },
    requestDate:      { type: Date, default: Date.now },
    requiredByDate:   { type: Date },
    requestedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requestedByName:  { type: String },
    department:       { type: String, default: '' },
    warehouse:        { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    warehouseName:    { type: String },
    priority:         { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
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

purchaseRequisitionSchema.index({ status: 1 });
purchaseRequisitionSchema.index({ requestDate: -1 });

const PurchaseRequisition = mongoose.model('PurchaseRequisition', purchaseRequisitionSchema);
export default PurchaseRequisition;
