import mongoose from 'mongoose';

const leaveSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: String, enum: ['Casual', 'Sick', 'Earned', 'Unpaid', 'Maternity', 'Paternity', 'Compensatory'], required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    days: { type: Number, required: true },
    isHalfDay: { type: Boolean, default: false },
    reason: { type: String, required: true },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Cancelled'], default: 'Pending' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    rejectionReason: String,
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

leaveSchema.index({ employee: 1, fromDate: 1 });
leaveSchema.index({ status: 1 });

export default mongoose.model('Leave', leaveSchema);
