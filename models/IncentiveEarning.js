import mongoose from 'mongoose';

/**
 * IncentiveEarning — tracks actual incentive earned per event.
 * One record per earning event (e.g., one per lead converted, one per month for sales targets).
 */
const incentiveEarningSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    idempotencyKey: { type: String, trim: true },
    incentive: { type: mongoose.Schema.Types.ObjectId, ref: 'Incentive', required: true },
    incentiveName: String,
    incentiveType: String,

    // Who earned it
    earnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    earnedByName: String,
    earnedByRole: String,
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerName: String,
    // Set when the earner is one of the dealer's own employees rather than a
    // BDMTILES user. `earnedBy` stays empty in that case — the two identities are
    // deliberately separate, so a dealer employee can never be confused with staff.
    dealerEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerEmployee' },
    dealerEmployeeName: String,

    // What triggered it
    triggerEvent: String,
    triggerReference: String, // e.g., "Lead LD-00045 converted", "Monthly sales Aug 2026"
    referenceId: { type: mongoose.Schema.Types.ObjectId }, // linked SO, Lead, etc.
    referenceModel: String, // 'Lead', 'SalesOrder', etc.

    // Calculation
    baseValue: { type: Number, default: 0 }, // sales value or target value
    baseQty: { type: Number, default: 0 },
    earnedAmount: { type: Number, default: 0 },
    calculationDetail: String, // e.g., "1% of ₹5,00,000 = ₹5,000"

    // Period
    period: String, // 'Aug 2026', 'Q2 2026', etc.
    periodStart: Date,
    periodEnd: Date,

    // Payment status
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paymentStatus: { type: String, enum: ['pending', 'approved', 'paid', 'rejected'], default: 'pending' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    paidAt: Date,
    paymentRef: String, // payment transaction reference

    remarks: String,
  },
  { timestamps: true }
);

incentiveEarningSchema.index({ earnedBy: 1, paymentStatus: 1 });
incentiveEarningSchema.index({ dealer: 1, paymentStatus: 1 });
incentiveEarningSchema.index({ incentive: 1 });
incentiveEarningSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
incentiveEarningSchema.index({ branch: 1, referenceModel: 1, referenceId: 1 });
incentiveEarningSchema.index({ triggerEvent: 1, createdAt: -1 });
// "My incentive history" for a dealer employee.
incentiveEarningSchema.index({ dealerEmployee: 1, createdAt: -1 });

export default mongoose.model('IncentiveEarning', incentiveEarningSchema);
