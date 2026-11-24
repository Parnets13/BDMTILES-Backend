import mongoose from 'mongoose';

/**
 * Sample Management — Track product samples issued to customers/architects.
 * Issue → Track → Return/Damage/Deposit
 */
const sampleSchema = new mongoose.Schema(
  {
    sampleNumber: { type: String, unique: true, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: String,
    productCode: String,
    shade: { type: String, default: '' },
    batch: { type: String, default: '' },
    quantity: { type: Number, default: 1 },

    // Issued to
    issuedTo: { type: String, required: true }, // name of person/company
    issuedToType: { type: String, enum: ['dealer', 'architect', 'builder', 'customer', 'contractor', 'interior_designer'], default: 'customer' },
    issuedToContact: { type: String, default: '' },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },

    // Dates
    issueDate: { type: Date, default: Date.now },
    expectedReturnDate: Date,
    actualReturnDate: Date,

    // Deposit
    depositAmount: { type: Number, default: 0 },
    depositCollected: { type: Boolean, default: false },
    depositReturned: { type: Boolean, default: false },

    // ── Direction and supplier ────────────────────────────────────
    // `outbound` is a sample handed to a dealer, architect or customer — the only
    // kind this module used to record. `supplier` is a sample received from or
    // given to a supplier, which carries a real cost and therefore needs the
    // accounting trail below.
    direction: { type: String, enum: ['outbound', 'supplier'], default: 'outbound', index: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },

    // ── Investment ────────────────────────────────────────────────
    // What the sample cost the business. Snapshotted per unit at issue, so a later
    // purchase-rate revision does not restate a sample that was already expensed.
    unitCost: { type: Number, default: 0, min: 0 },
    totalCost: { type: Number, default: 0, min: 0 },

    // ── Recovery ──────────────────────────────────────────────────
    // How much of `totalCost` came back, and by what route. The three routes are
    // genuinely different: a credit note reduces a supplier payable, a written-off
    // sample is a marketing expense, and a forfeited deposit is cash already held.
    recoveredAmount: { type: Number, default: 0, min: 0 },
    unrecoveredAmount: { type: Number, default: 0, min: 0 },
    recoveryMethod: {
      type: String,
      enum: ['none', 'deposit', 'credit_note', 'written_off', 'mixed'],
      default: 'none',
    },
    recoveryHistory: [{
      action: { type: String, enum: ['credit_note', 'write_off', 'deposit_forfeited', 'deposit_refunded', 'adjustment'] },
      amount: { type: Number, default: 0 },
      // The supplier's own credit note number and its scanned copy. There is no
      // CreditNote collection in this system — supplier credit notes exist only as
      // evidence documents — so these are recorded as reference and file rather
      // than as a ref to a collection that would never resolve.
      creditNoteNumber: { type: String, default: '' },
      documentUrl: { type: String, default: '' },
      note: { type: String, default: '' },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      recordedAt: { type: Date, default: Date.now },
      _id: false,
    }],

    // ── Accounting approval ───────────────────────────────────────
    // A supplier sample is money leaving the business, so it is approved rather
    // than merely recorded. Outbound samples default to `not_required` and never
    // enter this queue.
    accountingStatus: {
      type: String,
      enum: ['not_required', 'pending', 'approved', 'rejected'],
      default: 'not_required',
      index: true,
    },
    accountingSubmittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    accountingSubmittedAt: Date,
    accountingApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    accountingApprovedAt: Date,
    accountingNotes: { type: String, default: '' },

    // ── Evidence ──────────────────────────────────────────────────
    photos: [{
      url: { type: String, required: true },
      label: { type: String, default: '' },
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      uploadedAt: { type: Date, default: Date.now },
      _id: false,
    }],

    // Branch the sample belongs to. Absent on records written before this field
    // existed; those stay visible from every branch rather than disappearing.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    // Status
    status: {
      type: String,
      enum: ['issued', 'with_customer', 'returned', 'damaged', 'lost', 'converted_to_sale'],
      default: 'issued',
    },
    damageNotes: String,
    returnCondition: { type: String, enum: ['good', 'damaged', 'lost', ''], default: '' },

    // Tracking
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    remarks: { type: String, default: '' },
  },
  { timestamps: true }
);

sampleSchema.index({ status: 1 });
sampleSchema.index({ issuedTo: 'text' });
sampleSchema.index({ branch: 1, direction: 1, createdAt: -1 });
// The approval queue reads pending supplier samples only.
sampleSchema.index({ accountingStatus: 1, direction: 1 });

export default mongoose.model('Sample', sampleSchema);
