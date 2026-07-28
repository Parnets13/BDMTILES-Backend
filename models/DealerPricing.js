import mongoose from 'mongoose';

/**
 * Dealer-specific product price overrides
 * One doc per dealer+product combo
 * If override exists — use it; else fall back to product's base price
 */
const dealerPricingSchema = new mongoose.Schema(
  {
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    // Override rates (null = use product default)
    customRate: { type: Number, min: 0, default: null },
    discountPercent: { type: Number, min: 0, max: 100, default: 0 },
    discountFlat: { type: Number, min: 0, default: 0 },

    // Scheme discount (extra on top)
    schemeDiscount: { type: Number, min: 0, default: 0 },

    // Min qty to get this price
    minQty: { type: Number, min: 0, default: 0 },

    // Validity
    validFrom: { type: Date, default: Date.now },
    validTo: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One override per dealer+product
dealerPricingSchema.index({ dealer: 1, product: 1 }, { unique: true });
dealerPricingSchema.index({ dealer: 1 });
dealerPricingSchema.index({ product: 1 });

export default mongoose.model('DealerPricing', dealerPricingSchema);
