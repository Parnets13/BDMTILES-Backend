import mongoose from 'mongoose';

/**
 * Single BDM Cash wallet transaction (credit or debit).
 * Linked to a customer and optionally to a sales order.
 */
const walletTransactionSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    wallet:   { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerWallet', required: true },
    type: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    amount: { type: Number, required: true, min: 0.01 },
    balanceAfter: { type: Number, required: true }, // wallet balance after this txn
    reason: {
      type: String,
      enum: [
        'cashback',          // % cashback on order
        'referral',          // referred a new customer
        'manual_credit',     // staff manually credited
        'manual_debit',      // staff manually debited / corrected
        'redemption',        // customer used cash at checkout
        'expiry',            // cashback expired
        'refund',            // order cancelled / returned
      ],
      required: true,
    },
    description: { type: String, trim: true, default: '' },
    referenceOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null = system
    expiresAt: { type: Date }, // for cashback credits that expire
  },
  { timestamps: true }
);

walletTransactionSchema.index({ customer: 1, createdAt: -1 });

export default mongoose.model('WalletTransaction', walletTransactionSchema);
