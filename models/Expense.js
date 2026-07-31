import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    expenseNumber:    { type: String, unique: true },
    expenseDate:      { type: Date, default: Date.now },
    category:         { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseCategory' },
    categoryName:     { type: String },
    employee:         { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    employeeName:     { type: String },
    description:      { type: String, required: true },
    amount:           { type: Number, required: true, min: 0 },
    paymentMode:      { type: String, enum: ['cash', 'bank_transfer', 'credit_card', 'petty_cash'], default: 'cash' },
    receiptNumber:    { type: String, default: '' },
    receiptImage:     { type: String, default: '' }, // file path
    gstAmount:        { type: Number, default: 0 },
    billable:         { type: Boolean, default: false },
    project:          { type: String, default: '' },
    status:           { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'paid'], default: 'draft' },
    approvedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalNotes:    { type: String, default: '' },
    approvalDate:     { type: Date },
    paidDate:         { type: Date },
    bankAccount:      { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
    createdBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    tallySyncStatus:  { type: String, default: 'not_synced' },
  },
  { timestamps: true }
);

expenseSchema.index({ expenseDate: -1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ employee: 1 });

const Expense = mongoose.model('Expense', expenseSchema);
export default Expense;
