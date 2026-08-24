import mongoose from 'mongoose';

/**
 * Cheque — full lifecycle tracking with images, timeline, and complete bank details.
 * received → deposited → cleared / bounced → re-deposited / returned
 */

const timelineEntrySchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  action: String, // 'received', 'deposited', 'cleared', 'bounced', 'returned', 'cancelled'
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  performedByName: String,
  notes: String,
});

const chequeSchema = new mongoose.Schema(
  {
    chequeNumber: { type: String, required: true },
    chequeDate: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },

    // Drawer's bank details (person who wrote the cheque)
    bankName: { type: String, required: true },
    branchName: { type: String, default: '' },
    ifscCode: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    accountHolderName: { type: String, default: '' },
    micr: { type: String, default: '' },

    // Cheque type
    chequeType: { type: String, enum: ['received', 'issued'], required: true },
    // received = from dealer/customer; issued = to supplier

    // Party
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    partyName: { type: String, default: '' },
    partyPhone: { type: String, default: '' },

    // Linked payment
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    paymentNumber: { type: String, default: '' },

    // Against which order/invoice
    againstOrder: { type: mongoose.Schema.Types.ObjectId },
    againstOrderNumber: { type: String, default: '' },
    againstInvoice: { type: mongoose.Schema.Types.ObjectId },
    againstInvoiceNumber: { type: String, default: '' },

    // Cheque images (front and back)
    chequeFrontImage: { type: String, default: '' },
    chequeBackImage: { type: String, default: '' },

    // Status lifecycle
    status: {
      type: String,
      enum: ['received', 'deposited', 'cleared', 'bounced', 'returned', 'cancelled', 're_deposited'],
      default: 'received',
    },

    // Deposit info
    depositedDate: Date,
    depositedBank: { type: String, default: '' },   // OUR bank where we deposit
    depositedBranch: { type: String, default: '' },
    depositedAccountNumber: { type: String, default: '' },
    depositSlipNumber: { type: String, default: '' },

    // Clearance info
    clearedDate: Date,
    clearanceReference: { type: String, default: '' },

    // Bounce info
    bounceDate: Date,
    bounceReason: { type: String, default: '' },
    bounceCharges: { type: Number, default: 0 },
    bounceCount: { type: Number, default: 0 }, // how many times bounced

    // Re-deposit
    reDepositDate: Date,
    reDepositCount: { type: Number, default: 0 },

    // Return info (if returned to party)
    returnedDate: Date,
    returnReason: { type: String, default: '' },

    // Security cheque (for dealers)
    isSecurityCheque: { type: Boolean, default: false },
    securityFor: { type: String, default: '' }, // "Credit Limit ₹5,00,000"

    // PDC (Post-Dated Cheque) tracking
    isPDC: { type: Boolean, default: false },
    pdcDueDate: Date,

    // Timeline — full audit trail
    timeline: [timelineEntrySchema],

    // Metadata
    remarks: { type: String, default: '' },
    tags: [String],
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

chequeSchema.index({ chequeNumber: 1, bankName: 1 });
chequeSchema.index({ dealer: 1, status: 1 });
chequeSchema.index({ supplier: 1, status: 1 });
chequeSchema.index({ chequeDate: -1 });
chequeSchema.index({ status: 1, chequeDate: -1 });
chequeSchema.index({ isPDC: 1, pdcDueDate: 1 });

export default mongoose.model('Cheque', chequeSchema);
