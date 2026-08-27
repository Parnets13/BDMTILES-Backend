export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * The single authoritative DiscountMapping formula. Flat discounts are per unit,
 * quantity slabs are inclusive, and line base amount is used when no order total
 * is available for minOrderAmount.
 */
export function calculateDiscountRule(rule, rate, quantity = 1, options = {}) {
  const unitRate = nonNegative(rate);
  const qty = nonNegative(quantity);
  const baseAmount = unitRate * qty;
  const orderAmount = nonNegative(options.orderAmount, baseAmount);

  if (!rule || qty <= 0) {
    return {
      applied: false,
      reason: rule ? 'Quantity must be greater than zero.' : 'No discount rule.',
      baseAmount: roundMoney(baseAmount),
      discountAmount: 0,
      discountPerUnit: 0,
      discountPercentage: 0,
      effectiveRate: roundMoney(unitRate),
      taxableAmount: roundMoney(baseAmount),
      slab: null,
    };
  }

  if (nonNegative(rule.minOrderQty) > qty) {
    return {
      applied: false,
      reason: `Minimum quantity ${rule.minOrderQty} not met.`,
      baseAmount: roundMoney(baseAmount),
      discountAmount: 0,
      discountPerUnit: 0,
      discountPercentage: 0,
      effectiveRate: roundMoney(unitRate),
      taxableAmount: roundMoney(baseAmount),
      slab: null,
    };
  }

  if (nonNegative(rule.minOrderAmount) > orderAmount) {
    return {
      applied: false,
      reason: `Minimum order amount ${rule.minOrderAmount} not met.`,
      baseAmount: roundMoney(baseAmount),
      discountAmount: 0,
      discountPerUnit: 0,
      discountPercentage: 0,
      effectiveRate: roundMoney(unitRate),
      taxableAmount: roundMoney(baseAmount),
      slab: null,
    };
  }

  let percentage = 0;
  let flatPerUnit = 0;
  let slab = null;

  if (rule.discountType === 'slab') {
    slab = [...(rule.slabs || [])]
      .sort((a, b) => nonNegative(b.minQty) - nonNegative(a.minQty))
      .find((entry) => qty >= nonNegative(entry.minQty)
        && (nonNegative(entry.maxQty) === 0 || qty <= nonNegative(entry.maxQty))) || null;
    if (slab) {
      percentage = Math.min(100, nonNegative(slab.discountPercentage));
      flatPerUnit = nonNegative(slab.discountFlat);
    }
  } else {
    if (rule.discountType === 'percentage' || rule.discountType === 'both') {
      percentage = Math.min(100, nonNegative(rule.discountPercentage));
    }
    if (rule.discountType === 'flat' || rule.discountType === 'both') {
      flatPerUnit = nonNegative(rule.discountFlat);
    }
  }

  let discountAmount = (baseAmount * percentage) / 100 + flatPerUnit * qty;
  const capPercentage = Math.min(100, nonNegative(rule.maxDiscountPercentage, 100));
  discountAmount = Math.max(0, Math.min(discountAmount, (baseAmount * capPercentage) / 100, baseAmount));
  const discountPerUnit = qty > 0 ? discountAmount / qty : 0;

  return {
    applied: discountAmount > 0,
    reason: rule.discountType === 'slab' && !slab ? 'No quantity slab matched.' : '',
    baseAmount: roundMoney(baseAmount),
    discountAmount: roundMoney(discountAmount),
    discountPerUnit: roundMoney(discountPerUnit),
    discountPercentage: baseAmount > 0 ? roundMoney((discountAmount / baseAmount) * 100) : 0,
    effectiveRate: roundMoney(Math.max(0, unitRate - discountPerUnit)),
    taxableAmount: roundMoney(Math.max(0, baseAmount - discountAmount)),
    slab,
  };
}
