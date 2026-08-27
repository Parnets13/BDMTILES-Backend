import mongoose from 'mongoose';
import { calculateDiscountRule } from '../utils/pricingCalculations.js';

/**
 * DiscountMapping — Hierarchy-based discount rules for BDM Tiles
 * 
 * Business Logic:
 * - Admin defines discount rules at different levels: product, brand, category, subcategory
 * - Each rule can target specific dealer types (dealer, wholesaler, retail, distributor, builder)
 * - When creating a Quotation or Sales Order, the system auto-resolves the best discount
 * - Resolution priority: product > brand > subcategory > category (most specific wins)
 * - Within same level, higher `priority` number wins
 * - Supports: direct percentage, flat amount, or both
 * - Validity period + active/inactive status
 * - Max discount cap prevents over-discounting
 */

const discountMappingSchema = new mongoose.Schema(
  {
    // Rule identification
    ruleName: { type: String, required: true, trim: true },
    ruleCode: { type: String, unique: true, sparse: true, trim: true },

    // What this discount targets
    targetType: {
      type: String,
      enum: ['product', 'brand', 'category', 'subcategory'],
      required: true,
    },

    // Target references (only one used based on targetType)
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: function () { return this.targetType === 'product'; },
    },
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Brand',
      required: function () { return this.targetType === 'brand'; },
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: function () { return this.targetType === 'category'; },
    },
    subcategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subcategory',
      required: function () { return this.targetType === 'subcategory'; },
    },

    // Denormalized names for quick display
    targetName: { type: String, default: '' },

    // Who gets this discount
    applicableTo: {
      type: String,
      enum: ['all', 'specific_types'],
      default: 'all',
    },
    // If specific_types, which dealer types get this discount
    applicableDealerTypes: [{
      type: String,
      enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder'],
    }],

    // Discount values
    discountType: {
      type: String,
      enum: ['percentage', 'flat', 'both', 'slab'],
      default: 'percentage',
    },
    discountPercentage: { type: Number, min: 0, max: 100, default: 0 },
    discountFlat: { type: Number, min: 0, default: 0 },

    // Quantity slab discounts (used when discountType = 'slab')
    slabs: [{
      minQty: { type: Number, required: true, min: 0 },
      maxQty: { type: Number, required: true, min: 0 },
      discountPercentage: { type: Number, min: 0, max: 100, default: 0 },
      discountFlat: { type: Number, min: 0, default: 0 },
    }],

    // Safety cap — max discount % allowed (prevents over-discounting)
    maxDiscountPercentage: { type: Number, min: 0, max: 100, default: 50 },

    // Priority — higher wins when multiple rules match same product
    priority: { type: Number, default: 0 },

    // Validity
    validFrom: { type: Date, default: Date.now },
    validTo: { type: Date, required: true },

    // Status
    status: {
      type: String,
      enum: ['active', 'inactive', 'expired'],
      default: 'active',
    },

    // Optional constraints
    minOrderQty: { type: Number, min: 0, default: 0 },
    minOrderAmount: { type: Number, min: 0, default: 0 },

    // Metadata
    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Indexes for fast lookup
discountMappingSchema.index({ targetType: 1, status: 1 });
discountMappingSchema.index({ product: 1, status: 1 });
discountMappingSchema.index({ brand: 1, status: 1 });
discountMappingSchema.index({ category: 1, status: 1 });
discountMappingSchema.index({ subcategory: 1, status: 1 });
discountMappingSchema.index({ validFrom: 1, validTo: 1 });
discountMappingSchema.index({ priority: -1 });

/**
 * Static method: Find the best applicable discount for a product + dealerType
 * Resolution order (most specific wins):
 *   1. Product-specific discount
 *   2. Brand-specific discount
 *   3. Subcategory-specific discount
 *   4. Category-specific discount
 * Within each level, highest priority wins.
 * Stops at the FIRST level that returns a valid match.
 */
