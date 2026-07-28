import mongoose from 'mongoose';

const resolutionSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  action: String,
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes: String,
});

const complaintSchema = new mongoose.Schema(
  {
    complaintNumber: { type: String, unique: true, required: true },
    complaintDate: { type: Date, default: Date.now },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerName: String,
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    orderNumber: String,
    category: {
      type: String,
      enum: ['damaged_goods', 'wrong_product', 'quality_issue', 'short_delivery', 'billing_error', 'delivery_delay', 'other'],
      default: 'other',
    },
    description: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    status: {
      type: String,
      enum: ['open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'rejected'],
      default: 'open',
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolutionHistory: [resolutionSchema],
    resolvedAt: Date,
    resolutionNotes: String,
    requiresReturn: { type: Boolean, default: false },
    creditNoteIssued: { type: Boolean, default: false },
    creditNoteAmount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

complaintSchema.index({ complaintNumber: 1 });
complaintSchema.index({ dealer: 1, status: 1 });
complaintSchema.index({ status: 1, priority: 1 });

export default mongoose.model('Complaint', complaintSchema);
