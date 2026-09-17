import 'dotenv/config';
import mongoose from 'mongoose';
import Quotation from '../models/Quotation.js';
import SalesOrder from '../models/SalesOrder.js';
import QuotationConversion from '../models/QuotationConversion.js';
import Warehouse from '../models/Warehouse.js';
import Product from '../models/Product.js';
import Branch from '../models/Branch.js';
import { quotationStockEligibility } from '../services/quotationStockService.js';

const execute = process.argv.includes('--execute');
const dryRun = !execute;
const tolerance = 0.0001;
const idOf = value => String(value?._id || value || '');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const validDate = value => value && !Number.isNaN(new Date(value).getTime());
const validId = value => Boolean(value && mongoose.isValidObjectId(value));

const issueNames = [
  'missingBranch', 'invalidBranch', 'missingProduct', 'invalidProduct', 'missingItemId',
  'invalidItemQuantity', 'missingItemUomSnapshot', 'invalidItemUomSnapshot',
  'missingWarehouse', 'invalidWarehouse', 'missingValidity', 'invalidValidity',
  'approvalStatusMismatch', 'invalidApprovalFields', 'conversionMismatch', 'invalidConversionFields',
  'missingQueueTimestamp', 'invalidQueueTimestamp', 'snapshotCapturedAmbiguous',
  'invalidSnapshotFields', 'conversionLineageAmbiguous',
];

function recordIssue(report, type, quotation, detail) {
  report.counts[type] += 1;
  if (report.samples[type].length < 20) {
    report.samples[type].push({
      id: idOf(quotation._id),
      quotationNumber: quotation.quotationNumber || null,
      detail,
    });
  }
}

function conversionQuantitiesAreConsistent(quotation) {
  return (quotation.items || []).every(item => {
    const quantity = Number(item.quantity || 0);
    const converted = Number(item.convertedQuantity || 0);
    return Number.isFinite(quantity) && Number.isFinite(converted)
      && converted >= -tolerance && converted <= quantity + tolerance;
  });
}

