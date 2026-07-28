import mongoose from 'mongoose';

const approvalRequestSchema = new mongoose.Schema(
  {
    requestNumber: { type: String, unique: true, required: true },
    type: {
      type: String,
      enum: ['sales_order', 'purchase_order', 'credit_limit', 'rate_override', 'debit_note', 'credit_note', 'discount', 'other'],
      required: true,
    },
    title: { type: String, required: true },
    description: String,

    // Reference to the document needing approval
    referenceModel: { type: String, enum: ['SalesOrder', 'PurchaseOrder', 'PurchaseReturn', 'SalesReturn', 'Dealer', ''] },
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    referenceNumber: String,

    // Key values for decision making
    requestedValue: { type: Number }, // requested rate, amount, limit
    currentValue: { type: Number },   // existing rate, limit
    reason: String,

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: String,

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    priority: { type: String, enum: ['normal', 'urgent'], default: 'normal' },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvalRemarks: String,
  },
  { timestamps: true }
);

approvalRequestSchema.index({ status: 1, createdAt: -1 });
approvalRequestSchema.index({ requestedBy: 1 });
approvalRequestSchema.index({ type: 1, status: 1 });

export default mongoose.model('ApprovalRequest', approvalRequestSchema);
