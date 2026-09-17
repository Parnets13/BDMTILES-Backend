import assert from 'node:assert/strict';
import {
  allocateQuotationReadiness,
  calculateQuotationReadiness,
  quotationConversionState,
  quotationStockEligibility,
} from '../services/quotationStockService.js';

const now = new Date('2026-09-16T12:00:00.000Z');
const yesterday = new Date('2026-09-15T10:00:00.000Z');
const tomorrow = new Date('2026-09-17T23:59:59.999Z');
const item = (overrides = {}) => ({
  _id: overrides._id || 'item-1',
  product: 'product-1',
  productName: 'Scenario Tile',
  quantity: 10,
  convertedQuantity: 0,
  unit: 'Box',
  baseQuantity: 10,
  baseUnit: 'Box',
  conversionFactor: 1,
  uomVersion: 1,
  uomPrecision: 6,
  uomAllowFraction: true,
  ...overrides,
});
const quotation = (status, overrides = {}) => ({
  _id: `${status}-${overrides._id || 'q'}`,
  branch: 'branch-1',
  status,
  createdAt: yesterday,
  quotationDate: yesterday,
  validUntil: tomorrow,
  approvalRequired: false,
  approvalStatus: 'not_required',
  approvalReasons: [],
  conversionState: 'none',
  items: [item()],
  ...overrides,
});
const stock = quantity => [{
  _id: 'stock-1', branch: 'branch-1', product: 'product-1', warehouse: 'warehouse-1',
  shade: '', batch: '', availableQty: quantity,
}];

for (const status of ['draft', 'pending_approval']) {
  const source = quotation(status);
  assert.equal(quotationStockEligibility(source, now).queueEligible, false, `${status} must remain physical-only`);
  assert.equal(calculateQuotationReadiness(source, stock(10), null, { checkedAt: now }).overallStatus, 'available');
}
for (const status of ['approved', 'accepted']) {
  const eligible = quotation(status, { stockQueuedAt: yesterday });
  assert.equal(quotationStockEligibility(eligible, now).conversionEligible, true, `${status} must be eligible`);
}
const legacyApprovalWithoutQueueTime = quotation('approved');
assert.equal(quotationStockEligibility(legacyApprovalWithoutQueueTime, now).queueEligible, false, 'unmigrated legacy approval must not consume FIFO');
assert.equal(quotationStockEligibility(legacyApprovalWithoutQueueTime, now).conversionEligible, false, 'unmigrated legacy approval must not bypass FIFO during conversion');
assert.equal(quotationStockEligibility(legacyApprovalWithoutQueueTime, now).reason, 'missing_queue_timestamp');

const directSent = quotation('sent');
assert.equal(quotationStockEligibility(directSent, now).queueEligible, false, 'draft -> sent must not jump FIFO');
const approvedSent = quotation('sent', { stockQueuedAt: yesterday, approvalStatus: 'approved' });
assert.equal(quotationStockEligibility(approvedSent, now).queueEligible, true, 'approved -> sent must preserve FIFO');
assert.equal(quotationStockEligibility(approvedSent, now).conversionEligible, false, 'sent must still be accepted before conversion');

const partialConversion = quotation('accepted', {
  conversionState: 'partial',
  stockQueuedAt: yesterday,
  items: [item({ convertedQuantity: 6 })],
});
const partialReadiness = calculateQuotationReadiness(partialConversion, stock(2), null, { checkedAt: now, queued: true });
assert.equal(quotationConversionState(partialConversion), 'partial');
assert.equal(partialReadiness.totalRemainingQty, 4);
assert.equal(partialReadiness.overallStatus, 'partial');

const staleOutOfStockSnapshot = quotation('draft', { items: [item({ outOfStock: true, stockAtQuotation: 0 })] });
assert.equal(calculateQuotationReadiness(staleOutOfStockSnapshot, stock(10), null, { checkedAt: now }).overallStatus, 'available', 'historical OOS must not override live stock');
const staleAvailableSnapshot = quotation('draft', { items: [item({ outOfStock: false, stockAtQuotation: 10 })] });
assert.equal(calculateQuotationReadiness(staleAvailableSnapshot, stock(0), null, { checkedAt: now }).overallStatus, 'out_of_stock', 'historical availability must not override consumed stock');

