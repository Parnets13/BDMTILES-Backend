import mongoose from 'mongoose';

const resolutionSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  action: String,
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolvedByName: String,
  notes: String,
});

/**
 * Warehouse Verification — warehouse staff inspects the returned/complained item,
 * uploads photos of the problem, and provides their assessment.
 */
const warehouseVerificationSchema = new mongoose.Schema({
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedByName: String,
  verifiedAt: { type: Date, default: Date.now },

  // Problem Assessment
  problemConfirmed: { type: Boolean, default: false },
  problemDescription: { type: String, default: '' },
  severity: { type: String, enum: ['minor', 'moderate', 'major', 'critical'], default: 'moderate' },

  // Photos — warehouse uploads evidence photos
  photos: [{
    url: String,
    caption: String,
    uploadedAt: { type: Date, default: Date.now },
  }],

  // Product condition
  productCondition: { type: String, enum: ['intact', 'minor_damage', 'major_damage', 'broken', 'wrong_item', 'missing'], default: 'minor_damage' },
  isResaleable: { type: Boolean, default: false },
  quantityReceived: { type: Number, default: 0 },
  quantityDamaged: { type: Number, default: 0 },

  // Recommendation
  recommendation: { type: String, enum: ['replace', 'credit_note', 'repair', 'reject_claim', 'partial_credit'], default: 'credit_note' },
  recommendedAmount: { type: Number, default: 0 },
  remarks: { type: String, default: '' },
});

/**
 * Accountant Review — finance team reviews and approves/rejects the resolution
 */
const accountantReviewSchema = new mongoose.Schema({
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedByName: String,
  reviewedAt: { type: Date, default: Date.now },
  decision: { type: String, enum: ['approved', 'rejected', 'partial_approved', 'hold'], default: 'approved' },
  approvedAmount: { type: Number, default: 0 },
  adjustmentType: { type: String, enum: ['credit_note', 'replacement', 'refund', 'no_action'], default: 'credit_note' },
  remarks: String,
});

const complaintSchema = new mongoose.Schema(
  {
    complaintNumber: { type: String, unique: true, required: true },
    complaintDate: { type: Date, default: Date.now },

    // Linked entities
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerName: String,
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    orderNumber: String,
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    invoiceNumber: String,

    // Products complained about
    products: [{
      product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
      productName: String,
      productCode: String,
      productImage: String,
      quantity: { type: Number, default: 0 },
      shade: String,
      batch: String,
    }],

    // Category & Description
    category: {
      type: String,
      enum: ['damaged_goods', 'wrong_product', 'quality_issue', 'shade_mismatch', 'size_issue', 'short_delivery', 'billing_error', 'delivery_delay', 'packing_issue', 'other'],
      default: 'other',
    },
    description: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },

    // Status workflow: open → warehouse_pending → warehouse_verified → finance_review → resolved/closed/rejected
    status: {
      type: String,
      enum: ['open', 'acknowledged', 'warehouse_pending', 'warehouse_verified', 'finance_review', 'in_progress', 'resolved', 'closed', 'rejected'],
      default: 'open',
    },

    // Assignment
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: String,

    // Warehouse Verification (the key new feature)
    warehouseVerification: warehouseVerificationSchema,

    // Accountant Review
    accountantReview: accountantReviewSchema,

    // Resolution
    resolutionHistory: [resolutionSchema],
    resolvedAt: Date,
    resolutionNotes: String,
    resolutionType: { type: String, enum: ['replaced', 'credit_note', 'refund', 'repaired', 'rejected', ''], default: '' },

    // Financial impact
    requiresReturn: { type: Boolean, default: false },
    returnReceived: { type: Boolean, default: false },
    creditNoteIssued: { type: Boolean, default: false },
    creditNoteAmount: { type: Number, default: 0 },
    creditNoteNumber: String,

    // Dealer-uploaded photos (initial complaint evidence)
    complaintPhotos: [{ url: String, caption: String }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: String,
  },
  { timestamps: true }
);

complaintSchema.index({ complaintNumber: 1 });
complaintSchema.index({ dealer: 1, status: 1 });
complaintSchema.index({ status: 1, priority: 1 });
complaintSchema.index({ 'warehouseVerification.verifiedAt': -1 });

export default mongoose.model('Complaint', complaintSchema);
