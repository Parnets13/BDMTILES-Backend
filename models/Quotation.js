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

const holdExtensionSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  previousExpiresAt: Date,
  extendedTo: { type: Date, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  extendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  extendedAt: { type: Date, default: Date.now },
}, { _id: true });

const quotationItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  // Set on a split child, pointing at the parent quotation line it came from, so
  // the original request stays traceable after the split.
  parentQuotationItem: { type: mongoose.Schema.Types.ObjectId },
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
  // Quantity of this line currently held in Stock.quotedQty, in entered units.
  // A hold is a real claim on stock, placed at approval and consumed by
  // conversion, so a held line can never fail to become a Sales Order.
  holdQuantity: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator(value) { return Number(value || 0) <= Number(this.quantity || 0) + 0.0001; },
      message: 'holdQuantity cannot exceed quotation item quantity.',
    },
  },
  // Monotonic counters that make each hold/release stock movement idempotent.
  // Mirrors SalesOrder.items[].reservationVersion.
  holdVersion: { type: Number, default: 0, min: 0 },
  holdReleaseVersion: { type: Number, default: 0, min: 0 },
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
      enum: [
        'draft', 'pending_approval', 'approved', 'sent', 'accepted', 'converted', 'expired', 'cancelled',
        // Terminal parent record of a stock split. Preserves exactly what the
        // dealer asked for; never convertible and never in the FIFO queue.
        'split',
        // Shortfall child of a split: quantity we have no stock for. Holds a FIFO
        // position so it is served fairly when a GRN lands, but is deliberately
        // not a firm offer and cannot be sent until stock is confirmed.
        'pending_stock',
      ],
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

    // ── Stock hold ────────────────────────────────────────────────────────────
    // A hold moves Stock.availableQty into Stock.quotedQty, so the quantity is
    // genuinely unavailable to anyone else. Conversion moves quotedQty straight
    // to reservedQty without touching availableQty, which is why converting a
    // held quotation cannot fail on stock.
    holdStatus: {
      type: String,
      enum: ['none', 'held', 'partial', 'consumed', 'released', 'expired'],
      default: 'none',
    },
    heldAt: Date,
    heldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // A hold with no expiry would let anyone freeze the warehouse by raising
    // quotations. Set from QUOTATION_HOLD_TTL_HOURS when the hold is placed.
    holdExpiresAt: Date,
    holdExpiryState: { type: String, enum: ['none', 'active', 'extended', 'expired', 'released'], default: 'none' },
    holdExpiryVersion: { type: Number, min: 0, default: 0 },
    holdExpiredAt: Date,
    holdReleasedAt: Date,
    holdConsumedAt: Date,
    holdExpiryReason: { type: String, default: '' },
    holdExtensions: { type: [holdExtensionSchema], default: [] },

    // ── Stock split lineage ───────────────────────────────────────────────────
    // One splitGroupId ties the parent and both children together.
    splitGroupId: { type: mongoose.Schema.Types.ObjectId },
    splitRole: { type: String, enum: ['none', 'parent', 'available', 'shortfall'], default: 'none' },
    // Children point back at the immutable parent.
    splitFromQuotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
    // Parent points at its children.
    splitQuotations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' }],
    splitAt: Date,
    splitBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Fingerprint of the allocation plan that was actually executed, so a split
    // can be audited against what the approver confirmed.
    splitPlanHash: { type: String, default: '' },
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
// Drives the hold expiry sweeper.
quotationSchema.index({ branch: 1, holdStatus: 1, holdExpiryState: 1, holdExpiresAt: 1 });
// Enumerates a split family from any member.
quotationSchema.index(
  { branch: 1, splitGroupId: 1, splitRole: 1 },
  { partialFilterExpression: { splitGroupId: { $type: 'objectId' } } },
);
quotationSchema.index(
  { branch: 1, splitFromQuotation: 1 },
  { partialFilterExpression: { splitFromQuotation: { $type: 'objectId' } } },
);
quotationSchema.index({ branch: 1, dealer: 1, status: 1 });
quotationSchema.index({ branch: 1, quotationNumber: 1 }, { unique: true });
quotationSchema.index({ dealer: 1, status: 1 });
quotationSchema.index({ status: 1, quotationDate: -1 });
quotationSchema.index(
  { branch: 1, sourceDealerOrderRequest: 1 },
  { unique: true, partialFilterExpression: { sourceDealerOrderRequest: { $type: 'objectId' } } },
);

export default mongoose.model('Quotation', quotationSchema);
