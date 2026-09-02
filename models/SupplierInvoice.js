import mongoose from 'mongoose';

const supplierInvoiceLineSchema = new mongoose.Schema({
  grn: { type: mongoose.Schema.Types.ObjectId, ref: 'GRN', required: true },
  grnItem: { type: mongoose.Schema.Types.ObjectId, required: true },
  purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
  purchaseOrderItem: { type: mongoose.Schema.Types.ObjectId, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: { type: String, default: '' },
  productName: { type: String, default: '' },
  unit: { type: String, default: 'Box' },
  invoiceQuantity: { type: Number, required: true, min: 0.0001 },
  rate: { type: Number, required: true, min: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  taxableAmount: { type: Number, required: true, min: 0 },
  gstPercentage: { type: Number, default: 0, min: 0, max: 100 },
  taxAmount: { type: Number, default: 0, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
}, { _id: true });

const discrepancySchema = new mongoose.Schema({
  field: { type: String, required: true },
  expected: mongoose.Schema.Types.Mixed,
  actual: mongoose.Schema.Types.Mixed,
  difference: Number,
  message: String,
}, { _id: false });

const matchReportSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'matched', 'mismatch'], default: 'pending' },
  tolerance: { type: Number, default: 0.01 },
  expectedInvoiceAmount: { type: Number, default: 0 },
  expectedTaxAmount: { type: Number, default: 0 },
  expectedFreightAmount: { type: Number, default: 0 },
  expectedOtherCharges: { type: Number, default: 0 },
  expectedGrandTotal: { type: Number, default: 0 },
  legacyGRNAccrual: { type: Number, default: 0 },
  discrepancies: [discrepancySchema],
  matchedAt: Date,
  matchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const supplierInvoiceSchema = new mongoose.Schema({
  invoiceRefNumber: { type: String, required: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
  sourceKey: { type: String, unique: true, sparse: true },
  requestFingerprint: { type: String, default: '' },
  invoiceNumber: { type: String, required: true, trim: true },
  invoiceDate: { type: Date, default: Date.now },
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  supplierName: { type: String, default: '' },
  linkedGRNs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GRN', required: true }],
  items: { type: [supplierInvoiceLineSchema], validate: value => Array.isArray(value) && value.length > 0 },
  invoiceAmount: { type: Number, default: 0, min: 0 },
  taxAmount: { type: Number, default: 0, min: 0 },
  freightAmount: { type: Number, default: 0, min: 0 },
  otherCharges: { type: Number, default: 0, min: 0 },
  grandTotal: { type: Number, default: 0, min: 0 },
  paidAmount: { type: Number, default: 0, min: 0 },
  balanceAmount: { type: Number, default: 0, min: 0 },
  paymentTerms: { type: String, default: '' },
  dueDate: Date,
  status: {
    type: String,
    enum: ['draft', 'pending_verification', 'verified', 'partial', 'paid', 'cancelled'],
    default: 'pending_verification',
  },
  matchReport: { type: matchReportSchema, default: () => ({ status: 'pending' }) },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
  remarks: { type: String, default: '' },
  tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

supplierInvoiceSchema.index({ branch: 1, invoiceRefNumber: 1 }, { unique: true });
supplierInvoiceSchema.index({ branch: 1, supplier: 1, invoiceNumber: 1 });
supplierInvoiceSchema.index({ branch: 1, supplier: 1, status: 1, dueDate: 1 });
supplierInvoiceSchema.index({ branch: 1, status: 1, invoiceDate: -1 });
supplierInvoiceSchema.index({ branch: 1, linkedGRNs: 1 });

export default mongoose.models.SupplierInvoice || mongoose.model('SupplierInvoice', supplierInvoiceSchema);
