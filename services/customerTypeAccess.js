import { userHasPermission } from '../middleware/auth.js';
import {
  CUSTOMER_TYPES,
  PRICING_TIER_TO_CUSTOMER_TYPE,
  QUOTATION_TYPE_PERMISSIONS,
  SALES_ORDER_TYPE_PERMISSIONS,
} from '../config/permissions.js';

/**
 * Customer-type scoping for quotations and sales orders.
 *
 * The permissions `quotation.retail`, `sales.order.wholesaler` and the rest have
 * existed since the start and enforced nothing, so granting someone "retail only"
 * never actually restricted them. This makes them real.
 *
 * Two rules keep it from breaking live users:
 *
 * 1. Holding the aggregate (`quotation.management` / `sales.order.create`) still
 *    allows every customer type. Everyone who creates quotations today holds it, so
 *    nothing changes for them. The type permissions only bind when the aggregate is
 *    absent — which is what "grant retail only" now means.
 *
 * 2. An unknown or unmapped type is never denied. A quotation may legitimately carry
 *    `customerType: ''` (it is in the enum and is the default), a dealer may have no
 *    DealerType, and `projectRate` has no customerType counterpart. In all of those
 *    the aggregate governs, exactly as before.
 *
 * The type used for the decision is derived from the dealer server-side where
 * possible, not taken from the request body. `customerType` is client-supplied and
 * never validated against the linked dealer, so trusting it would let a caller
 * holding only `quotation.retail` create a wholesaler quotation by mislabelling it.
 */

const typeFromPricingTier = (tier) => PRICING_TIER_TO_CUSTOMER_TYPE[tier] || '';

/**
 * Work out which customer type a request really concerns.
 * `dealer` should be a dealer document with `dealerType` populated when available.
 */
export function resolveCustomerType({ dealer, requestedType } = {}) {
  const tier = dealer?.dealerType?.pricingTier;
  const fromDealer = typeFromPricingTier(tier);
  if (fromDealer) return { type: fromDealer, source: 'dealer_type' };

  // A walk-in — no dealer linked at all — is a retail sale by definition.
  if (dealer === null || dealer === undefined) {
    const claimed = String(requestedType || '').trim();
    if (!claimed || claimed === 'walk_in' || claimed === 'retail') {
      return { type: 'retail', source: 'walk_in' };
    }
    // A type was claimed with no dealer to corroborate it. Honour it for the check
    // (it is the only signal available) but mark the source so callers can tell.
    return CUSTOMER_TYPES.includes(claimed)
      ? { type: claimed, source: 'requested' }
      : { type: '', source: 'unknown' };
  }

  // Dealer present but its type is missing or maps to nothing we scope on.
  return { type: '', source: 'unmapped' };
}

const assertTypeAllowed = ({ user, type, aggregatePermission, typePermissions, label }) => {
  // Rule 1 — the aggregate still covers every type.
  if (userHasPermission(user, aggregatePermission)) return;

  // Rule 2 — nothing to scope on, so the aggregate check that already ran governs.
  if (!type) return;

  const required = `${typePermissions.prefix}${type}`;
  if (userHasPermission(user, required)) return;

  const held = typePermissions.all.filter((permission) => userHasPermission(user, permission));
  const error = new Error(
    held.length
      ? `You may only create ${label} for: ${held.map((p) => p.split('.').pop()).join(', ')}. This one is ${type}.`
      : `You are not permitted to create ${label} for ${type} customers.`
  );
  error.status = 403;
  error.code = 'CUSTOMER_TYPE_FORBIDDEN';
  throw error;
};

export function assertQuotationTypeAllowed(user, type) {
  assertTypeAllowed({
    user,
    type,
    aggregatePermission: 'quotation.management',
    typePermissions: { prefix: 'quotation.', all: QUOTATION_TYPE_PERMISSIONS },
    label: 'quotations',
  });
}

export function assertSalesOrderTypeAllowed(user, type) {
  assertTypeAllowed({
    user,
    type,
    aggregatePermission: 'sales.order.create',
    typePermissions: { prefix: 'sales.order.', all: SALES_ORDER_TYPE_PERMISSIONS },
    label: 'sales orders',
  });
}

/** Which customer types this user may transact, for the UI to hide the rest. */
export function allowedCustomerTypes(user, kind = 'quotation') {
  const aggregate = kind === 'quotation' ? 'quotation.management' : 'sales.order.create';
  if (userHasPermission(user, aggregate)) return [...CUSTOMER_TYPES];
  const prefix = kind === 'quotation' ? 'quotation.' : 'sales.order.';
  return CUSTOMER_TYPES.filter((type) => userHasPermission(user, `${prefix}${type}`));
}