// Migration audit evidence deliberately ignores the stored conversionState.
function evidenceConversionState(quotation, orders, ledger) {
  if (!conversionQuantitiesAreConsistent(quotation)) {
    return { state: null, ambiguous: true, reason: 'item converted quantities are invalid' };
  }
  const items = quotation.items || [];
  const allConverted = items.length > 0 && items.every(item =>
    Number(item.convertedQuantity || 0) >= Number(item.quantity || 0) - tolerance
  );
  const anyConverted = items.some(item => Number(item.convertedQuantity || 0) > tolerance);
  const activeLedger = ledger.filter(value => value.status !== 'voided');
  const lineageEvidence = orders.length > 0 || activeLedger.length > 0
    || Boolean(quotation.convertedToSO) || (quotation.convertedSalesOrders || []).length > 0;
  if (allConverted) return { state: 'full', ambiguous: false };
  if (anyConverted) return { state: 'partial', ambiguous: false };
  if (quotation.status === 'converted' || lineageEvidence) {
    return { state: null, ambiguous: true, reason: 'legacy conversion lineage exists without independently derived item quantities' };
  }
  return { state: 'none', ambiguous: false };
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const quotations = await Quotation.collection.find({}).toArray();
  const quotationIds = quotations.map(value => value._id);
  const [branches, products, warehouses, sourceOrders, conversions] = await Promise.all([
    Branch.find({ _id: { $in: quotations.map(value => value.branch).filter(validId) } }).select('_id').lean(),
    Product.find({ _id: { $in: quotations.flatMap(value => (value.items || []).map(item => item.product)).filter(validId) } }).select('_id').lean(),
    Warehouse.find({ _id: { $in: quotations.flatMap(value => (value.items || []).map(item => item.warehouse)).filter(validId) } }).select('_id branch').lean(),
    SalesOrder.find({ sourceQuotation: { $in: quotationIds } }).select('_id sourceQuotation').lean(),
    QuotationConversion.find({ quotation: { $in: quotationIds } }).select('_id quotation salesOrder status').lean(),
  ]);
  const branchIds = new Set(branches.map(value => idOf(value._id)));
  const productIds = new Set(products.map(value => idOf(value._id)));
  const warehouseById = new Map(warehouses.map(value => [idOf(value._id), value]));
  const ordersByQuotation = new Map();
  for (const order of sourceOrders) {
    const key = idOf(order.sourceQuotation);
    ordersByQuotation.set(key, [...(ordersByQuotation.get(key) || []), order]);
  }
  const conversionsByQuotation = new Map();
  for (const conversion of conversions) {
    const key = idOf(conversion.quotation);
    conversionsByQuotation.set(key, [...(conversionsByQuotation.get(key) || []), conversion]);
  }

  const report = {
    mode: dryRun ? 'dry-run' : 'execute',
    inspected: quotations.length,
    counts: Object.fromEntries(issueNames.map(name => [name, 0])),
    samples: Object.fromEntries(issueNames.map(name => [name, []])),
    safeUpdates: { conversionState: 0, stockQueuedAt: 0, snapshotCaptured: 0 },
    appliedUpdates: { conversionState: 0, stockQueuedAt: 0, snapshotCaptured: 0 },
    skippedConcurrentUpdates: { conversionState: 0, stockQueuedAt: 0, snapshotCaptured: 0 },
  };
  const operations = { conversionState: [], stockQueuedAt: [], snapshotCaptured: [] };

  for (const quotation of quotations) {
    const quotationId = idOf(quotation._id);
    if (!quotation.branch) {
      recordIssue(report, 'missingBranch', quotation, 'branch is missing');
    } else if (!validId(quotation.branch) || !branchIds.has(idOf(quotation.branch))) {
      recordIssue(report, 'invalidBranch', quotation, 'branch is malformed or does not reference an existing branch');
    }
    if (!quotation.validUntil) {
      recordIssue(report, 'missingValidity', quotation, 'validUntil is missing');
    } else if (!validDate(quotation.validUntil)) {
      recordIssue(report, 'invalidValidity', quotation, 'validUntil is invalid');
    }
    for (const [index, item] of (quotation.items || []).entries()) {
      if (!item._id) recordIssue(report, 'missingItemId', quotation, `item ${index} has no _id`);
      if (!item.product) {
        recordIssue(report, 'missingProduct', quotation, `item ${index} product is missing`);
      } else if (!validId(item.product) || !productIds.has(idOf(item.product))) {
        recordIssue(report, 'invalidProduct', quotation, `item ${index} product is malformed or does not exist`);
      }
      const quantity = Number(item.quantity);
      const convertedQuantity = Number(item.convertedQuantity || 0);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(convertedQuantity)
          || convertedQuantity < -tolerance || convertedQuantity > quantity + tolerance) {
        recordIssue(report, 'invalidItemQuantity', quotation, `item ${index} has invalid quantity or convertedQuantity`);
      }
      const hasAnyUomSnapshot = [
        'baseQuantity', 'baseUnit', 'conversionFactor', 'uomVersion', 'uomPrecision', 'uomAllowFraction',
      ].some(field => own(item, field));
      const factor = Number(item.conversionFactor);
      const baseQuantity = Number(item.baseQuantity);
      const uomVersion = Number(item.uomVersion);
      const uomPrecision = Number(item.uomPrecision);
      const precisionScale = 10 ** uomPrecision;
      const quantityConformsToPrecision = Number.isFinite(quantity)
        && Math.abs(quantity * precisionScale - Math.round(quantity * precisionScale)) <= 1e-8;
      const convertedConformsToPrecision = Number.isFinite(convertedQuantity)
        && Math.abs(convertedQuantity * precisionScale - Math.round(convertedQuantity * precisionScale)) <= 1e-8;
      const fractionPolicySatisfied = item.uomAllowFraction === true
        || (Math.abs(quantity - Math.round(quantity)) <= 1e-8
          && Math.abs(convertedQuantity - Math.round(convertedQuantity)) <= 1e-8);
      const validUomSnapshot = Number.isFinite(factor) && factor > 0
        && Number.isFinite(baseQuantity) && baseQuantity >= 0
        && Math.abs(baseQuantity - quantity * factor) <= Math.max(tolerance, Math.abs(baseQuantity) * 1e-8)
        && Boolean(String(item.baseUnit || '').trim())
        && Number.isInteger(uomVersion) && uomVersion >= 1
        && Number.isInteger(uomPrecision) && uomPrecision >= 0 && uomPrecision <= 6
        && typeof item.uomAllowFraction === 'boolean'
        && quantityConformsToPrecision && convertedConformsToPrecision
        && fractionPolicySatisfied;
      if (!hasAnyUomSnapshot) {
        recordIssue(report, 'missingItemUomSnapshot', quotation, `item ${index} has no immutable base-UOM snapshot; live allocation remains unknown`);
      } else if (!validUomSnapshot) {
        recordIssue(report, 'invalidItemUomSnapshot', quotation, `item ${index} base quantity/unit/factor/version/precision/fraction policy are incomplete or inconsistent`);
      }
      if (!item.warehouse) {
        recordIssue(report, 'missingWarehouse', quotation, `item ${index} has no warehouse constraint (allocation is ambiguous across branch warehouses)`);
      } else {
        const warehouse = warehouseById.get(idOf(item.warehouse));
        if (!validId(item.warehouse) || !warehouse || idOf(warehouse.branch) !== idOf(quotation.branch)) {
          recordIssue(report, 'invalidWarehouse', quotation, `item ${index} warehouse is malformed, missing, or belongs to another branch`);
        }
      }
    }

    const eligibility = quotationStockEligibility(quotation);
    const allowedApprovalStatuses = new Set(['not_required', 'pending', 'approved', 'rejected']);
    if (!allowedApprovalStatuses.has(quotation.approvalStatus || (quotation.approvalRequired ? 'pending' : 'not_required'))
        || !Array.isArray(quotation.approvalReasons)) {
      recordIssue(report, 'invalidApprovalFields', quotation, 'approvalStatus or approvalReasons is malformed');
    }
    if (['approved', 'accepted'].includes(quotation.status) && !eligibility.pricingApprovalSatisfied) {
      recordIssue(report, 'approvalStatusMismatch', quotation, eligibility.reason);
    }
    if (quotation.status === 'pending_approval' && eligibility.pricingApprovalSatisfied) {
      recordIssue(report, 'approvalStatusMismatch', quotation, 'pending_approval status has no unresolved pricing approval');
    }
    if (!['none', 'partial', 'full', undefined, null].includes(quotation.conversionState)
        || (quotation.conversionVersion !== undefined
          && (!Number.isInteger(Number(quotation.conversionVersion)) || Number(quotation.conversionVersion) < 0))) {
      recordIssue(report, 'invalidConversionFields', quotation, 'conversionState or conversionVersion is malformed');
    }

    const orders = ordersByQuotation.get(quotationId) || [];
    const ledger = conversionsByQuotation.get(quotationId) || [];
    const evidence = evidenceConversionState(quotation, orders, ledger);
    if (evidence.ambiguous) {
      recordIssue(report, 'conversionMismatch', quotation, evidence.reason);
    } else if (!own(quotation, 'conversionState') || quotation.conversionState !== evidence.state) {
      recordIssue(report, 'conversionMismatch', quotation, `stored ${quotation.conversionState || 'missing'}, independently derived ${evidence.state}`);
    }
    const queueStatus = ['approved', 'accepted'].includes(quotation.status)
      || (quotation.status === 'sent' && validDate(quotation.approvalDate));
    const queueShouldBeEligible = queueStatus && eligibility.pricingApprovalSatisfied
      && eligibility.uomSnapshotSatisfied && !eligibility.isExpired && !eligibility.terminal;
    if (queueShouldBeEligible && !quotation.stockQueuedAt) {
      recordIssue(report, 'missingQueueTimestamp', quotation, 'otherwise eligible FIFO record has no stockQueuedAt');
    } else if (quotation.stockQueuedAt && !validDate(quotation.stockQueuedAt)) {
      recordIssue(report, 'invalidQueueTimestamp', quotation, 'stockQueuedAt is invalid; record remains physical-only');
    }

    const itemSnapshotEvidence = (quotation.items || []).some(item =>
      own(item, 'stockAtQuotation') || own(item, 'outOfStock')
    );
    const invalidSnapshotItem = (quotation.items || []).findIndex(item =>
      (own(item, 'stockAtQuotation') && item.stockAtQuotation !== null
        && (!Number.isFinite(Number(item.stockAtQuotation)) || Number(item.stockAtQuotation) < 0))
      || (own(item, 'outOfStock') && typeof item.outOfStock !== 'boolean')
    );
    if (invalidSnapshotItem >= 0) {
      recordIssue(report, 'invalidSnapshotFields', quotation, `item ${invalidSnapshotItem} has malformed stockAtQuotation or outOfStock`);
    }
    if (quotation.snapshotCaptured !== undefined && typeof quotation.snapshotCaptured !== 'boolean') {
      recordIssue(report, 'invalidSnapshotFields', quotation, 'snapshotCaptured is not boolean');
    }
    if (quotation.stockSnapshotAt && !validDate(quotation.stockSnapshotAt)) {
      recordIssue(report, 'invalidSnapshotFields', quotation, 'stockSnapshotAt is invalid');
    }
    if (quotation.snapshotCaptured === true && !validDate(quotation.stockSnapshotAt)) {
      recordIssue(report, 'snapshotCapturedAmbiguous', quotation, 'snapshotCaptured is true without stockSnapshotAt');
    } else if (!own(quotation, 'snapshotCaptured') && !validDate(quotation.stockSnapshotAt) && itemSnapshotEvidence) {
      recordIssue(report, 'snapshotCapturedAmbiguous', quotation, 'legacy item snapshot fields exist without capture provenance');
    }

    const activeLedger = ledger.filter(value => value.status !== 'voided');
    const conversionEvidence = quotation.status === 'converted'
      || evidence.state === 'partial' || evidence.state === 'full' || evidence.ambiguous
      || Boolean(quotation.convertedToSO) || (quotation.convertedSalesOrders || []).length > 0;
    const sourceOrderIds = new Set(orders.map(value => idOf(value._id)));
    const ledgerOrderIds = ledger.map(value => idOf(value.salesOrder)).filter(Boolean);
    const duplicateLedgerOrders = ledgerOrderIds.filter((value, index) => ledgerOrderIds.indexOf(value) !== index);
    const mismatchedLedgerOrders = ledgerOrderIds.filter(value => !sourceOrderIds.has(value));
    const uncoveredSourceOrders = [...sourceOrderIds].filter(value => !ledgerOrderIds.includes(value));
    if (conversionEvidence && !orders.length && !ledger.length) {
      recordIssue(report, 'conversionLineageAmbiguous', quotation, 'conversion evidence has no source Sales Order or conversion ledger');
    } else if (duplicateLedgerOrders.length || mismatchedLedgerOrders.length || uncoveredSourceOrders.length) {
      recordIssue(report, 'conversionLineageAmbiguous', quotation, [
        duplicateLedgerOrders.length ? `duplicate ledger coverage: ${[...new Set(duplicateLedgerOrders)].join(', ')}` : '',
        mismatchedLedgerOrders.length ? `ledger references missing or unrelated source orders: ${mismatchedLedgerOrders.join(', ')}` : '',
        uncoveredSourceOrders.length ? `source orders without ledger coverage: ${uncoveredSourceOrders.join(', ')}` : '',
      ].filter(Boolean).join('; '));
    } else if (orders.length > 1 && activeLedger.length < orders.length) {
      recordIssue(report, 'conversionLineageAmbiguous', quotation, 'multiple source Sales Orders are not fully represented by active conversion ledger rows');
    }

    // Every execute update is compare-and-set against the observed timestamp
    // and missing destination field. Records without a trustworthy timestamp
    // remain report-only rather than risking a stale overwrite.
    if (!validDate(quotation.updatedAt)) continue;
    const observed = { _id: quotation._id, updatedAt: quotation.updatedAt };
    if (!own(quotation, 'conversionState') && !evidence.ambiguous) {
      operations.conversionState.push({
        updateOne: {
          filter: { ...observed, conversionState: { $exists: false }, items: quotation.items },
          update: { $set: { conversionState: evidence.state } },
        },
      });
      report.safeUpdates.conversionState += 1;
    }
    // approvalDate is the only legacy timestamp that proves when approval made
    // demand eligible. createdAt is deliberately never used because it can jump FIFO.
    if (!quotation.stockQueuedAt && queueShouldBeEligible && validDate(quotation.approvalDate)) {
      operations.stockQueuedAt.push({
        updateOne: {
          filter: {
            ...observed,
            status: quotation.status,
            approvalDate: quotation.approvalDate,
            approvalStatus: quotation.approvalStatus,
            $or: [{ stockQueuedAt: null }, { stockQueuedAt: { $exists: false } }],
          },
          update: { $set: { stockQueuedAt: new Date(quotation.approvalDate) } },
        },
      });
      report.safeUpdates.stockQueuedAt += 1;
    }
    if (!own(quotation, 'snapshotCaptured')) {
      const snapshotCaptured = validDate(quotation.stockSnapshotAt)
        ? true
        : !itemSnapshotEvidence ? false : null;
      if (snapshotCaptured !== null) {
        operations.snapshotCaptured.push({
          updateOne: {
            filter: { ...observed, snapshotCaptured: { $exists: false } },
            update: { $set: { snapshotCaptured } },
          },
        });
        report.safeUpdates.snapshotCaptured += 1;
      }
    }
  }

  if (execute) {
    for (const [type, writes] of Object.entries(operations)) {
      if (!writes.length) continue;
      const result = await Quotation.collection.bulkWrite(writes, { ordered: false });
      report.appliedUpdates[type] = result.matchedCount;
      report.skippedConcurrentUpdates[type] = writes.length - result.matchedCount;
    }
  }
  const documentsWithSafeUpdates = new Set(Object.values(operations).flat().map(operation =>
    idOf(operation.updateOne.filter._id)
  )).size;
  console.log(JSON.stringify({ ...report, documentsWithSafeUpdates }, null, 2));
  console.log(dryRun
    ? 'Dry run complete: no writes or index changes were made. Use --execute only after reviewing every ambiguity.'
    : `Execute complete: ${documentsWithSafeUpdates} quotation(s) were considered for compare-and-set readiness metadata defaults.`);
}

run()
  .catch((error) => {
    console.error('Quotation readiness migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
