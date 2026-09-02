import mongoose from 'mongoose';

/**
 * SupplierLedger — append-only branch entries from GRN, payments, and debit notes.
 * Outstanding is derived from credit minus debit; no running balance is stored.
 */
const supplierLedgerSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
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
    referenceModel: { type: String, enum: ['PurchaseOrder', 'GRN', 'Payment', 'PurchaseReturn', 'SupplierInvoice', 'SchemeSettlement', ''] },
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    postingKey: { type: String, trim: true },
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierLedger' },

    // Debit = we paid / debit note raised
    // Credit = we owe supplier (purchase/grn)
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },

    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supplierLedgerSchema.index({ branch: 1, supplier: 1, entryDate: -1 });
supplierLedgerSchema.index({ branch: 1, postingKey: 1 }, {
  unique: true,
  partialFilterExpression: { postingKey: { $type: 'string' } },
});
supplierLedgerSchema.index({ branch: 1, referenceModel: 1, referenceId: 1, entryType: 1 });
supplierLedgerSchema.index({ supplier: 1, entryDate: -1 });
supplierLedgerSchema.index({ referenceNumber: 1 });

export default mongoose.model('SupplierLedger', supplierLedgerSchema);
