import mongoose from 'mongoose';

const returnItemSchema = new mongoose.Schema({
  invoiceItem: { type: mongoose.Schema.Types.ObjectId, immutable: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  returnQty: { type: Number, required: true, min: 0.0001 },
  unit: { type: String, default: 'Box' },
  rate: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  schemeDiscount: { type: Number, default: 0 },
  reason: { type: String, enum: ['damaged', 'wrong_product', 'quality_issue', 'excess', 'shade_mismatch', 'other'], default: 'other' },
  reasonDetails: String,
  condition: { type: String, enum: ['resaleable', 'damaged', 'scrap'], default: 'resaleable' },
  taxableAmount: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 18 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
});

const salesReturnSchema = new mongoose.Schema(
  {
    returnNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    returnDate: { type: Date, default: Date.now },

    // Reference to original sales order
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    orderNumber: String,
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', immutable: true },
    invoiceNumber: String,
    complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', immutable: true },

    // Dealer
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true },
    dealerName: String,
    dealerCode: String,

    items: [returnItemSchema],

    // Totals
    subtotal: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    sourceKey: { type: String, unique: true, sparse: true },
    requestFingerprint: { type: String, default: '' },

    // Credit Note
    creditNoteNumber: String,
    creditNoteDate: Date,
    adjustmentType: { type: String, enum: ['refund', 'credit_note', 'replacement'], default: 'credit_note' },

    // Status
    status: {
      type: String,
      enum: ['draft', 'approved', 'stock_updated', 'credit_issued', 'refund_pending', 'replacement_pending', 'cancelled', 'reversed'],
      default: 'draft',
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: String,
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reversedAt: Date,
    reversalReason: String,

    remarks: { type: String, default: '' },

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

salesReturnSchema.index({ branch: 1, status: 1, returnDate: -1 });
salesReturnSchema.index({ branch: 1, salesOrder: 1 });
salesReturnSchema.index({ complaint: 1 }, { unique: true, sparse: true });
salesReturnSchema.index({ branch: 1, returnNumber: 1 }, { unique: true });
salesReturnSchema.index(
  { branch: 1, creditNoteNumber: 1 },
  { unique: true, partialFilterExpression: { creditNoteNumber: { $type: 'string' } } }
);
salesReturnSchema.index({ salesOrder: 1 });
salesReturnSchema.index({ dealer: 1, returnDate: -1 });
salesReturnSchema.index({ status: 1 });

export default mongoose.model('SalesReturn', salesReturnSchema);
