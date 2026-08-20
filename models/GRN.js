import mongoose from 'mongoose';

const grnItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  orderedQty: { type: Number, default: 0 },
  receivedQty: { type: Number, required: true, min: 0 },
  acceptedQty: { type: Number, default: 0 },
  shortQty: { type: Number, default: 0 },
  excessQty: { type: Number, default: 0 },
  damagedQty: { type: Number, default: 0 },
  rejectedQty: { type: Number, default: 0 },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  qualityStatus: { type: String, enum: ['accepted', 'rejected', 'hold'], default: 'accepted' },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
  zone: String,
  rack: String,
  bin: String,
  rate: { type: Number, default: 0 },
  remarks: String,
});

const grnSchema = new mongoose.Schema(
  {
    grnNumber: { type: String, unique: true, required: true },
    grnDate: { type: Date, default: Date.now },
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
    poNumber: String,
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: String,
    supplierInvoiceNo: { type: String, default: '' },
    vehicleNo: { type: String, default: '' },
    driverName: { type: String, default: '' },
    driverMobile: { type: String, default: '' },
    lrNumber: { type: String, default: '' },  // Lorry Receipt / Transport doc number
    qcPhotos: [String], // QC inspection photos

    items: [grnItemSchema],

    status: { type: String, enum: ['draft', 'verified', 'approved', 'posted'], default: 'draft' },
    qcRemarks: { type: String, default: '' },

    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,
    tallyGUID: String,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

grnSchema.index({ grnNumber: 1 });
grnSchema.index({ purchaseOrder: 1 });
grnSchema.index({ supplier: 1, grnDate: -1 });

export default mongoose.model('GRN', grnSchema);
