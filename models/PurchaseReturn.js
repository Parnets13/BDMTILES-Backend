import mongoose from 'mongoose';

const purchaseReturnItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  returnQty: { type: Number, required: true, min: 1 },
  unit: { type: String, default: 'Box' },
  rate: { type: Number, default: 0 },
  reason: { type: String, enum: ['damaged_on_receipt', 'wrong_product', 'quality_issue', 'excess_supply', 'defective', 'other'], default: 'other' },
  reasonDetails: String,
  gstPercentage: { type: Number, default: 18 },
  gstAmount: { type: Number, default: 0 },
  taxableAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
});

const purchaseReturnSchema = new mongoose.Schema(
  {
    debitNoteNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    returnDate: { type: Date, default: Date.now },

    // Reference to PO / GRN
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
    poNumber: String,
    grn: { type: mongoose.Schema.Types.ObjectId, ref: 'GRN' },
    grnNumber: String,

    // Supplier
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: String,

    items: [purchaseReturnItemSchema],

    // Totals
    subtotal: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    sourceKey: { type: String, unique: true, sparse: true },
    requestFingerprint: { type: String, default: '' },

    // Status
    status: { type: String, enum: ['draft', 'approved', 'stock_deducted', 'debit_issued', 'cancelled'], default: 'draft' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: String,

    remarks: { type: String, default: '' },

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

purchaseReturnSchema.index({ branch: 1, status: 1, returnDate: -1 });
purchaseReturnSchema.index({ branch: 1, purchaseOrder: 1 });
purchaseReturnSchema.index({ branch: 1, debitNoteNumber: 1 }, { unique: true });
purchaseReturnSchema.index({ supplier: 1, returnDate: -1 });
purchaseReturnSchema.index({ purchaseOrder: 1 });
purchaseReturnSchema.index({ status: 1 });

export default mongoose.model('PurchaseReturn', purchaseReturnSchema);
