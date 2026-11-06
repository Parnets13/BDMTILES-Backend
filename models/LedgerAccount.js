import mongoose from 'mongoose';

const ledgerAccountSchema = new mongoose.Schema(
  {
    accountName: { type: String, required: true, trim: true },
    accountCode: { type: String, trim: true, default: '' },
    accountGroup: {
      type: String,
      required: true,
      enum: [
        'Current Assets', 'Fixed Assets', 'Investments',
        'Current Liabilities', 'Long-term Liabilities', 'Capital & Reserves',
        'Revenue', 'Direct Expenses', 'Indirect Expenses', 'Other Income',
      ],
    },
    openingBalance: { type: Number, default: 0 },
    openingType:    { type: String, enum: ['Dr', 'Cr'], default: 'Dr' },
    isActive:       { type: Boolean, default: true },
    description:    { type: String, trim: true, default: '' },
    createdBy:      { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

ledgerAccountSchema.index({ accountName: 'text', accountCode: 'text' });
ledgerAccountSchema.index({ accountGroup: 1, isActive: 1 });

export default mongoose.model('LedgerAccount', ledgerAccountSchema);





















