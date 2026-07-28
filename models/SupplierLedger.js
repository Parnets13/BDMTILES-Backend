import mongoose from 'mongoose';

/**
 * SupplierLedger — auto-generated from PO, GRN, Supplier Payments, Debit Notes
 */
const supplierLedgerSchema = new mongoose.Schema(
  {
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: String,
    supplierCode: String,

    entryType: {
      type: String,
      enum: ['opening', 'purchase', 'payment', 'debit_note', 'credit_note', 'adjustment', 'advance'],
      required: true,
    },

    entryDate: { type: Date, default: Date.now },
    description: { type: String, default: '' },
    referenceNumber: String,
    referenceModel: { type: String, enum: ['PurchaseOrder', 'GRN', 'Payment', 'PurchaseReturn', 'SupplierInvoice', ''] },
    referenceId: { type: mongoose.Schema.Types.ObjectId },

    // Debit = we paid / debit note raised
    // Credit = we owe supplier (purchase/grn)
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }, // positive = we owe supplier

    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supplierLedgerSchema.index({ supplier: 1, entryDate: -1 });
supplierLedgerSchema.index({ referenceNumber: 1 });

export default mongoose.model('SupplierLedger', supplierLedgerSchema);
