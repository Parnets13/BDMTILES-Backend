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
  type: { type: String, enum: ['credit_limit', 'overdue_credit', 'credit_days', 'below_minimum_price'], required: true },
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
  sourceQuotationItem: { type: mongoose.Schema.Types.ObjectId },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 0.000001 },
  unit: { type: String, default: 'Box' },
  baseQuantity: { type: Number, default: 0, min: 0 },
  baseUnit: { type: String, default: 'Box' },
  conversionFactor: { type: Number, default: 1, min: 0.000000001 },
  uomVersion: { type: Number, default: 1, min: 1 },
  boxes: { type: Number, default: 0 },
  pieces: { type: Number, default: 0 },
  sqft: { type: Number, default: 0 },
  reservedQuantity: { type: Number, default: 0, min: 0 },
  reservationVersion: { type: Number, default: 0, min: 0 },
  reservationReleaseVersion: { type: Number, default: 0, min: 0 },
  allocatedQuantity: { type: Number, default: 0, min: 0 },
  pickedQuantity: { type: Number, default: 0, min: 0 },
  shortQuantity: { type: Number, default: 0, min: 0 },
  damagedQuantity: { type: Number, default: 0, min: 0 },
  dispatchedQuantity: { type: Number, default: 0, min: 0 },
  fulfilledQuantity: { type: Number, default: 0, min: 0 },
  cancelledRemainingQuantity: { type: Number, default: 0, min: 0 },
  returnedQuantity: { type: Number, default: 0, min: 0 },
  dispatchReversedQuantity: { type: Number, default: 0, min: 0 },
  netFulfilledQuantity: { type: Number, default: 0, min: 0 },
  remainingQuantity: { type: Number, default: 0, min: 0 },
  backorderQuantity: { type: Number, default: 0, min: 0 },
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
      enum: ['draft', 'confirmed', 'approved', 'processing', 'partial_dispatch', 'partially_closed', 'dispatched', 'delivered', 'cancelled', 'expired'],
      default: 'draft',
    },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid', 'overdue'], default: 'pending' },
    creditLimitExceeded: { type: Boolean, default: false },
    approvalStatus: { type: String, enum: ['not_required', 'pending', 'approved', 'rejected'], default: 'not_required' },
    approvalReasons: [approvalReasonSchema],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: String,
    confirmationRequested: { type: Boolean, default: false },
    reservationStatus: {
      type: String,
      enum: ['none', 'reserving', 'reserved', 'partial', 'released', 'consumed'],
      default: 'none',
    },
    reservedAt: Date,
    reservationReleasedAt: Date,
    reservationConsumedAt: Date,
    reservationExpiresAt: Date,
    reservationExpiryVersion: { type: Number, min: 0, default: 0 },
    reservationExpiryState: { type: String, enum: ['none', 'active', 'extended', 'expired', 'released'], default: 'none' },
    reservationExpiredAt: Date,
    reservationExpiryReason: { type: String, default: '' },
    reservationExtensions: [{
      version: { type: Number, required: true },
      previousExpiresAt: Date,
      extendedTo: { type: Date, required: true },
      reason: { type: String, required: true },
      extendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      extendedAt: { type: Date, default: Date.now },
    }],
    cancellationRequestStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    cancellationApprovalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest' },
    cancellationRequestedAt: Date,
    cancellationRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    remainingCancellationStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    remainingCancellationApprovalRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest' },
    remainingCancellationRequestedAt: Date,
    remainingCancellationRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    remainingCancellationReviewedAt: Date,
    remainingCancellationReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    remainingCancellationReason: { type: String, default: '' },
    remainingCancellationVersion: { type: Number, min: 0, default: 0 },
    closureFinancialSummary: { type: mongoose.Schema.Types.Mixed },
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
salesOrderSchema.index({ approvalStatus: 1, reservationStatus: 1, reservationExpiryState: 1, reservationExpiresAt: 1, branch: 1 });
salesOrderSchema.index({ branch: 1, expectedDeliveryDate: 1, status: 1 });
salesOrderSchema.index({ branch: 1, grandTotal: 1 });
salesOrderSchema.index({ branch: 1, dealer: 1, status: 1 });
salesOrderSchema.index({ branch: 1, orderNumber: 1 }, { unique: true });
salesOrderSchema.index(
  { branch: 1, sourceKey: 1 },
  { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } }
);
salesOrderSchema.index(
  { branch: 1, sourceQuotation: 1, createdAt: 1 },
  { name: 'branch_1_sourceQuotation_1_createdAt_1', partialFilterExpression: { sourceQuotation: { $type: 'objectId' } } }
);
salesOrderSchema.index({ dealer: 1, status: 1 });
salesOrderSchema.index({ status: 1, orderDate: -1 });
salesOrderSchema.index({ salesExecutive: 1 });
salesOrderSchema.index({ tallySyncStatus: 1 });
salesOrderSchema.index({ createdAt: -1 });

export default mongoose.model('SalesOrder', salesOrderSchema);
