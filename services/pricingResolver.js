import mongoose from 'mongoose';
import Dealer from '../models/Dealer.js';
import DealerType from '../models/DealerType.js';
import DealerPricing from '../models/DealerPricing.js';
import DiscountMapping from '../models/DiscountMapping.js';
import Product from '../models/Product.js';
import { calculateDiscountRule, roundMoney } from '../utils/pricingCalculations.js';

const TIER_FIELDS = new Set([
  'dealerRate', 'wholesaleRate', 'retailRate', 'distributorRate', 'builderRate', 'projectRate',
]);
const ORDER_TYPE_TIERS = Object.freeze({
  dealer: 'dealerRate', wholesaler: 'wholesaleRate', retail: 'retailRate',
  distributor: 'distributorRate', builder: 'builderRate', architect: 'builderRate',
  project: 'projectRate', online: 'retailRate',
});
const DISCOUNT_DEALER_TYPES = Object.freeze({
  dealerRate: 'dealer', wholesaleRate: 'wholesaler', retailRate: 'retail',
  distributorRate: 'distributor', builderRate: 'builder', projectRate: 'builder',
});
const PRICING_SCOPES = new Set(['dealer', 'dealer_type', 'walk_in']);
// Tiers a caller may ask for explicitly. Wider than TIER_FIELDS because `mrp` is a
// legitimate selling price for a storefront even though it is not a dealer tier,
// and TIER_FIELDS is also used to validate DealerType.pricingTier.
const SELECTABLE_TIERS = new Set([...TIER_FIELDS, 'mrp']);

