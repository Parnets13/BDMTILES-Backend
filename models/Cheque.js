import mongoose from 'mongoose';

/**
 * Cheque — full lifecycle: received → deposited → cleared / bounced
 */
const chequeSchema = new mongoose.Schema(
  {
    chequeNumber: { type: String, required: true },
    chequeDate: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    bankName: { type: String, required: true },
    branchName: String,
    micr: String,

    // Cheque type
    chequeType: { type: String, enum: ['received', 'issued'], required: true },
    // received = from dealer; issued = to supplier

    // Party
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    partyName: String,

    // Linked payment
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

    // Status lifecycle
    status: {
      type: String,
      enum: ['received', 'deposited', 'cleared', 'bounced', 'cancelled', 'returned'],
      default: 'received',
    },

    // Deposit info
    depositedDate: Date,
    depositedBank: String,
    depositedBranch: String,

    // Clearance info
    clearedDate: Date,

    // Bounce info
    bounceDate: Date,
    bounceReason: String,
    bounceCharges: { type: Number, default: 0 },

    remarks: { type: String, default: '' },

    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

chequeSchema.index({ chequeNumber: 1, bankName: 1 });
chequeSchema.index({ dealer: 1, status: 1 });
chequeSchema.index({ supplier: 1, status: 1 });
chequeSchema.index({ chequeDate: -1 });

export default mongoose.model('Cheque', chequeSchema);
