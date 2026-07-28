import mongoose from 'mongoose';

const dealerSchemeSchema = new mongoose.Schema(
  {
    schemeNumber: { type: String, unique: true, required: true },
    schemeName: { type: String, required: true },
    schemeType: { type: String, enum: ['slab_discount', 'cashback', 'gift', 'points', 'target_bonus'], default: 'slab_discount' },
    applicableTo: { type: String, enum: ['all', 'specific_dealers', 'dealer_category', 'dealer_type'], default: 'all' },
    dealers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' }],
    dealerCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerCategory' },
    dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },
    // Slabs
    slabs: [{
      minQty: Number, maxQty: Number,
      minValue: Number, maxValue: Number,
      discountPercent: Number, cashbackAmount: Number, points: Number,
    }],
    pointsPerRupee: { type: Number, default: 0 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: ['active', 'paused', 'expired', 'closed'], default: 'active' },
    description: String,
    termsAndConditions: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dealerSchemeSchema.index({ schemeNumber: 1 });
dealerSchemeSchema.index({ status: 1 });

export default mongoose.model('DealerScheme', dealerSchemeSchema);
