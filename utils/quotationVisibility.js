import { userHasPermission } from '../middleware/auth.js';

/**
 * Field-level visibility for quotations.
 *
 * A quotation line carries two kinds of money. The first is what the customer is
 * asked to pay — rate, discount, tax, line total — and everyone who can open the
 * quotation needs it. The second is what the business keeps to itself: the tier
 * base rate the line was priced from, the floor the company will not sell below,
 * and whether the line breached that floor. Until now all of it was returned to
 * every holder of `quotation.management`, including sales executives, because the
 * only gate was the screen-level permission.
 *
 * `quotation.cost.view` splits the two. Losing it does not hide a quotation — it
 * hides the internal cost columns on one. The role defaults keep it switched on
 * for every role that already had it, so nothing disappears from a working screen
 * on upgrade; an administrator turns it off per role to actually restrict it.
 */
export const QUOTATION_COST_PERMISSION = 'quotation.cost.view';

/** Snapshot keys that expose internal cost rather than the offered price. */
const INTERNAL_SNAPSHOT_KEYS = ['baseRate', 'minimumSellingRate', 'belowMinimum'];

/** Line-level mirrors of the same three fields. */
const INTERNAL_LINE_KEYS = ['baseRate', 'minimumSellingRate', 'belowMinimum'];

export const canSeeQuotationCosts = (user) => Boolean(user) && userHasPermission(user, QUOTATION_COST_PERMISSION);

const hideLine = (item) => {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if (next.pricingSnapshot && typeof next.pricingSnapshot === 'object') {
    const snapshot = { ...next.pricingSnapshot };
    INTERNAL_SNAPSHOT_KEYS.forEach((key) => { delete snapshot[key]; });
    snapshot.costHidden = true;
    next.pricingSnapshot = snapshot;
  }
  INTERNAL_LINE_KEYS.forEach((key) => { delete next[key]; });
  // An explicit flag, so the screen can say "hidden for your role" instead of
  // printing a zero that reads like a free quotation.
  next.costHidden = true;
  return next;
};

const hideApprovalReasons = (reasons) => {
  if (!Array.isArray(reasons)) return reasons;
  // `thresholdValue` is the minimum selling rate restated on the approval record.
  // Leaving it in would undo the strip on the line it refers to.
  return reasons.map((reason) => {
    if (!reason || typeof reason !== 'object') return reason;
    const { thresholdValue, ...rest } = reason;
    return rest;
  });
};

/**
 * Returns a copy of a quotation with internal cost removed, or the quotation
 * untouched when the caller is allowed to see it. Always a copy in the hidden
 * case: the same document is reused by later steps in the request.
 */
export const hideQuotationCosts = (quotation) => {
  if (!quotation || typeof quotation !== 'object') return quotation;
  const next = { ...quotation };
  if (Array.isArray(next.items)) next.items = next.items.map(hideLine);
  if (next.approvalReasons) next.approvalReasons = hideApprovalReasons(next.approvalReasons);
  next.costVisible = false;
  return next;
};

/**
 * A priced line or a saved quotation is what this permission governs. Identified
 * by carrying a pricing snapshot or a quotation number rather than by shape alone,
 * so an unrelated payload travelling in the same response is left untouched.
 */
const looksLikeQuotation = (value) =>
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && (typeof value.quotationNumber === 'string' || Boolean(value.pricingSnapshot));

/**
 * The product-browser rows that feed the quotation editor carry the same three
 * cost fields at the top level. Stripped separately because those rows have no
 * pricing snapshot to walk.
 */
export const hideProductCosts = (row) => {
  if (!row || typeof row !== 'object') return row;
  const { baseRate, minimumSellingRate, belowMinimum, ...rest } = row;
  return { ...rest, costHidden: true };
};

/**
 * Walks a response body and strips internal cost from every quotation it finds.
 *
 * Applied at the response boundary instead of inside each handler. There are
 * thirteen quotation responses today and more will be added; a serializer that
 * each new handler must remember to call is a permission that leaks the first
 * time someone forgets. Walking the finished body cannot be forgotten.
 */
export const stripQuotationCostsDeep = (node, depth = 0) => {
  if (depth > 6 || !node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((entry) => stripQuotationCostsDeep(entry, depth + 1));
  if (looksLikeQuotation(node)) return hideQuotationCosts(node);
  const next = {};
  Object.entries(node).forEach(([key, value]) => {
    next[key] = stripQuotationCostsDeep(value, depth + 1);
  });
  return next;
};

export const applyQuotationCostVisibilityToList = (quotations, user) =>
  (canSeeQuotationCosts(user)
    ? quotations
    : (Array.isArray(quotations) ? quotations.map(hideQuotationCosts) : quotations));
