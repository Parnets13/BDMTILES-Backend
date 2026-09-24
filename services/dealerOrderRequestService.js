import { requestFingerprint } from '../utils/idempotency.js';
import { normalizeOrderItemsUom } from './orderPricingService.js';

const routeError = (status, message) => Object.assign(new Error(message), { status });
const roundQuantity = value => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;

/**
 * The tappable status boxes the dealer app shows on Orders and the Dashboard.
 *
 * Two properties this map must keep, and both are asserted in
 * scripts/validateDealerEmployeeFlow.mjs against the model's own enum:
 *
 *   1. COMPLETE — every status on DealerOrderRequest appears in exactly one
 *      group, so no request can be invisible from every box.
 *   2. DISJOINT — no status appears in two groups, so the boxes never
 *      double-count and `all` is always the sum of the others.
 *
 * `all` is deliberately an empty list: it means "no status filter", which is also
 * why it is the default view.
 *
 * `pending` is the one a dealer actually wants: everything still in flight,
 * whether the ball is with BDMTILES, with stock, or with the dealer. `submitted`
 * is kept separate because it is the only one that means "nobody has looked at
 * this yet".
 */
export const ORDER_STATUS_GROUPS = {
  all: [],
  submitted: ['submitted'],
  pending: ['partially_processed', 'awaiting_dealer', 'awaiting_stock', 'quotation_linked'],
  approved: ['approved'],
  rejected: ['rejected'],
  cancelled: ['cancelled'],
};

/** Display order for the boxes, and the default (`all`) is first. */
export const ORDER_STATUS_GROUP_ORDER = ['all', 'submitted', 'pending', 'approved', 'rejected', 'cancelled'];

/** Labels the app renders. Kept server-side so both screens agree. */
export const ORDER_STATUS_GROUP_LABELS = {
  all: 'All',
  submitted: 'Submitted',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** Everything not yet resolved — the Dashboard's "in progress" figure. */
export const PENDING_ORDER_STATUSES = ORDER_STATUS_GROUPS.pending;

/**
 * Turn a group key into a Mongo status filter.
 *
 * An unknown or empty key falls back to `all` rather than to an empty result, so
 * a stale app build or a typo shows everything instead of a blank screen.
 */
export const statusFilterForGroup = (group) => {
  const statuses = ORDER_STATUS_GROUPS[String(group || '').toLowerCase()];
  if (!statuses || !statuses.length) return {};
  return { status: { $in: statuses } };
};

/** Resolve any requested group to a key that actually exists. */
export const resolveStatusGroup = (group) => {
  const key = String(group || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(ORDER_STATUS_GROUPS, key) ? key : 'all';
};

/**
 * Roll a per-status aggregation up into the group counts the boxes show.
 * `all` is the total, so the boxes always add up to it.
 */
export const buildStatusCounts = (rows = []) => {
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const counts = { all: rows.reduce((sum, row) => sum + row.count, 0) };
  for (const [key, statuses] of Object.entries(ORDER_STATUS_GROUPS)) {
    if (key === 'all') continue;
    counts[key] = statuses.reduce((sum, status) => sum + (byStatus[status] || 0), 0);
  }
  return counts;
};

function productId(item) {
  return String(item?.product?._id || item?.product || '');
}

export function orderRequestFingerprint(dealerId, items) {
  const canonicalItems = (items || [])
    .map(item => ({ product: productId(item), quantity: roundQuantity(item.quantity ?? item.boxes) }))
    .sort((left, right) => left.product.localeCompare(right.product));
  return requestFingerprint({ dealer: String(dealerId || ''), items: canonicalItems });
}

export async function buildTrustedRequestItems(items, session = null) {
  if (!Array.isArray(items) || items.length === 0) throw routeError(422, 'At least one item is required.');
  if (items.length > 100) throw routeError(422, 'A maximum of 100 items is allowed.');

  const ids = items.map(productId);
  if (new Set(ids).size !== ids.length) throw routeError(422, 'Each product may appear only once.');

  const normalized = await normalizeOrderItemsUom(items, session);
  return normalized.map(({ product, source, quantity }) => ({
    product: product._id,
    productCode: product.productCode || '',
    productName: product.itemName,
    productImage: product.images?.[0] || '',
    unit: product.unit || 'Box',
    tileSize: product.tileSize || '',
    finish: product.finish || '',
    colour: product.colour || '',
    quantity,
    boxes: source.boxes,
    pieces: source.pieces,
    sqft: source.sqft,
    piecesPerBox: Number(product.piecesPerBox),
    sqftPerBox: Number(product.sqftPerBox),
  }));
}

export async function refreshAndFingerprintRequest(request, session = null) {
  const items = await buildTrustedRequestItems(
    request.items.map(item => ({ product: item.product?._id || item.product, quantity: item.quantity })),
    session,
  );
  return { items, fingerprint: orderRequestFingerprint(request.dealer?._id || request.dealer, items) };
}

export async function assertQuotationMatchesRequest(request, dealerId, quotationItems, session = null) {
  if (String(request.dealer?._id || request.dealer) !== String(dealerId || '')) {
    throw routeError(422, 'Quotation dealer must match the approved dealer order request.');
  }
  const normalizedQuotationItems = await buildTrustedRequestItems(quotationItems, session);
  const quotationFingerprint = orderRequestFingerprint(dealerId, normalizedQuotationItems);
  const approvedFingerprint = request.approvedFingerprint
    || orderRequestFingerprint(request.dealer?._id || request.dealer, request.items);
  if (quotationFingerprint !== approvedFingerprint) {
    throw routeError(422, 'Quotation products and quantities must exactly match the approved dealer order request.');
  }
  return normalizedQuotationItems;
}
