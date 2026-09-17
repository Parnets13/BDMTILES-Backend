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
  type: { type: String, enum: ['below_minimum_price'], required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  message: String,
  itemIndex: Number,
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  requestedValue: Number,
  thresholdValue: Number,
}, { _id: false });
const dealerTypeSnapshotSchema = new mongoose.Schema({ name: String, pricingTier: String }, { _id: false });
const validityHistorySchema = new mongoose.Schema({
  previousValidUntil: Date,
  newValidUntil: { type: Date, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  changedAt: { type: Date, default: Date.now },
  requeued: { type: Boolean, default: false },
}, { _id: true });

const quotationItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 0.000001 },
  convertedQuantity: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator(value) { return Number(value || 0) <= Number(this.quantity || 0) + 0.0001; },
      message: 'convertedQuantity cannot exceed quotation item quantity.',
    },
  },
  unit: { type: String, default: 'Box' },
  // Immutable inventory-UOM snapshot captured whenever this quotation version
  // is saved. Live FIFO allocation consumes Stock quantities in base units.
  baseQuantity: { type: Number, min: 0 },
  baseUnit: { type: String, trim: true },
  conversionFactor: { type: Number, min: 0.000000001 },
  uomVersion: { type: Number, min: 1 },
  uomPrecision: { type: Number, min: 0, max: 6 },
  uomAllowFraction: { type: Boolean },
  boxes: { type: Number, default: 0 },
  pieces: { type: Number, default: 0 },
  sqft: { type: Number, default: 0 },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
  // Historical server-computed snapshot: true when the selected exact stock
  // bucket could not satisfy the requested quantity at this quotation version.
  outOfStock: { type: Boolean, default: false },
  stockAtQuotation: { type: Number, default: null },
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 },
  discountType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
  schemeDiscount: { type: Number, default: 0 },
  discountRuleName: { type: String, default: '' },
  taxableAmount: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 18 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  pricingSnapshot: pricingSnapshotSchema,
});

const quotationSchema = new mongoose.Schema(
  {
    quotationNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    quotationDate: { type: Date, default: Date.now },
    validUntil: Date,
    validityVersion: { type: Number, default: 0, min: 0 },
    validityHistory: { type: [validityHistorySchema], default: [] },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },
    dealerTypeSnapshot: dealerTypeSnapshotSchema,
    dealerName: String,
    dealerCode: String,
    customerType: { type: String, enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', ''], default: '' },
    customerName: String,
    customerPhone: String,
    customerAddress: String,
    items: [quotationItemSchema],
    // Explicit capture provenance keeps legacy item flags from being mistaken
    // for live stock. stockSnapshotAt proves capture for older records.
    snapshotCaptured: { type: Boolean, default: false },
    stockSnapshotAt: { type: Date, default: null },
    // Server-owned FIFO position. An approved quotation keeps this timestamp
    // if it is sent; a draft sent directly receives one only when accepted.
    stockQueuedAt: { type: Date, default: null },
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
    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'converted', 'expired', 'cancelled'],
      default: 'draft',
    },
    approvalRequired: { type: Boolean, default: false },
    approvalStatus: { type: String, enum: ['not_required', 'pending', 'approved', 'rejected'], default: 'not_required' },
    approvalReasons: [approvalReasonSchema],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: String,
    version: { type: Number, default: 1 },
    previousVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
    convertedToSO: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    // Legacy convertedToSO/convertedAt remain the first conversion for older clients.
    convertedSalesOrders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' }],
    conversionState: { type: String, enum: ['none', 'partial', 'full'], default: 'none' },
    conversionVersion: { type: Number, default: 0, min: 0 },
    firstConvertedAt: Date,
    lastConvertedAt: Date,
    fullyConvertedAt: Date,
    sourceDealerOrderRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerOrderRequest' },
    convertedAt: Date,
    remarks: { type: String, default: '' },
    termsAndConditions: { type: String, default: '' },
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

quotationSchema.index({ branch: 1, status: 1, quotationDate: -1 });
quotationSchema.index({ branch: 1, validUntil: 1, status: 1 });
quotationSchema.index({ branch: 1, conversionState: 1, quotationDate: -1 });
quotationSchema.index({ branch: 1, status: 1, stockQueuedAt: 1, createdAt: 1 });
quotationSchema.index({ branch: 1, dealer: 1, status: 1 });
quotationSchema.index({ branch: 1, quotationNumber: 1 }, { unique: true });
quotationSchema.index({ dealer: 1, status: 1 });
quotationSchema.index({ status: 1, quotationDate: -1 });
quotationSchema.index(
  { branch: 1, sourceDealerOrderRequest: 1 },
  { unique: true, partialFilterExpression: { sourceDealerOrderRequest: { $type: 'objectId' } } },
);

export default mongoose.model('Quotation', quotationSchema);
