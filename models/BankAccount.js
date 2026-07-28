import mongoose from 'mongoose';

const bankAccountSchema = new mongoose.Schema(
  {
    accountName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    bankName: { type: String, required: true },
    branchName: String,
    ifscCode: String,
    accountType: { type: String, enum: ['current', 'savings', 'cc', 'od'], default: 'current' },
    openingBalance: { type: Number, default: 0 },
    currentBalance: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    remarks: String,
  },
  { timestamps: true }
);

export default mongoose.model('BankAccount', bankAccountSchema);
