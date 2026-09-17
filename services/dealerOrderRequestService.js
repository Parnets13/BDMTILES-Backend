import { requestFingerprint } from '../utils/idempotency.js';
import { normalizeOrderItemsUom } from './orderPricingService.js';

const routeError = (status, message) => Object.assign(new Error(message), { status });
const roundQuantity = value => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;

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
