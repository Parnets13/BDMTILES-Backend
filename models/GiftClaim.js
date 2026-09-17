import mongoose from 'mongoose';

/**
 * Gift claim (SOW 14 "Claimable gifts / Redeemed gifts / Pending claims /
 * Approval workflow", SOW 17.6 "Gift claim / Claim status").
 *
 * Lifecycle: pending -> approved -> dispatched -> delivered
 *                    -> rejected | cancelled  (points reversed)
 *
 * Points are debited from the ledger the moment the claim is raised, so a dealer
 * cannot spend the same points twice while a claim is under review. If the claim
 * is later rejected or cancelled, a 'reversed' entry returns them.
 */
const giftClaimSchema = new mongoose.Schema(
  {
    claimNumber: { type: String, required: true, unique: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true, index: true },
    dealerName: { type: String, default: '' },
    dealerCode: { type: String, default: '' },

    gift: { type: mongoose.Schema.Types.ObjectId, ref: 'Gift', required: true },
    giftName: { type: String, default: '' },
    giftImage: { type: String, default: '' },

    quantity: { type: Number, default: 1, min: 1 },
    pointsPerUnit: { type: Number, required: true, min: 1 },
    pointsSpent: { type: Number, required: true, min: 1 },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'dispatched', 'delivered', 'cancelled'],
      default: 'pending',
      index: true,
    },

    deliveryAddress: { type: String, default: '', trim: true },
    dealerRemarks: { type: String, default: '', trim: true, maxlength: 500 },

    // Approval workflow
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByName: { type: String, default: '' },
    reviewedAt: Date,
    reviewRemarks: { type: String, default: '' },

    // Fulfilment
    dispatchedAt: Date,
    courierName: { type: String, default: '' },
    trackingNumber: { type: String, default: '' },
    deliveredAt: Date,

    // Set when the debit is reversed after rejection/cancellation.
    pointsReversed: { type: Boolean, default: false },

    salesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sourceKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

giftClaimSchema.index({ dealer: 1, createdAt: -1 });
giftClaimSchema.index({ branch: 1, status: 1, createdAt: -1 });

export default mongoose.model('GiftClaim', giftClaimSchema);
