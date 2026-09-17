import mongoose from 'mongoose';

const conversionLineSchema = new mongoose.Schema({
  quotationItem: { type: mongoose.Schema.Types.ObjectId, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, min: 0.000001 },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
}, { _id: false });

const chargeAllocationSchema = new mongoose.Schema({
  freightCharges: { type: Number, default: 0, min: 0 },
  loadingCharges: { type: Number, default: 0, min: 0 },
  installationCharges: { type: Number, default: 0, min: 0 },
  otherCharges: { type: Number, default: 0, min: 0 },
}, { _id: false });

const quotationConversionSchema = new mongoose.Schema({
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation', required: true },
  salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true },
  sourceKey: { type: String, required: true, trim: true },
  requestFingerprint: { type: String, required: true },
  mode: { type: String, enum: ['full', 'available'], required: true },
  sourceQuotationStatus: { type: String, enum: ['approved', 'accepted'], required: true },
  status: { type: String, enum: ['active', 'voided'], default: 'active' },
  includePartialLines: { type: Boolean, default: false },
  reversalSourceKey: { type: String, trim: true },
  reversalRequestFingerprint: String,
  reversedAt: Date,
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reversalReason: { type: String, trim: true, maxlength: 1000, default: '' },
  lines: { type: [conversionLineSchema], default: [] },
  charges: { type: chargeAllocationSchema, default: () => ({}) },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

quotationConversionSchema.index(
  { branch: 1, quotation: 1, sourceKey: 1 },
  { unique: true, name: 'branch_1_quotation_1_sourceKey_1' },
);
quotationConversionSchema.index(
  { branch: 1, salesOrder: 1 },
  { unique: true, name: 'branch_1_salesOrder_1' },
);
quotationConversionSchema.index({ branch: 1, quotation: 1, status: 1, createdAt: 1 });

export default mongoose.model('QuotationConversion', quotationConversionSchema);
