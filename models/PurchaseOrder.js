import mongoose from 'mongoose';

const poItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  quantity: { type: Number, required: true, min: 0.0001 },
  unit: { type: String, default: 'Box' },
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0, min: 0 },
  schemeDiscount: { type: Number, default: 0, min: 0 },
  scheme: { type: String, default: '' },
  gstPercentage: { type: Number, default: 18, min: 0, max: 100 },
  taxableAmount: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  receivedQty: { type: Number, default: 0, min: 0 },
  pendingQty: { type: Number, default: 0, min: 0 },
});

const workflowSchema = new mongoose.Schema({
  level: Number,
  approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'] },
  date: Date,
  remarks: String,
}, { _id: true });

const amendmentSchema = new mongoose.Schema({
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  diff: [{
    field: String,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
  }],
  reason: { type: String, required: true },
  amendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amendedAt: { type: Date, required: true },
}, { _id: true });

const purchaseOrderSchema = new mongoose.Schema({
  poNumber: { type: String, required: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
  receivingWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  poDate: { type: Date, default: Date.now },
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  supplierName: String,

  sourceRequisition: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequisition' },
  sourceSupplierQuotation: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierQuotation' },
  sourceSupplierOffer: { type: mongoose.Schema.Types.ObjectId },
  sourceKey: { type: String, unique: true, sparse: true },
  requestFingerprint: { type: String, default: '' },

  items: { type: [poItemSchema], validate: value => Array.isArray(value) && value.length > 0 },
  subtotal: { type: Number, default: 0 },
  totalDiscount: { type: Number, default: 0 },
  totalTax: { type: Number, default: 0 },
  freight: { type: Number, default: 0 },
  loading: { type: Number, default: 0 },
  insurance: { type: Number, default: 0 },
  grandTotal: { type: Number, default: 0 },

  paymentTerms: { type: String, default: '' },
  creditDays: { type: Number, default: 0, min: 0 },
  expectedDeliveryDate: Date,
  deliveryAddress: { type: String, default: '' },
  remarks: { type: String, default: '' },

  status: {
    type: String,
    enum: ['draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'sent', 'partial_received', 'received', 'cancelled'],
    default: 'draft',
  },
  activeApprovalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionReason: { type: String, default: '' },
  approvalWorkflow: [workflowSchema],
  amendmentHistory: [amendmentSchema],

  tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
  tallyVoucherNumber: String,
  tallyGUID: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

purchaseOrderSchema.index({ branch: 1, status: 1, poDate: -1 });
purchaseOrderSchema.index({ branch: 1, supplier: 1, status: 1 });
purchaseOrderSchema.index({ branch: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ branch: 1, sourceRequisition: 1 });
purchaseOrderSchema.index({ supplier: 1, status: 1 });
purchaseOrderSchema.index({ status: 1, poDate: -1 });

export default mongoose.model('PurchaseOrder', purchaseOrderSchema);
