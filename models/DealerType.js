import mongoose from 'mongoose';

const dealerTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true, default: '' },
    // pricingTier maps to product rate field: dealerRate, wholesaleRate, retailRate, distributorRate, builderRate
    pricingTier: {
      type: String,
      enum: ['dealerRate', 'wholesaleRate', 'retailRate', 'distributorRate', 'builderRate', 'projectRate'],
      default: 'dealerRate',
    },
    isDefault: { type: Boolean, default: false }, // preloaded system types
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

export default mongoose.model('DealerType', dealerTypeSchema);
