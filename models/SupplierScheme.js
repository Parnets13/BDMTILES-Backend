import mongoose from 'mongoose';

const schemeProductSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productName: String,
  targetQty: { type: Number, default: 0 },
  achievedQty: { type: Number, default: 0 },
  incentiveRate: { type: Number, default: 0 }, // per unit or %
  incentiveType: { type: String, enum: ['per_unit', 'percentage', 'flat'], default: 'per_unit' },
});

const supplierSchemeSchema = new mongoose.Schema(
  {
    schemeNumber: { type: String, unique: true, required: true },
    schemeName: { type: String, required: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: String,
    schemeType: { type: String, enum: ['quantity_discount', 'cash_incentive', 'product_scheme', 'annual_bonus'], default: 'quantity_discount' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    products: [schemeProductSchema],
    totalTargetValue: { type: Number, default: 0 },
    totalIncentiveEarned: { type: Number, default: 0 },
    totalClaimAmount: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'expired', 'claimed', 'closed'], default: 'active' },
    claimSubmittedDate: Date,
    claimSettledDate: Date,
    claimSettledAmount: { type: Number, default: 0 },
    remarks: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supplierSchemeSchema.index({ schemeNumber: 1 });
supplierSchemeSchema.index({ supplier: 1, status: 1 });

export default mongoose.model('SupplierScheme', supplierSchemeSchema);
