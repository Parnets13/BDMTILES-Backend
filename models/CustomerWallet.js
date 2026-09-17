import mongoose from 'mongoose';

/**
 * BDM Cash wallet for a storefront customer.
 * One wallet per customer (enforced by unique index on customer).
 * Balance is in rupees (integer paise are avoided for simplicity).
 */
const walletSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      unique: true,
    },
    balance: { type: Number, default: 0, min: 0 },
    totalEarned: { type: Number, default: 0 },
    totalRedeemed: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'frozen'], default: 'active' },
  },
  { timestamps: true }
);

export default mongoose.model('CustomerWallet', walletSchema);