function pricingError(status, message) {
  return Object.assign(new Error(message), { status });
}
function asObjectId(value, field) {
  if (!value || !mongoose.isValidObjectId(value)) throw pricingError(422, `${field} is invalid.`);
  return value;
}
function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
function validRate(product, field) {
  const value = Number(product?.[field]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function chooseBaseRate(product, preferredTier, orderType, walkIn) {
  const requestedTier = preferredTier || (walkIn ? 'retailRate' : ORDER_TYPE_TIERS[orderType]) || 'dealerRate';
  const candidates = [
    requestedTier,
    'mrp',
    walkIn ? 'retailRate' : ORDER_TYPE_TIERS[orderType],
    'dealerRate', 'retailRate', 'wholesaleRate', 'distributorRate', 'builderRate', 'projectRate',
  ].filter((field, index, values) => field && values.indexOf(field) === index);
  const positiveField = candidates.find((field) => validRate(product, field) > 0);
  const selectedField = positiveField || candidates.find((field) => validRate(product, field) !== null) || 'mrp';
  return {
    requestedTier,
    rateField: selectedField,
    rate: validRate(product, selectedField) ?? 0,
    fallbackApplied: selectedField !== requestedTier,
  };
}
function matchingOverrideSlab(slabs, quantity) {
  return [...(slabs || [])]
    .sort((a, b) => nonNegative(b.minQty) - nonNegative(a.minQty))
    .find((slab) => quantity >= nonNegative(slab.minQty)
      && (nonNegative(slab.maxQty) === 0 || quantity <= nonNegative(slab.maxQty))) || null;
}
function calculateOverride(override, baseRate, quantity, schemeEligible = true) {
  const slab = matchingOverrideSlab(override.slabs, quantity);
  const pricingRate = slab && Number.isFinite(Number(slab.rate)) && Number(slab.rate) >= 0
    ? Number(slab.rate)
    : override.customRate != null ? nonNegative(override.customRate) : baseRate;
  const percentage = slab
    ? Math.min(100, nonNegative(slab.discountPercent))
    : Math.min(100, nonNegative(override.discountPercent));
  const flat = slab ? 0 : nonNegative(override.discountFlat);
  const regularDiscountPerUnit = Math.min(pricingRate, Math.max(0, (pricingRate * percentage) / 100 + flat));
  const afterRegularDiscount = Math.max(0, pricingRate - regularDiscountPerUnit);
  const schemeDiscountPerUnit = schemeEligible
    ? Math.min(afterRegularDiscount, nonNegative(override.schemeDiscount))
    : 0;
  return {
    pricingRate: roundMoney(pricingRate),
    regularDiscountPerUnit: roundMoney(regularDiscountPerUnit),
    schemeDiscountPerUnit: roundMoney(schemeDiscountPerUnit),
    effectiveRate: roundMoney(Math.max(0, afterRegularDiscount - schemeDiscountPerUnit)),
    slab,
  };
}
async function loadDealer(dealerId, session) {
  if (!dealerId) return null;
  asObjectId(dealerId, 'dealer');
  let query = Dealer.findById(dealerId).populate('dealerType', 'name pricingTier status');
  if (session) query = query.session(session);
  const dealer = await query.lean();
  if (!dealer) throw pricingError(404, 'Dealer not found.');
  if (dealer.status !== 'active') throw pricingError(422, 'Dealer is not active.');
  if (dealer.dealerType && dealer.dealerType.status !== 'active') {
    throw pricingError(422, 'The dealer\'s DealerType is not active.');
  }
  return dealer;
}
async function loadDealerType(dealerTypeId, session) {
  if (!dealerTypeId) return null;
  asObjectId(dealerTypeId, 'dealerType');
  let query = DealerType.findById(dealerTypeId);
  if (session) query = query.session(session);
  const dealerType = await query.lean();
  if (!dealerType) throw pricingError(404, 'DealerType not found.');
  if (dealerType.status !== 'active') throw pricingError(422, 'DealerType is not active.');
  if (!TIER_FIELDS.has(dealerType.pricingTier)) throw pricingError(422, 'DealerType has an invalid pricingTier.');
  return dealerType;
}
async function loadProduct(productOrId, session) {
  // An ObjectId is itself an object exposing `_id` (it returns itself), so `_id`
  // alone cannot tell a loaded document from an id. Rule ids out first, otherwise
  // passing an ObjectId is mistaken for a document whose status is undefined and
  // every such call fails with a misleading "not active".
  const isId = typeof productOrId === 'string' || productOrId instanceof mongoose.Types.ObjectId;
  if (!isId && productOrId && typeof productOrId === 'object' && productOrId._id) {
    if (productOrId.status !== 'active') throw pricingError(422, `Product ${productOrId.productCode || productOrId._id} is not active.`);
    return productOrId;
  }
  asObjectId(productOrId, 'product');
  let query = Product.findById(productOrId);
  if (session) query = query.session(session);
  const product = await query.lean();
  if (!product) throw pricingError(404, 'Product not found.');
  if (product.status !== 'active') throw pricingError(422, `Product ${product.productCode || product._id} is not active.`);
  return product;
}
function validityFilter(at, quantity) {
  return {
    isActive: true,
    validFrom: { $lte: at },
    $and: [
      { $or: [{ validTo: null }, { validTo: { $exists: false } }, { validTo: { $gte: at } }] },
      { $or: [{ minQty: { $exists: false } }, { minQty: { $lte: quantity } }] },
    ],
  };
}
async function findOverride({ branchId, dealer, dealerType, productId, quantity, at, session }) {
  const base = { branch: branchId, product: productId, ...validityFilter(at, quantity) };
  const candidates = [];
  if (dealer) {
    candidates.push({
      scopeName: 'dealer',
      filter: {
        ...base,
        $and: [
          ...base.$and,
          { $or: [
            { scope: 'dealer', dealer: dealer._id },
            { scope: { $exists: false }, dealer: dealer._id },
            { customerType: 'dealer', customerId: dealer._id },
          ] },
        ],
      },
    });
  }
  if (dealerType) candidates.push({ scopeName: 'dealer_type', filter: { ...base, scope: 'dealer_type', dealerType: dealerType._id } });
  candidates.push({ scopeName: 'walk_in', filter: { ...base, scope: 'walk_in' } });

  for (const candidate of candidates) {
    let query = DealerPricing.findOne(candidate.filter).sort({ updatedAt: -1 });
    if (session) query = query.session(session);
    const override = await query.lean();
    if (override) return { override, scope: candidate.scopeName };
  }

  // Read-only compatibility for pre-branch dealer rows. New writes are always
  // branch-owned, but legacy rows continue to resolve without a backfill.
  if (dealer) {
    const legacyBase = { product: productId, ...validityFilter(at, quantity) };
    const legacyFilter = {
      ...legacyBase,
      $and: [
        ...legacyBase.$and,
        { $or: [{ branch: { $exists: false } }, { branch: null }] },
        { $or: [
          { dealer: dealer._id },
          { customerType: 'dealer', customerId: dealer._id },
        ] },
      ],
    };
    let legacyQuery = DealerPricing.findOne(legacyFilter).sort({ updatedAt: -1 });
    if (session) legacyQuery = legacyQuery.session(session);
    const legacyOverride = await legacyQuery.lean();
    if (legacyOverride) return { override: legacyOverride, scope: 'dealer' };
  }
  return null;
}
async function findDiscount(branchId, product, dealerType, at, session) {
  const base = {
    branch: branchId,
    mappingType: 'sales',
    status: 'active', validFrom: { $lte: at }, validTo: { $gte: at },
    $or: [{ applicableTo: 'all' }, { applicableDealerTypes: dealerType }],
  };
  const levels = [
    product._id && { targetType: 'product', product: product._id },
    product.brand && { targetType: 'brand', brand: product.brand?._id || product.brand },
    product.subcategory && { targetType: 'subcategory', subcategory: product.subcategory?._id || product.subcategory },
    product.category && { targetType: 'category', category: product.category?._id || product.category },
  ].filter(Boolean);
  for (const level of levels) {
    let query = DiscountMapping.findOne({ ...base, ...level }).sort({ priority: -1 });
    if (session) query = query.session(session);
    const rule = await query.lean();
    if (rule) return rule;
  }
  return null;
}

export async function resolvePricing(options = {}) {
  const {
    branchId, dealerId, dealerTypeId, scope: requestedScope, product: productInput,
    quantity = 1, orderType = 'dealer', pricingDate = new Date(), orderAmount,
    session = null, proposedOverride = null, manualRate, preferredTier: requestedTier = null,
  } = options;
  if (!branchId) throw pricingError(422, 'branch is required for pricing.');
  if (requestedTier && !SELECTABLE_TIERS.has(requestedTier)) {
    throw pricingError(422, `preferredTier must be one of: ${[...SELECTABLE_TIERS].join(', ')}.`);
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw pricingError(422, 'quantity must be greater than zero.');
  const at = new Date(pricingDate);
  if (Number.isNaN(at.getTime())) throw pricingError(422, 'pricingDate is invalid.');
  const scope = requestedScope || (dealerId ? 'dealer' : dealerTypeId ? 'dealer_type' : 'walk_in');
  if (!PRICING_SCOPES.has(scope)) throw pricingError(422, 'scope must be dealer, dealer_type, or walk_in.');
  if (scope === 'dealer' && !dealerId) throw pricingError(422, 'dealerId is required for dealer scope.');
  if (scope === 'dealer_type' && !dealerTypeId) throw pricingError(422, 'dealerTypeId is required for dealer_type scope.');
  if (scope === 'walk_in' && dealerId) throw pricingError(422, 'walk_in scope cannot include dealerId.');

  const [dealer, selectedDealerType, product] = await Promise.all([
    loadDealer(dealerId, session),
    dealerId ? null : loadDealerType(dealerTypeId, session),
    loadProduct(productInput, session),
  ]);
  const dealerType = dealer?.dealerType || selectedDealerType;
  // An explicitly requested tier wins over the dealer type's own tier. The website
  // uses this to sell at MRP; without it a walk-in resolution always lands on
  // retailRate and the storefront would display one price and charge another.
  const preferredTier = requestedTier
    || (dealerType && TIER_FIELDS.has(dealerType.pricingTier) ? dealerType.pricingTier : null);
  const walkIn = !dealer && !dealerType;
  // A registered dealer without a configured DealerType gets the stable dealer
  // tier; request-controlled order/customer type may not select its price tier.
  const effectiveOrderType = dealer && !dealerType ? 'dealer' : orderType;
  const tier = chooseBaseRate(product, preferredTier, effectiveOrderType, walkIn);
  const discountDealerType = DISCOUNT_DEALER_TYPES[tier.requestedTier]
    || DISCOUNT_DEALER_TYPES[ORDER_TYPE_TIERS[effectiveOrderType]] || (walkIn ? 'retail' : 'dealer');

  const matched = proposedOverride
    ? { override: proposedOverride, scope: proposedOverride.scope || scope }
    : await findOverride({ branchId, dealer, dealerType, productId: product._id, quantity: qty, at, session });
  const override = matched?.override || null;
  let source = 'product_tier';
  let sourceId = null;
  let sourceName = tier.rateField;
  let pricingRate = tier.rate;
  let regularDiscountPerUnit = 0;
  let schemeDiscountPerUnit = 0;
  let effectiveRate = tier.rate;
  let slabSnapshot = null;
  let ruleSnapshot = null;

  if (override) {
    source = 'dealer_pricing';
    sourceId = override._id || null;
    sourceName = override.remarks || `${matched.scope} pricing override`;
    const calculated = calculateOverride(override, tier.rate, qty, dealer?.schemeEligible !== false);
    pricingRate = calculated.pricingRate;
    regularDiscountPerUnit = calculated.regularDiscountPerUnit;
    schemeDiscountPerUnit = calculated.schemeDiscountPerUnit;
    effectiveRate = calculated.effectiveRate;
    slabSnapshot = calculated.slab ? {
      minQty: calculated.slab.minQty, maxQty: calculated.slab.maxQty,
      rate: calculated.slab.rate, discountPercent: calculated.slab.discountPercent,
    } : null;
    ruleSnapshot = {
      scope: matched.scope, customRate: override.customRate,
      discountPercent: override.discountPercent, discountFlat: override.discountFlat,
      schemeDiscount: override.schemeDiscount, minQty: override.minQty,
    };
  } else if (dealer?.discountEligible !== false) {
    const rule = await findDiscount(branchId, product, discountDealerType, at, session);
    if (rule) {
      const calculated = calculateDiscountRule(rule, tier.rate, qty, { orderAmount });
      if (calculated.applied) {
        source = 'discount_mapping';
        sourceId = rule._id;
        sourceName = rule.ruleName;
        regularDiscountPerUnit = calculated.discountPerUnit;
        effectiveRate = calculated.effectiveRate;
        slabSnapshot = calculated.slab || null;
      }
      ruleSnapshot = {
        ruleName: rule.ruleName, targetType: rule.targetType, targetName: rule.targetName,
        discountType: rule.discountType, discountPercentage: rule.discountPercentage,
        discountFlat: rule.discountFlat, maxDiscountPercentage: rule.maxDiscountPercentage,
        minOrderQty: rule.minOrderQty, minOrderAmount: rule.minOrderAmount,
        applied: calculated.applied, reason: calculated.reason,
      };
    }
  }

  const hasManualRate = manualRate !== undefined && manualRate !== null && manualRate !== '';
  if (hasManualRate) {
    const requested = Number(manualRate);
    if (!Number.isFinite(requested) || requested < 0) throw pricingError(422, 'manualRate must be a non-negative finite number.');
    source = 'manual'; sourceName = 'Manual rate'; pricingRate = requested;
    regularDiscountPerUnit = 0; schemeDiscountPerUnit = 0; effectiveRate = requested;
  }

  pricingRate = roundMoney(Math.max(0, pricingRate));
  regularDiscountPerUnit = roundMoney(Math.min(pricingRate, Math.max(0, regularDiscountPerUnit)));
  schemeDiscountPerUnit = roundMoney(Math.min(
    Math.max(0, pricingRate - regularDiscountPerUnit), Math.max(0, schemeDiscountPerUnit)
  ));
  effectiveRate = roundMoney(Math.max(0, pricingRate - regularDiscountPerUnit - schemeDiscountPerUnit));
  const minimumSellingRate = roundMoney(nonNegative(product.minimumSellingRate));
  const belowMinimum = minimumSellingRate > 0 && effectiveRate < minimumSellingRate;

  return {
    product, dealer, dealerType, scope, quantity: qty, pricingDate: at,
    requestedTier: tier.requestedTier, rateField: tier.rateField,
    baseRate: roundMoney(tier.rate), fallbackApplied: tier.fallbackApplied,
    pricingRate, regularDiscountPerUnit,
    regularDiscountAmount: roundMoney(regularDiscountPerUnit * qty),
    schemeDiscountPerUnit,
    schemeDiscountAmount: roundMoney(schemeDiscountPerUnit * qty),
    effectiveRate, taxableAmount: roundMoney(effectiveRate * qty),
    minimumSellingRate, belowMinimum, requiresApproval: belowMinimum,
    source, sourceId, sourceName, overrideScope: matched?.scope || null,
    applicableOverride: override, slab: slabSnapshot, rule: ruleSnapshot,
    hasOverride: Boolean(override), discountDealerType,
    manualRate: hasManualRate ? roundMoney(Number(manualRate)) : null,
  };
}

export function pricingAuditSnapshot(resolution) {
  return {
    source: resolution.source, sourceId: resolution.sourceId, sourceName: resolution.sourceName,
    overrideScope: resolution.overrideScope, requestedTier: resolution.requestedTier,
    rateField: resolution.rateField, baseRate: resolution.baseRate,
    pricingRate: resolution.pricingRate, effectiveRate: resolution.effectiveRate,
    regularDiscountPerUnit: resolution.regularDiscountPerUnit,
    schemeDiscountPerUnit: resolution.schemeDiscountPerUnit,
    minimumSellingRate: resolution.minimumSellingRate, belowMinimum: resolution.belowMinimum,
    fallbackApplied: resolution.fallbackApplied, slab: resolution.slab, rule: resolution.rule,
    resolvedAt: new Date(),
  };
}

export { ORDER_TYPE_TIERS, TIER_FIELDS, PRICING_SCOPES, SELECTABLE_TIERS };
