import mongoose from 'mongoose';

const pricingSlabSchema = new mongoose.Schema({
  minQty: { type: Number, required: true, min: 0 },
  maxQty: { type: Number, required: true, min: 0, default: 0 },
  rate: { type: Number, min: 0, default: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
}, { _id: false });

/**
 * Branch-scoped explicit price overrides. Historical rows without `scope` remain
 * valid dealer overrides through the legacy dealer/customerId fields.
 */
const dealerPricingSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    scope: { type: String, enum: ['dealer', 'dealer_type', 'walk_in'], default: 'dealer', index: true },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },

    // Retained for backward compatibility with existing dealer override rows.
    customerType: {
      type: String,
      enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', 'architect', 'project'],
      default: 'dealer',
    },
    customerId: { type: mongoose.Schema.Types.ObjectId },
    customerName: { type: String, default: '' },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productCode: String,
    productName: String,
    customRate: { type: Number, min: 0, default: null },
    discountPercent: { type: Number, min: 0, max: 100, default: 0 },
    discountFlat: { type: Number, min: 0, default: 0 },
    schemeDiscount: { type: Number, min: 0, default: 0 },
    minQty: { type: Number, min: 0, default: 0 },
    slabs: [pricingSlabSchema],
    validFrom: { type: Date, required: true, default: Date.now },
    validTo: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dealerPricingSchema.pre('validate', function validateDealerPricing(next) {
  const scope = this.scope || 'dealer';
  const legacyDealerId = this.dealer || (this.customerType === 'dealer' ? this.customerId : null);
  if (scope === 'dealer' && !legacyDealerId) {
    return next(new Error('dealer is required when scope is "dealer".'));
  }
  if (scope === 'dealer_type' && !this.dealerType) {
    return next(new Error('dealerType is required when scope is "dealer_type".'));
  }
  if (scope === 'walk_in' && (this.dealer || this.dealerType || this.customerId)) {
    return next(new Error('walk_in pricing cannot target a dealer, dealerType, or customerId.'));
  }
  if (scope !== 'dealer' && (this.dealer || this.customerId)) {
    return next(new Error('dealer/customerId may only be used with dealer scope.'));
  }
  if (scope !== 'dealer_type' && this.dealerType) {
    return next(new Error('dealerType may only be used with dealer_type scope.'));
  }
  if (this.dealer && this.customerType !== 'dealer') {
    return next(new Error('dealer may only be used with customerType "dealer".'));
  }
  if (this.dealer && this.customerId && String(this.dealer) !== String(this.customerId)) {
    return next(new Error('dealer and customerId must identify the same dealer.'));
  }
  if (this.validTo && this.validFrom && this.validTo < this.validFrom) {
    return next(new Error('validTo must be on or after validFrom.'));
  }

  const orderedSlabs = [...(this.slabs || [])].sort((a, b) => a.minQty - b.minQty);
  for (let index = 0; index < orderedSlabs.length; index += 1) {
    const slab = orderedSlabs[index];
    if (slab.maxQty > 0 && slab.maxQty < slab.minQty) {
      return next(new Error('Each slab maxQty must be zero or at least minQty.'));
    }
    if (index > 0) {
      const previous = orderedSlabs[index - 1];
      if (previous.maxQty === 0 || slab.minQty <= previous.maxQty) {
        return next(new Error('Dealer pricing slabs must not overlap; an open-ended slab must be last.'));
      }
    }
  }
  this.slabs = orderedSlabs;
  return next();
});

// Includes old rows where scope is absent, so no backfill is required.
dealerPricingSchema.index(
  { branch: 1, dealer: 1, product: 1 },
  { unique: true, partialFilterExpression: { dealer: { $type: 'objectId' } } }
);
dealerPricingSchema.index(
  { branch: 1, customerType: 1, customerId: 1, product: 1 },
  { unique: true, partialFilterExpression: { customerId: { $type: 'objectId' } } }
);
dealerPricingSchema.index(
  { branch: 1, dealerType: 1, product: 1 },
  { unique: true, partialFilterExpression: { scope: 'dealer_type', dealerType: { $type: 'objectId' } } }
);
dealerPricingSchema.index(
  { branch: 1, scope: 1, product: 1 },
  { unique: true, partialFilterExpression: { scope: 'walk_in' } }
);
dealerPricingSchema.index({ branch: 1, product: 1, isActive: 1 });
dealerPricingSchema.index({ branch: 1, scope: 1, isActive: 1 });

export default mongoose.model('DealerPricing', dealerPricingSchema);
