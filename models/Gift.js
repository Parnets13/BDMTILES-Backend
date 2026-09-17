import mongoose from 'mongoose';

/**
 * Gift catalogue (SOW 14 / 17.6). Items a dealer can redeem with scheme points.
 * Managed by staff; read-only from the dealer app.
 */
const giftSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    giftCode: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    category: { type: String, default: '', trim: true },

    pointsRequired: { type: Number, required: true, min: 1 },
    // Indicative retail value, shown for context only.
    approxValue: { type: Number, default: 0, min: 0 },

    images: { type: [String], default: [] },

    // Null means unlimited availability.
    stockQty: { type: Number, default: null, min: 0 },
    claimedQty: { type: Number, default: 0, min: 0 },

    // Optional eligibility restrictions.
    dealerTypes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' }],
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },

    status: { type: String, enum: ['draft', 'active', 'paused', 'discontinued'], default: 'active', index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

giftSchema.index({ branch: 1, giftCode: 1 }, { unique: true });
giftSchema.index({ status: 1, pointsRequired: 1 });

// Available when active, in its validity window, and not exhausted.
giftSchema.methods.isAvailable = function isAvailable(now = new Date()) {
  if (this.status !== 'active') return false;
  if (this.validFrom && now < this.validFrom) return false;
  if (this.validTo && now > this.validTo) return false;
  if (this.stockQty !== null && this.stockQty !== undefined) {
    return Number(this.claimedQty || 0) < Number(this.stockQty);
  }
  return true;
};

export default mongoose.model('Gift', giftSchema);
