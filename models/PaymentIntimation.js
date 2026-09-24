import mongoose from 'mongoose';

/**
 * Dealer-submitted payment intimation (a.k.a. UTR upload / payment notice).
 * The dealer tells BDMTILES that they have paid or are paying; the accounts
 * team later reconciles it against an actual Payment / bank entry. This is NOT
 * an accounting document on its own — it is an intimation awaiting verification.
 */
const paymentIntimationSchema = new mongoose.Schema(
  {
    intimationNumber: { type: String, unique: true, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true, index: true },
    dealerName: { type: String, default: '' },

    // Optional linkage to a specific invoice; otherwise treated as on-account.
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    invoiceNumber: { type: String, default: '' },

    amount: { type: Number, required: true, min: 1 },
    paymentDate: { type: Date, default: Date.now },
    paymentMode: {
      type: String,
      enum: ['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'other'],
      default: 'neft',
    },

    // Reference details (mode-specific).
    utrNumber: { type: String, default: '', trim: true },
    chequeNumber: { type: String, default: '', trim: true },
    bankName: { type: String, default: '', trim: true },
    referenceNote: { type: String, default: '', trim: true },

    // Optional proof image (stored via ComplaintEvidence-style upload).
    proofUrl: { type: String, default: '' },

    status: {
      type: String,
      enum: ['submitted', 'under_review', 'verified', 'rejected'],
      default: 'submitted',
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByName: { type: String, default: '' },
    reviewedAt: Date,
    reviewNote: { type: String, default: '' },

    // Reconciled payment record once accounts posts it.
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

    submittedVia: { type: String, default: 'dealer_app' },

    // Which of the dealer's own employees submitted this, when signed in as one.
    // Null for the dealer owner. Dealer-employee collection targets are measured
    // against this, so it is recorded at submission time, never inferred.
    createdByEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerEmployee' },
  },
  { timestamps: true }
);

paymentIntimationSchema.index({ branch: 1, dealer: 1, status: 1, createdAt: -1 });
paymentIntimationSchema.index({ dealer: 1, createdAt: -1 });
// Drives dealer-employee collection achievement.
paymentIntimationSchema.index({ dealer: 1, createdByEmployee: 1, createdAt: -1 });

export default mongoose.model('PaymentIntimation', paymentIntimationSchema);
