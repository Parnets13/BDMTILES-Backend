import mongoose from 'mongoose';

/**
 * Dealer scheme-points ledger (SOW 14 "Scheme points" / 17.6 "Points earned,
 * Points pending").
 *
 * Points are append-only entries so the balance is always auditable:
 *   earned    (+) confirmed points, spendable
 *   pending   (+) accrued but awaiting confirmation — NOT spendable
 *   redeemed  (-) locked by a gift claim
 *   reversed  (+) points returned when a claim is rejected/cancelled
 *   expired   (-) lapsed points
 *   adjustment(±) manual correction by staff
 *
 * Balance = sum(earned + reversed + positive adjustments) - sum(redeemed + expired + negative adjustments)
 */
const entrySchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true, index: true },

    entryType: {
      type: String,
      enum: ['earned', 'pending', 'redeemed', 'reversed', 'expired', 'adjustment'],
      required: true,
    },
    // Always stored as a positive magnitude; entryType decides the direction.
    points: { type: Number, required: true, min: 0 },
    // For 'adjustment' only: -1 to debit, +1 to credit.
    direction: { type: Number, enum: [1, -1], default: 1 },

    description: { type: String, default: '', trim: true },
    entryDate: { type: Date, default: Date.now },

    // Provenance
    scheme: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerScheme' },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    giftClaim: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftClaim' },
    referenceNumber: { type: String, default: '' },

    // Idempotency for system-generated accrual.
    sourceKey: { type: String, unique: true, sparse: true },

    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

entrySchema.index({ dealer: 1, entryDate: -1 });
entrySchema.index({ dealer: 1, entryType: 1 });

/** Signed value of one entry. */
export const signedPoints = (entry) => {
  const p = Number(entry.points || 0);
  switch (entry.entryType) {
    case 'earned':
    case 'reversed':
      return p;
    case 'redeemed':
    case 'expired':
      return -p;
    case 'adjustment':
      return p * (entry.direction === -1 ? -1 : 1);
    case 'pending':
    default:
      return 0; // pending points are not part of the spendable balance
  }
};

export default mongoose.model('DealerPointsLedger', entrySchema);
