import mongoose from 'mongoose';

const approvalRequestSchema = new mongoose.Schema(
  {
    requestNumber: { type: String, required: true },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      immutable: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['sales_order', 'sales_order_cancellation', 'sales_order_remaining_cancellation', 'quotation', 'purchase_order', 'stock_adjustment', 'physical_stock_audit', 'credit_limit', 'rate_override', 'debit_note', 'credit_note', 'discount', 'other'],
      required: true,
    },
    title: { type: String, required: true },
    description: String,

    // Reference to the document needing approval
    referenceModel: { type: String, enum: ['SalesOrder', 'Quotation', 'PurchaseOrder', 'PurchaseReturn', 'SalesReturn', 'StockAdjustment', 'PhysicalStockAudit', 'Dealer', ''] },
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    referenceNumber: String,
    isAutomatic: { type: Boolean, default: false },
    exposureFingerprint: String,

    // Key values for decision making
    requestedValue: { type: Number }, // requested rate, amount, limit
    currentValue: { type: Number },   // existing rate, limit
    reason: String,

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: String,

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled', 'expired'],
      default: 'pending',
    },
    priority: { type: String, enum: ['normal', 'urgent'], default: 'normal' },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvalRemarks: String,
  },
  { timestamps: true }
);

approvalRequestSchema.index({ branch: 1, requestNumber: 1 }, { unique: true });
approvalRequestSchema.index({ branch: 1, status: 1, createdAt: -1 });
approvalRequestSchema.index({ branch: 1, type: 1, status: 1, createdAt: -1 });
approvalRequestSchema.index({ branch: 1, requestedBy: 1, createdAt: -1 });

export default mongoose.model('ApprovalRequest', approvalRequestSchema);
