import mongoose from 'mongoose';

const bankEntrySchema = new mongoose.Schema({
  date: { type: Date, required: true },
  description: { type: String, default: '' },
  reference: { type: String, default: '' },
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
  // Matching
  matchStatus: { type: String, enum: ['unmatched', 'matched', 'partial', 'discrepancy'], default: 'unmatched' },
  matchedWith: { type: String, default: '' }, // voucher/payment/receipt reference
  matchedVoucherId: { type: mongoose.Schema.Types.ObjectId },
  matchedAmount: { type: Number, default: 0 },
  difference: { type: Number, default: 0 },
  remarks: { type: String, default: '' },
});

const bankReconciliationSchema = new mongoose.Schema(
  {
    reconciliationNumber: { type: String, unique: true, required: true },
    reconciliationDate: { type: Date, default: Date.now },

    // Bank account
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
    bankName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },

    // Period
    statementFrom: { type: Date, required: true },
    statementTo: { type: Date, required: true },

    // Opening & Closing
    openingBalance: { type: Number, default: 0 },
    closingBalance: { type: Number, default: 0 },
    bookBalance: { type: Number, default: 0 },

    // Entries
    entries: [bankEntrySchema],

    // Summary
    totalEntries: { type: Number, default: 0 },
    matchedEntries: { type: Number, default: 0 },
    unmatchedEntries: { type: Number, default: 0 },
    discrepancyEntries: { type: Number, default: 0 },
    totalDebit: { type: Number, default: 0 },
    totalCredit: { type: Number, default: 0 },
    netDifference: { type: Number, default: 0 },

    // Status
    status: { type: String, enum: ['draft', 'in_progress', 'completed', 'approved'], default: 'draft' },

    // File
    statementFile: { type: String, default: '' },

    // Metadata
    remarks: { type: String, default: '' },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    completedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

bankReconciliationSchema.index({ reconciliationNumber: 1 });
bankReconciliationSchema.index({ bankAccount: 1 });
bankReconciliationSchema.index({ status: 1 });

export default mongoose.model('BankReconciliation', bankReconciliationSchema);
