import mongoose from 'mongoose';

const salarySlipSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    month: { type: Number, required: true }, // 1-12
    year: { type: Number, required: true },
    
    // Attendance summary
    totalDays: { type: Number, default: 0 },
    presentDays: { type: Number, default: 0 },
    absentDays: { type: Number, default: 0 },
    halfDays: { type: Number, default: 0 },
    leaveDays: { type: Number, default: 0 },
    weekOffs: { type: Number, default: 0 },
    holidays: { type: Number, default: 0 },
    overtimeHours: { type: Number, default: 0 },
    lateDays: { type: Number, default: 0 },

    // Earnings
    basicSalary: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    conveyance: { type: Number, default: 0 },
    medicalAllowance: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },
    otherAllowance: { type: Number, default: 0 },
    overtimeAmount: { type: Number, default: 0 },
    incentive: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    grossEarnings: { type: Number, default: 0 },

    // Deductions
    pf: { type: Number, default: 0 },
    esi: { type: Number, default: 0 },
    professionalTax: { type: Number, default: 0 },
    tds: { type: Number, default: 0 },
    loanRecovery: { type: Number, default: 0 },
    advanceRecovery: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    absentDeduction: { type: Number, default: 0 },
    lateDeduction: { type: Number, default: 0 },
    grossDeductions: { type: Number, default: 0 },

    // Net
    netSalary: { type: Number, default: 0 },

    // Status
    status: { type: String, enum: ['Draft', 'Approved', 'Paid', 'Cancelled'], default: 'Draft' },
    paymentDate: Date,
    paymentMode: { type: String, enum: ['Bank Transfer', 'Cash', 'Cheque'], default: 'Bank Transfer' },
    transactionRef: String,

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,

    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

salarySlipSchema.index({ branch: 1, employee: 1, month: 1, year: 1 }, { unique: true });
salarySlipSchema.index({ branch: 1, status: 1, year: 1, month: 1 });

export default mongoose.model('SalarySlip', salarySlipSchema);