const boxDemand = quotation('accepted', {
  stockQueuedAt: yesterday,
  items: [item({ quantity: 2, baseQuantity: 20, baseUnit: 'Piece', conversionFactor: 10 })],
});
const boxReadiness = calculateQuotationReadiness(boxDemand, stock(5), null, { checkedAt: now, queued: true });
assert.equal(boxReadiness.overallStatus, 'partial', 'base stock must not be compared directly with entered boxes');
assert.equal(boxReadiness.items[0].requiredBaseQty, 20);
assert.equal(boxReadiness.items[0].allocatedBaseQty, 5);
assert.equal(boxReadiness.items[0].allocatedQty, 0.5);
assert.equal(boxReadiness.items[0].shortfallQty, 1.5);
const wholeBoxDemand = quotation('accepted', {
  stockQueuedAt: yesterday,
  items: [item({
    quantity: 1,
    baseQuantity: 10,
    baseUnit: 'Piece',
    conversionFactor: 10,
    uomPrecision: 0,
    uomAllowFraction: false,
  })],
});
const justShortReadiness = calculateQuotationReadiness(wholeBoxDemand, stock(9.999), null, { checkedAt: now, queued: true });
assert.equal(justShortReadiness.overallStatus, 'out_of_stock', 'discrete UOM must not round insufficient base stock up to a whole unit');
assert.equal(justShortReadiness.items[0].allocatedQty, 0);
assert.equal(justShortReadiness.items[0].allocatedBaseQty, 0);
const excessPrecision = quotation('accepted', {
  stockQueuedAt: yesterday,
  items: [item({ quantity: 1.234, baseQuantity: 12.34, baseUnit: 'Piece', conversionFactor: 10, uomPrecision: 2 })],
});
assert.equal(quotationStockEligibility(excessPrecision, now).reason, 'uom_snapshot_missing_or_invalid');
assert.equal(calculateQuotationReadiness(excessPrecision, stock(20), null, { checkedAt: now }).overallStatus, 'unknown');

const approvalMismatch = quotation('approved', {
  approvalRequired: true,
  approvalStatus: 'pending',
  approvalReasons: [{ type: 'below_minimum_price', status: 'pending' }],
  stockQueuedAt: yesterday,
});
assert.equal(quotationStockEligibility(approvalMismatch, now).queueEligible, false, 'approval mismatch must not consume FIFO');

const expired = quotation('accepted', { validUntil: new Date('2026-09-14T23:59:59.999Z') });
assert.equal(quotationStockEligibility(expired, now).queueEligible, false, 'expired quotation must not consume FIFO');
const full = quotation('converted', { conversionState: 'full', items: [item({ convertedQuantity: 10 })] });
assert.equal(calculateQuotationReadiness(full, stock(10), null, { checkedAt: now }).overallStatus, 'fully_converted');
const fullyReversed = quotation('accepted', {
  conversionState: 'none',
  convertedToSO: 'historical-order-1',
  convertedSalesOrders: ['historical-order-1'],
});
assert.equal(quotationConversionState(fullyReversed), 'none', 'voided historical lineage must not recreate partial conversion state');

const fifoMap = allocateQuotationReadiness({
  queueCandidates: [approvalMismatch, approvedSent],
  requested: [approvalMismatch, approvedSent],
  stockRows: stock(10),
  checkedAt: now,
});
const mismatchReadiness = fifoMap.get(approvalMismatch._id);
const fifoReadiness = fifoMap.get(approvedSent._id);
assert.equal(mismatchReadiness.queueMode, 'physical_only');
assert.equal(mismatchReadiness.totalAllocatedQty, 10, 'ineligible record may inspect physical stock without consuming FIFO');
assert.equal(fifoReadiness.queueMode, 'queued_fifo');
assert.equal(fifoReadiness.totalAllocatedQty, 10, 'ineligible record ahead of an eligible record must not consume FIFO stock');

console.log('Quotation readiness scenarios passed: yesterday lifecycle states, sent FIFO policy, partial conversion, live-vs-snapshot stock, approval mismatch, expiry, and full conversion.');
