import mongoose from 'mongoose';

const pricingSnapshotSchema = new mongoose.Schema({
  source: { type: String, enum: ['product_tier', 'dealer_pricing', 'discount_mapping', 'manual'] },
  sourceId: mongoose.Schema.Types.ObjectId,
  sourceName: String,
  overrideScope: { type: String, enum: ['dealer', 'dealer_type', 'walk_in', null], default: null },
  requestedTier: String,
  rateField: String,
  baseRate: Number,
  pricingRate: Number,
  effectiveRate: Number,
  regularDiscountPerUnit: Number,
  schemeDiscountPerUnit: Number,
  minimumSellingRate: Number,
  belowMinimum: Boolean,
  fallbackApplied: Boolean,
  slab: mongoose.Schema.Types.Mixed,
  rule: mongoose.Schema.Types.Mixed,
  resolvedAt: Date,
}, { _id: false });

const approvalReasonSchema = new mongoose.Schema({
  type: { type: String, enum: ['credit_limit', 'below_minimum_price'], required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  message: String,
  itemIndex: Number,
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  subject: String,
  requestedValue: Number,
  thresholdValue: Number,
}, { _id: false });

const dealerTypeSnapshotSchema = new mongoose.Schema({
  name: String,
  pricingTier: String,
}, { _id: false });

const salesOrderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 1 },
  unit: { type: String, default: 'Box' },
  boxes: { type: Number, default: 0 },
  pieces: { type: Number, default: 0 },
  sqft: { type: Number, default: 0 },
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 },
  discountType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
  schemeDiscount: { type: Number, default: 0 },
  taxableAmount: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 18 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
  pricingSnapshot: pricingSnapshotSchema,
});

const salesOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    orderDate: { type: Date, default: Date.now },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },
    dealerTypeSnapshot: dealerTypeSnapshotSchema,
    dealerName: String,
    dealerCode: String,
    customerName: String,
    customerPhone: String,
    orderType: { type: String, enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', 'online', 'project'], default: 'dealer' },
    items: [salesOrderItemSchema],
    subtotal: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    totalSchemeDiscount: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    freightCharges: { type: Number, default: 0 },
    loadingCharges: { type: Number, default: 0 },
    installationCharges: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    advanceAmount: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },
    deliveryAddress: { type: String, default: '' },
    expectedDeliveryDate: Date,
    deliveryPriority: { type: String, enum: ['normal', 'urgent', 'vip'], default: 'normal' },
    status: {
      type: String,
      enum: ['draft', 'confirmed', 'approved', 'processing', 'partial_dispatch', 'dispatched', 'delivered', 'cancelled', 'expired'],
      default: 'draft',
    },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid', 'overdue'], default: 'pending' },
    creditLimitExceeded: { type: Boolean, default: false },
    approvalStatus: { type: String, enum: ['not_required', 'pending', 'approved', 'rejected'], default: 'not_required' },
    approvalReasons: [approvalReasonSchema],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: String,
    sourceQuotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
    sourceKey: String,
    requestFingerprint: String,
    salesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    legacyBranch: { type: String, default: '' },
    remarks: { type: String, default: '' },
    internalNotes: { type: String, default: '' },
    cancellationReason: String,
    modificationLogs: [{
      field: String,
      oldValue: mongoose.Schema.Types.Mixed,
      newValue: mongoose.Schema.Types.Mixed,
      changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      changedAt: { type: Date, default: Date.now },
      reason: String,
    }],
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,
    tallyGUID: String,
    tallySyncDate: Date,
    tallySyncError: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

salesOrderSchema.index({ branch: 1, status: 1, orderDate: -1 });
salesOrderSchema.index({ branch: 1, dealer: 1, status: 1 });
salesOrderSchema.index({ branch: 1, orderNumber: 1 }, { unique: true });
salesOrderSchema.index(
  { branch: 1, sourceKey: 1 },
  { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } }
);
salesOrderSchema.index({ dealer: 1, status: 1 });
salesOrderSchema.index({ status: 1, orderDate: -1 });
salesOrderSchema.index({ salesExecutive: 1 });
salesOrderSchema.index({ tallySyncStatus: 1 });
salesOrderSchema.index({ createdAt: -1 });

export default mongoose.model('SalesOrder', salesOrderSchema);