discountMappingSchema.statics.findBestDiscount = async function (productDoc, dealerType = 'dealer') {
  const now = new Date();
  const baseFilter = {
    status: 'active',
    validFrom: { $lte: now },
    validTo: { $gte: now },
    $or: [
      { applicableTo: 'all' },
      { applicableDealerTypes: dealerType },
    ],
  };

  // 1. Product-level
  if (productDoc._id) {
    const productDiscount = await this.findOne({
      ...baseFilter,
      targetType: 'product',
      product: productDoc._id,
    }).sort({ priority: -1 }).lean();
    if (productDiscount) return productDiscount;
  }

  // 2. Brand-level
  if (productDoc.brand) {
    const brandId = typeof productDoc.brand === 'object' ? productDoc.brand._id : productDoc.brand;
    const brandDiscount = await this.findOne({
      ...baseFilter,
      targetType: 'brand',
      brand: brandId,
    }).sort({ priority: -1 }).lean();
    if (brandDiscount) return brandDiscount;
  }

  // 3. Subcategory-level
  if (productDoc.subcategory) {
    const subcatId = typeof productDoc.subcategory === 'object' ? productDoc.subcategory._id : productDoc.subcategory;
    const subcatDiscount = await this.findOne({
      ...baseFilter,
      targetType: 'subcategory',
      subcategory: subcatId,
    }).sort({ priority: -1 }).lean();
    if (subcatDiscount) return subcatDiscount;
  }

  // 4. Category-level
  if (productDoc.category) {
    const catId = typeof productDoc.category === 'object' ? productDoc.category._id : productDoc.category;
    const catDiscount = await this.findOne({
      ...baseFilter,
      targetType: 'category',
      category: catId,
    }).sort({ priority: -1 }).lean();
    if (catDiscount) return catDiscount;
  }

  return null; // No discount applicable
};

/**
 * Static method: Bulk resolve discounts for multiple products at once
 * More efficient than calling findBestDiscount one by one
 */
discountMappingSchema.statics.bulkResolveDiscounts = async function (products, dealerType = 'dealer') {
  const now = new Date();
  const baseFilter = {
    status: 'active',
    validFrom: { $lte: now },
    validTo: { $gte: now },
    $or: [
      { applicableTo: 'all' },
      { applicableDealerTypes: dealerType },
    ],
  };

  // Fetch ALL active discount rules in one query
  const allRules = await this.find(baseFilter).sort({ priority: -1 }).lean();

  // Group by targetType for fast lookup
  const productRules = allRules.filter(r => r.targetType === 'product');
  const brandRules = allRules.filter(r => r.targetType === 'brand');
  const subcatRules = allRules.filter(r => r.targetType === 'subcategory');
  const catRules = allRules.filter(r => r.targetType === 'category');

  const results = {};

  for (const prod of products) {
    const prodId = String(prod._id);
    const brandId = prod.brand ? String(typeof prod.brand === 'object' ? prod.brand._id : prod.brand) : null;
    const subcatId = prod.subcategory ? String(typeof prod.subcategory === 'object' ? prod.subcategory._id : prod.subcategory) : null;
    const catId = prod.category ? String(typeof prod.category === 'object' ? prod.category._id : prod.category) : null;

    // Priority: product > brand > subcategory > category
    let match = productRules.find(r => String(r.product) === prodId);
    if (!match && brandId) match = brandRules.find(r => String(r.brand) === brandId);
    if (!match && subcatId) match = subcatRules.find(r => String(r.subcategory) === subcatId);
    if (!match && catId) match = catRules.find(r => String(r.category) === catId);

    results[prodId] = match || null;
  }

  return results;
};

discountMappingSchema.statics.calculateRuleDiscount = function (rule, rate, quantity = 1, options = {}) {
  return calculateDiscountRule(rule, rate, quantity, options);
};

/**
 * Instance method: Calculate discount amount for a given rate and quantity.
 * Delegates to the same formula used by authoritative sales pricing.
 */
discountMappingSchema.methods.calculateDiscount = function (rate, quantity = 1, options = {}) {
  const calculated = calculateDiscountRule(this.toObject(), rate, quantity, options);
  return {
    ...calculated,
    ruleId: this._id,
    ruleName: this.ruleName,
    targetType: this.targetType,
    targetName: this.targetName,
  };
};

export default mongoose.model('DiscountMapping', discountMappingSchema);
