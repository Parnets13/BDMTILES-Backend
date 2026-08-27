import mongoose from 'mongoose';

const loanSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: { type: String, enum: ['Loan', 'Advance'], required: true },
    amount: { type: Number, required: true },
    reason: { type: String, trim: true, default: '' },
    sanctionedDate: { type: Date, default: Date.now },
    emiAmount: { type: Number, default: 0 },
    totalInstallments: { type: Number, default: 1 },
    paidInstallments: { type: Number, default: 0 },
    remainingAmount: { type: Number, default: 0 },
    status: { type: String, enum: ['Active', 'Completed', 'Cancelled'], default: 'Active' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

loanSchema.index({ branch: 1, employee: 1, status: 1 });

export default mongoose.model('Loan', loanSchema);
