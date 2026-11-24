import mongoose from 'mongoose';

/**
 * PartnerCommission — one row per commission earned by a channel partner.
 *
 * There was no commission model in the system at all: the word appeared once, in a
 * comment on the Dealer schema. A channel partner therefore had nothing to log in
 * and see. This is the ledger behind item 35.
 *
 * Accrual is recorded rather than computed. No commission rule engine exists, and
 * inventing one would mean guessing rates the business has not agreed; an admin
 * records what was agreed against a specific order, and the partner sees it.
 */
const partnerCommissionSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    // The partner is a user account, not a customer record — the whole point of the
    // role is that classification becomes a login.
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    partnerName: String,

    // What earned it. The order is the anchor; the numbers are snapshotted so a
    // later revision of the order cannot silently restate a paid commission.
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    orderNumber: String,
    orderDate: Date,
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    customerName: String,

    baseAmount: { type: Number, default: 0, min: 0 },
    commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
    commissionAmount: { type: Number, default: 0, min: 0 },

    period: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },

    status: {
      type: String,
      enum: ['accrued', 'approved', 'paid', 'cancelled'],
      default: 'accrued',
      index: true,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidAt: Date,
    paymentReference: { type: String, default: '', trim: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

partnerCommissionSchema.index({ partner: 1, status: 1, createdAt: -1 });
partnerCommissionSchema.index({ branch: 1, status: 1 });
// One commission per partner per order, so a double entry cannot double-pay.
partnerCommissionSchema.index({ partner: 1, salesOrder: 1 }, { unique: true, sparse: true });

export default mongoose.model('PartnerCommission', partnerCommissionSchema);
