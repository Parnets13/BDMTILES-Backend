import mongoose from 'mongoose';

/**
 * DealerLedger — append-only branch entries from SO, payments, returns, and notes.
 * Outstanding is derived from debit minus credit; no running balance is stored.
 */
const dealerLedgerSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
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
    postingKey: { type: String, trim: true },
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerLedger' },

    // Debit = amount dealer owes (invoice/debit note)
    // Credit = amount dealer paid / credit note
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dealerLedgerSchema.index({ branch: 1, dealer: 1, entryDate: -1 });
dealerLedgerSchema.index({ branch: 1, postingKey: 1 }, {
  unique: true,
  partialFilterExpression: { postingKey: { $type: 'string' } },
});
dealerLedgerSchema.index({ branch: 1, referenceModel: 1, referenceId: 1, entryType: 1 });
dealerLedgerSchema.index({ dealer: 1, entryDate: -1 });
dealerLedgerSchema.index({ referenceNumber: 1 });

export default mongoose.model('DealerLedger', dealerLedgerSchema);
