import mongoose from 'mongoose';

/**
 * Customer-specific product price overrides
 * Supports: Dealer, Wholesaler, Retail, Distributor, Builder/Architect
 * One doc per customer+product combo
 * If override exists — use it; else fall back to product's base rate for that tier
 */
const dealerPricingSchema = new mongoose.Schema(
  {
    // Customer reference (one of these will be set)
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    // For future: distributor, wholesaler IDs can be stored here too
    // or we use a generic approach:
    customerType: {
      type: String,
      enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', 'architect', 'project'],
      default: 'dealer',
    },
    customerId: { type: mongoose.Schema.Types.ObjectId }, // Generic customer ID
    customerName: { type: String, default: '' },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productCode: String,
    productName: String,

    // Override rates (null = use product default for that tier)
    customRate: { type: Number, min: 0, default: null },
    discountPercent: { type: Number, min: 0, max: 100, default: 0 },
    discountFlat: { type: Number, min: 0, default: 0 },

    // Scheme discount (extra on top)
    schemeDiscount: { type: Number, min: 0, default: 0 },

    // Quantity slab pricing
    minQty: { type: Number, min: 0, default: 0 },
    slabs: [{
      minQty: { type: Number, default: 0 },
      maxQty: { type: Number, default: 0 },
      rate: { type: Number, default: 0 },
      discountPercent: { type: Number, default: 0 },
    }],

    // Validity
    validFrom: { type: Date, default: Date.now },
    validTo: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One override per customer+product (using customerType + customerId + product)
dealerPricingSchema.index({ customerType: 1, customerId: 1, product: 1 }, { unique: true, sparse: true });
dealerPricingSchema.index({ dealer: 1, product: 1 }, { unique: true, sparse: true });
dealerPricingSchema.index({ product: 1 });
dealerPricingSchema.index({ customerType: 1 });

export default mongoose.model('DealerPricing', dealerPricingSchema);
