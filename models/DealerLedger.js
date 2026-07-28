import mongoose from 'mongoose';

/**
 * DealerLedger — auto-generated entries from SO, Payments, Returns, Credit Notes
 * Each transaction creates one entry. Balance is running.
 */
const dealerLedgerSchema = new mongoose.Schema(
  {
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true },
    dealerName: String,
    dealerCode: String,

    // Entry type
    entryType: {
      type: String,
      enum: ['opening', 'invoice', 'payment', 'credit_note', 'debit_note', 'adjustment', 'advance'],
      required: true,
    },

    entryDate: { type: Date, default: Date.now },
    description: { type: String, default: '' },
    referenceNumber: String, // SO number, RCP number, CN number etc.
    referenceModel: { type: String, enum: ['SalesOrder', 'Payment', 'SalesReturn', 'PurchaseReturn', ''] },
    referenceId: { type: mongoose.Schema.Types.ObjectId },

    // Debit = amount dealer owes (invoice/debit note)
    // Credit = amount dealer paid / credit note
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }, // running balance (positive = dealer owes)

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dealerLedgerSchema.index({ dealer: 1, entryDate: -1 });
dealerLedgerSchema.index({ referenceNumber: 1 });

export default mongoose.model('DealerLedger', dealerLedgerSchema);
