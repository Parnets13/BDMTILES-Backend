import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    paymentNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    paymentDate: { type: Date, default: Date.now },

    // Type: dealer payment (receipt) or supplier payment (outgoing)
    paymentType: { type: String, enum: ['dealer_receipt', 'supplier_payment'], required: true },

    // Reference
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    partyName: String,

    // Against which orders
    againstOrders: [{
      order: { type: mongoose.Schema.Types.ObjectId, refPath: 'againstOrders.orderModel' },
      orderModel: { type: String, enum: ['SalesOrder', 'PurchaseOrder'] },
      orderNumber: String,
      allocatedAmount: { type: Number, default: 0, min: 0.01 },
    }],

    // Payment details
    amount: { type: Number, required: true, min: 0.01 },
    paymentMode: { type: String, enum: ['cash', 'cheque', 'upi', 'neft', 'rtgs', 'card', 'adjustment'], required: true },
    
    // Bank/Cheque details
    bankName: String,
    chequeNumber: String,
    chequeDate: Date,
    transactionRef: String, // UPI/NEFT/RTGS ref
    sourceKey: { type: String, unique: true, sparse: true },
    requestFingerprint: { type: String, default: '' }, // idempotency key for system-created receipts
    
    // Status
    status: { type: String, enum: ['pending', 'confirmed', 'bounced', 'cancelled'], default: 'confirmed' },
    bounceReason: String,
    bounceCharges: { type: Number, default: 0 },

    remarks: { type: String, default: '' },

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

paymentSchema.index({ branch: 1, status: 1, paymentDate: -1 });
paymentSchema.index({ branch: 1, dealer: 1, paymentDate: -1 });
paymentSchema.index({ branch: 1, supplier: 1, paymentDate: -1 });
paymentSchema.index({ branch: 1, paymentNumber: 1 }, { unique: true });
paymentSchema.index({ dealer: 1, paymentDate: -1 });
paymentSchema.index({ supplier: 1, paymentDate: -1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ paymentMode: 1 });

export default mongoose.model('Payment', paymentSchema);
