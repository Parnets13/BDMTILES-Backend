import mongoose from 'mongoose';

/**
 * Voucher — Receipt / Payment / Contra / Journal
 * Each voucher has Dr/Cr legs
 */
const voucherEntrySchema = new mongoose.Schema({
  accountName: { type: String, required: true }, // e.g. "Cash", "HDFC Bank", "Dealer XYZ"
  accountType: { type: String, enum: ['cash', 'bank', 'dealer', 'supplier', 'expense', 'income', 'capital', 'other'] },
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  narration: String,
});

const voucherSchema = new mongoose.Schema(
  {
    voucherNumber: { type: String, unique: true, required: true },
    voucherDate: { type: Date, default: Date.now },
    voucherType: {
      type: String,
      enum: ['receipt', 'payment', 'contra', 'journal', 'sales', 'purchase'],
      required: true,
    },

    entries: [voucherEntrySchema],

    totalAmount: { type: Number, default: 0 },
    narration: { type: String, default: '' },
    referenceNumber: String,

    // Bank/payment details
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
    paymentMode: { type: String, enum: ['cash', 'cheque', 'upi', 'neft', 'rtgs', 'transfer', ''] },
    chequeNumber: String,
    chequeDate: Date,
    transactionRef: String,

    status: { type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' },

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

voucherSchema.index({ voucherDate: -1, voucherType: 1 });

export default mongoose.model('Voucher', voucherSchema);
