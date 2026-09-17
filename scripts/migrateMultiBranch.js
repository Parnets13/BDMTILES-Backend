import 'dotenv/config';
import mongoose from 'mongoose';
import ActivityLog from '../models/ActivityLog.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import Attendance from '../models/Attendance.js';
import BankReconciliation from '../models/BankReconciliation.js';
import Branch from '../models/Branch.js';
import BranchSettings from '../models/BranchSettings.js';
import BranchSequence from '../models/BranchSequence.js';
import Complaint from '../models/Complaint.js';
import Dealer from '../models/Dealer.js';
import DealerLedger from '../models/DealerLedger.js';
import DealerPricing from '../models/DealerPricing.js';
import Delivery from '../models/Delivery.js';
import DiscountMapping from '../models/DiscountMapping.js';
import Dispatch from '../models/Dispatch.js';
import DispatchTrip from '../models/DispatchTrip.js';
import Employee from '../models/Employee.js';
import Expense from '../models/Expense.js';
import GRN from '../models/GRN.js';
import HrmsSettings from '../models/HrmsSettings.js';
import Invoice from '../models/Invoice.js';
import Lead from '../models/Lead.js';
import Leave from '../models/Leave.js';
import Loan from '../models/Loan.js';
import NotificationSettings from '../models/NotificationSettings.js';
import NotificationTemplate from '../models/NotificationTemplate.js';
import Payment from '../models/Payment.js';
import PickList from '../models/PickList.js';
import Product from '../models/Product.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import PurchaseRequisition from '../models/PurchaseRequisition.js';
import SupplierQuotation from '../models/SupplierQuotation.js';
import PurchaseReturn from '../models/PurchaseReturn.js';
import Quotation from '../models/Quotation.js';
import QuotationConversion from '../models/QuotationConversion.js';
import RecycleBin from '../models/RecycleBin.js';
import SalarySlip from '../models/SalarySlip.js';
import SalesOrder from '../models/SalesOrder.js';
import SalesReturn from '../models/SalesReturn.js';
import Stock from '../models/Stock.js';
import StockTransfer from '../models/StockTransfer.js';
import Supplier from '../models/Supplier.js';
import SupplierLedger from '../models/SupplierLedger.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import Warehouse from '../models/Warehouse.js';

const DEFAULT_CODE = String(process.env.DEFAULT_BRANCH_CODE || 'MAIN').trim().toUpperCase();
const DEFAULT_NAME = String(process.env.DEFAULT_BRANCH_NAME || 'Main Branch').trim();

const DEFAULT_NUMBERING = {
  salesOrder: { prefix: 'SO', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  quotation: { prefix: 'QT', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  invoice: { prefix: 'INV', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  purchaseOrder: { prefix: 'PO', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  supplierQuotation: { prefix: 'SQ', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  grn: { prefix: 'GRN', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  payment: { prefix: 'PAY', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  expense: { prefix: 'EXP', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  stockTransfer: { prefix: 'ST', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  salesReturn: { prefix: 'SR', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  creditNote: { prefix: 'CN', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  purchaseReturn: { prefix: 'DN', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  pickList: { prefix: 'PL', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  supplierInvoice: { prefix: 'SINV', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  dispatchTrip: { prefix: 'TRIP', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  dispatch: { prefix: 'DSP', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  purchaseRequisition: { prefix: 'PR', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  discountMapping: { prefix: 'DISC', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  delivery: { prefix: 'DEL', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  approval: { prefix: 'APR', padding: 5, includeBranchCode: true, includeFiscalYear: true },
  bankReconciliation: { prefix: 'BR', padding: 5, includeBranchCode: true, includeFiscalYear: true },
};

const branchOwnedCollections = [
  'approvalrequests', 'bankreconciliations', 'salesorders', 'quotations', 'invoices',
  'purchaseorders', 'grns', 'stocks', 'expenses', 'dealerpricings', 'payments',
  'salesreturns', 'purchasereturns', 'dealerledgers', 'supplierledgers',
  'supplierinvoices', 'picklists', 'dispatchtrips', 'dispatches', 'deliveries',
  'purchaserequisitions', 'supplierquotations', 'discountmappings',
];

const numberOwnerSpecs = [
  ['approvalrequests', 'branch', 'requestNumber'],
  ['bankreconciliations', 'branch', 'reconciliationNumber'],
  ['salesorders', 'branch', 'orderNumber'],
  ['quotations', 'branch', 'quotationNumber'],
  ['invoices', 'branch', 'invoiceNumber'],
  ['purchaseorders', 'branch', 'poNumber'],
  ['purchaserequisitions', 'branch', 'prNumber'],
  ['supplierquotations', 'branch', 'quotationNumber'],
  ['grns', 'branch', 'grnNumber'],
  ['payments', 'branch', 'paymentNumber'],
  ['expenses', 'branch', 'expenseNumber'],
  ['stocktransfers', 'sourceBranch', 'transferNumber'],
  ['salesreturns', 'branch', 'returnNumber'],
  ['salesreturns', 'branch', 'creditNoteNumber'],
  ['purchasereturns', 'branch', 'debitNoteNumber'],
  ['picklists', 'branch', 'pickListNumber'],
  ['supplierinvoices', 'branch', 'invoiceRefNumber'],
  ['dispatchtrips', 'branch', 'tripNumber'],
  ['deliveries', 'branch', 'deliveryNumber'],
];

const indexedModels = [
  Branch,
  BranchSettings,
  User,
  Warehouse,
  Employee,
  Attendance,
  Leave,
  SalarySlip,
  Loan,
  HrmsSettings,
  Task,
  Lead,
  Complaint,
  NotificationSettings,
  NotificationTemplate,
  ActivityLog,
  RecycleBin,
  Stock,
  DealerPricing,
  BranchSequence,
  ApprovalRequest,
  BankReconciliation,
  DealerLedger,
  SupplierLedger,
  SalesOrder,
  Quotation,
  QuotationConversion,
  Invoice,
  PurchaseOrder,
  PurchaseRequisition,
  SupplierQuotation,
  GRN,
  Payment,
  Expense,
  StockTransfer,
  SalesReturn,
  PurchaseReturn,
  PickList,
  DiscountMapping,
  Dispatch,
  DispatchTrip,
  Delivery,
];

function asObjectId(value) {
  if (!value || !mongoose.isValidObjectId(value)) return null;
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(value);
}

function positiveAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function historicalDate(document, preferredDate) {
  for (const value of [preferredDate, document.updatedAt, document.createdAt]) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  const id = asObjectId(document._id);
  return id ? id.getTimestamp() : new Date(0);
}

function sourceStats(label) {
  return {
    label,
    sources: 0,
    insertedEntries: 0,
    existingEntries: 0,
    skippedMissingBranch: 0,
    skippedMissingParty: 0,
    skippedInvalidAmount: 0,
    skippedInvalidSource: 0,
  };
}

function logSourceStats(stats) {
  console.log(
    `${stats.label}: ${stats.sources} source(s), ${stats.insertedEntries} ledger row(s) inserted, `
    + `${stats.existingEntries} existing row(s) preserved, skipped ${stats.skippedMissingBranch} missing-branch, `
    + `${stats.skippedMissingParty} missing-party, ${stats.skippedInvalidAmount} nonpositive/nonfinite-amount, `
    + `${stats.skippedInvalidSource} invalid-source record(s)`
  );
}

async function dropIndexIfPresent(collection, indexName) {
  const indexes = await collection.indexes();
  if (indexes.some((index) => index.name === indexName)) {
    await collection.dropIndex(indexName);
    console.log(`Dropped legacy index ${collection.collectionName}.${indexName}`);
  }
}

async function ensureBranchSettings(branches) {
  for (const branch of branches) {
    await BranchSettings.findOneAndUpdate(
      { branch: branch._id },
      { $setOnInsert: { branch: branch._id, fiscalYearStartMonth: 4, timezone: 'Asia/Kolkata' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  const settings = await BranchSettings.find({ branch: { $in: branches.map((branch) => branch._id) } }).lean();
  const operations = [];
  for (const setting of settings) {
    const set = {};
    if (!setting.numbering || typeof setting.numbering !== 'object') {
      set.numbering = DEFAULT_NUMBERING;
    } else {
      for (const [documentType, defaults] of Object.entries(DEFAULT_NUMBERING)) {
        const config = setting.numbering[documentType];
        if (!config || typeof config !== 'object') {
          set[`numbering.${documentType}`] = defaults;
          continue;
        }
        for (const [field, value] of Object.entries(defaults)) {
          if (config[field] === undefined) set[`numbering.${documentType}.${field}`] = value;
        }
      }
    }
    if (Object.keys(set).length) {
      operations.push({ updateOne: { filter: { _id: setting._id }, update: { $set: set } } });
    }
  }
  if (operations.length) await BranchSettings.collection.bulkWrite(operations, { ordered: true });
  console.log(`Ensured BranchSettings for ${branches.length} branch(es); completed missing numbering defaults on ${operations.length} setting(s)`);
  return BranchSettings.find({ branch: { $in: branches.map((branch) => branch._id) } }).lean();
}

async function preflightActiveInvoiceDuplicates() {
  const duplicates = await Invoice.collection.aggregate([
    {
      $match: {
        status: { $ne: 'cancelled' },
        branch: { $type: 'objectId' },
        salesOrder: { $type: 'objectId' },
      },
    },
    {
      $group: {
        _id: { branch: '$branch', salesOrder: '$salesOrder' },
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 25 },
  ]).toArray();

  if (duplicates.length) {
    const details = duplicates.map((duplicate) => (
      `branch=${duplicate._id.branch}, salesOrder=${duplicate._id.salesOrder}, invoiceIds=${duplicate.ids.join(',')}`
    )).join('\n  ');
    throw new Error(
      'Cannot create activeSalesOrderKey: multiple non-cancelled invoices exist for the same branch and sales order. '
      + `Cancel or otherwise resolve these invoices and rerun (showing up to 25 groups):\n  ${details}`
    );
  }
}

async function preflightSalesOrderQuotationDuplicates() {
  const duplicates = await SalesOrder.collection.aggregate([
    { $match: { branch: { $type: 'objectId' }, sourceQuotation: { $type: 'objectId' } } },
    {
      $group: {
        _id: { branch: '$branch', sourceQuotation: '$sourceQuotation' },
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 25 },
  ]).toArray();

  if (duplicates.length) {
    const details = duplicates.map((duplicate) => (
      `branch=${duplicate._id.branch}, sourceQuotation=${duplicate._id.sourceQuotation}, salesOrderIds=${duplicate.ids.join(',')}`
    )).join('\n  ');
    throw new Error(
      'Cannot create the Sales Order quotation-source uniqueness index. Resolve duplicate Sales Orders linked to the '
      + `same branch and quotation, then rerun (showing up to 25 groups):\n  ${details}`
    );
  }
  console.log('Sales Order quotation-source duplicate preflight passed');
}

async function preflightNumberDuplicates() {
  const failures = [];
  for (const [collectionName, ownerField, numberField] of numberOwnerSpecs) {
    const duplicates = await mongoose.connection.collection(collectionName).aggregate([
      { $match: { [ownerField]: { $type: 'objectId' }, [numberField]: { $type: 'string' } } },
      { $match: { $expr: { $ne: [{ $trim: { input: `$${numberField}` } }, ''] } } },
      {
        $group: {
          _id: { owner: `$${ownerField}`, number: `$${numberField}` },
          ids: { $push: '$_id' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 25 },
    ]).toArray();

    for (const duplicate of duplicates) {
      failures.push(
        `${collectionName}.${numberField} owner ${duplicate._id.owner} value ${JSON.stringify(duplicate._id.number)} `
        + `ids [${duplicate.ids.join(', ')}]`
      );
    }
  }

  if (failures.length) {
    throw new Error(
      'Cannot create owner-local unique document-number indexes. Resolve these duplicate human numbers and rerun '
      + `(empty/absent values were ignored; showing up to 25 groups per field):\n  ${failures.join('\n  ')}`
    );
  }
  console.log(`Document-number duplicate preflight passed for ${numberOwnerSpecs.length} owner/field pair(s)`);
}

async function upsertHistoricalEntry(collection, entry, stats) {
  const result = await collection.updateOne(
    { branch: entry.branch, postingKey: entry.postingKey },
    { $setOnInsert: entry },
    { upsert: true }
  );
  if (result.upsertedCount) stats.insertedEntries += 1;
  else stats.existingEntries += 1;
  return result;
}

function validatePostingSource(document, partyField, partyMap, branchIds, stats) {
  const branch = asObjectId(document.branch);
  if (!branch || !branchIds.has(String(branch))) {
    stats.skippedMissingBranch += 1;
    return null;
  }
  const partyId = asObjectId(document[partyField]);
  const party = partyId ? partyMap.get(String(partyId)) : null;
  if (!partyId || !party) {
    stats.skippedMissingParty += 1;
    return null;
  }
  return { branch, partyId, party };
}

function ledgerTimestamps(document, entryDate) {
  return {
    createdAt: historicalDate(document, document.createdAt || entryDate),
    updatedAt: historicalDate(document, document.updatedAt || entryDate),
  };
}

async function backfillHistoricalSubledgers({ branchIds, dealers, suppliers }) {
  const dealerMap = new Map(dealers.map((dealer) => [String(dealer._id), dealer]));
  const supplierMap = new Map(suppliers.map((supplier) => [String(supplier._id), supplier]));

  const salesOrderStats = sourceStats('Sales-order receivables');
  const salesOrders = SalesOrder.find({
    status: { $in: ['confirmed', 'approved', 'processing', 'partial_dispatch', 'dispatched', 'delivered'] },
  }).lean().cursor();
  for await (const order of salesOrders) {
    salesOrderStats.sources += 1;
    const source = validatePostingSource(order, 'dealer', dealerMap, branchIds, salesOrderStats);
    if (!source) continue;
    const amount = positiveAmount(order.grandTotal);
    if (!amount) {
      salesOrderStats.skippedInvalidAmount += 1;
      continue;
    }
    const entryDate = historicalDate(order, order.orderDate);
    await upsertHistoricalEntry(DealerLedger.collection, {
      branch: source.branch,
      dealer: source.partyId,
      dealerName: source.party.businessName,
      dealerCode: source.party.dealerCode,
      entryType: 'invoice',
      entryDate,
      description: `Receivable for Sales Order ${order.orderNumber || order._id}`,
      referenceNumber: order.orderNumber,
      referenceModel: 'SalesOrder',
      referenceId: order._id,
      postingKey: `sales-order:${order._id}:confirmed`,
      debit: amount,
      credit: 0,
      tallySyncStatus: 'not_synced',
      createdBy: asObjectId(order.createdBy) || undefined,
      ...ledgerTimestamps(order, entryDate),
    }, salesOrderStats);
  }
  logSourceStats(salesOrderStats);

  const paymentStats = sourceStats('Confirmed/bounced payments');
  let bouncedCount = 0;
  const payments = Payment.find({ status: { $in: ['confirmed', 'bounced'] } }).lean().cursor();
  for await (const payment of payments) {
    paymentStats.sources += 1;
    const isDealer = payment.paymentType === 'dealer_receipt';
    const isSupplier = payment.paymentType === 'supplier_payment';
    if (!isDealer && !isSupplier) {
      paymentStats.skippedInvalidSource += 1;
      continue;
    }
    const partyField = isDealer ? 'dealer' : 'supplier';
    const partyMap = isDealer ? dealerMap : supplierMap;
    const source = validatePostingSource(payment, partyField, partyMap, branchIds, paymentStats);
    if (!source) continue;
    const amount = positiveAmount(payment.amount);
    if (!amount) {
      paymentStats.skippedInvalidAmount += 1;
      continue;
    }

    const ledgerCollection = isDealer ? DealerLedger.collection : SupplierLedger.collection;
    const partySnapshot = isDealer
      ? { dealer: source.partyId, dealerName: source.party.businessName, dealerCode: source.party.dealerCode }
      : { supplier: source.partyId, supplierName: source.party.companyName, supplierCode: source.party.supplierCode };
    const entryDate = historicalDate(payment, payment.paymentDate);
    const originalKey = `payment:${payment._id}:confirmed`;
    await upsertHistoricalEntry(ledgerCollection, {
      branch: source.branch,
      ...partySnapshot,
      entryType: 'payment',
      entryDate,
      description: isDealer
        ? `Dealer receipt ${payment.paymentNumber || payment._id}`
        : `Supplier payment ${payment.paymentNumber || payment._id}`,
      referenceNumber: payment.paymentNumber,
      referenceModel: 'Payment',
      referenceId: payment._id,
      postingKey: originalKey,
      debit: isDealer ? 0 : amount,
      credit: isDealer ? amount : 0,
      tallySyncStatus: 'not_synced',
      createdBy: asObjectId(payment.createdBy) || undefined,
      ...ledgerTimestamps(payment, entryDate),
    }, paymentStats);

    if (payment.status !== 'bounced') continue;
    bouncedCount += 1;
    const original = await ledgerCollection.findOne({ branch: source.branch, postingKey: originalKey });
    const originalDebit = positiveAmount(original?.debit);
    const originalCredit = positiveAmount(original?.credit);
    if ((originalDebit !== null) === (originalCredit !== null)) {
      paymentStats.skippedInvalidSource += 1;
    } else {
      const bounceDate = historicalDate(payment, payment.updatedAt || payment.paymentDate);
      await upsertHistoricalEntry(ledgerCollection, {
        branch: source.branch,
        ...partySnapshot,
        entryType: 'payment',
        entryDate: bounceDate,
        description: `Reversal of bounced payment ${payment.paymentNumber || payment._id}`,
        referenceNumber: payment.paymentNumber,
        referenceModel: 'Payment',
        referenceId: payment._id,
        postingKey: `payment:${payment._id}:bounce:principal`,
        reversalOf: original._id,
        debit: originalCredit || 0,
        credit: originalDebit || 0,
        tallySyncStatus: 'not_synced',
        createdBy: asObjectId(payment.createdBy) || undefined,
        ...ledgerTimestamps(payment, bounceDate),
      }, paymentStats);
    }

    const charge = positiveAmount(payment.bounceCharges);
    if (isDealer && charge) {
      const bounceDate = historicalDate(payment, payment.updatedAt || payment.paymentDate);
      await upsertHistoricalEntry(DealerLedger.collection, {
        branch: source.branch,
        ...partySnapshot,
        entryType: 'debit_note',
        entryDate: bounceDate,
        description: `Bounce charge for payment ${payment.paymentNumber || payment._id}`,
        referenceNumber: payment.paymentNumber,
        referenceModel: 'Payment',
        referenceId: payment._id,
        postingKey: `payment:${payment._id}:bounce:charge`,
        debit: charge,
        credit: 0,
        tallySyncStatus: 'not_synced',
        createdBy: asObjectId(payment.createdBy) || undefined,
        ...ledgerTimestamps(payment, bounceDate),
      }, paymentStats);
    } else if (isDealer && payment.bounceCharges != null && Number(payment.bounceCharges) !== 0 && !charge) {
      paymentStats.skippedInvalidAmount += 1;
    }
  }
  logSourceStats(paymentStats);
  console.warn(
    `Reconstructed ${bouncedCount} bounced payment(s) conservatively as confirmed principal plus principal reversal. `
    + 'Persisted data does not reveal whether an old bounced cheque was still pending, and updatedAt is only a fallback for the historical bounce date.'
  );

  const grnStats = sourceStats('Approved/posted GRN purchases');
  const grns = GRN.find({ status: { $in: ['approved', 'posted'] } }).lean().cursor();
  for await (const grn of grns) {
    grnStats.sources += 1;
    const source = validatePostingSource(grn, 'supplier', supplierMap, branchIds, grnStats);
    if (!source) continue;
    const rawAmount = (grn.items || []).reduce(
      (sum, item) => sum + (Number(item.acceptedQty) * Number(item.rate)),
      0
    );
    const amount = positiveAmount(rawAmount);
    if (!amount) {
      grnStats.skippedInvalidAmount += 1;
      continue;
    }
    const entryDate = historicalDate(grn, grn.grnDate);
    await upsertHistoricalEntry(SupplierLedger.collection, {
      branch: source.branch,
      supplier: source.partyId,
      supplierName: source.party.companyName,
      supplierCode: source.party.supplierCode,
      entryType: 'purchase',
      entryDate,
      description: `Purchase received through GRN ${grn.grnNumber || grn._id}`,
      referenceNumber: grn.grnNumber,
      referenceModel: 'GRN',
      referenceId: grn._id,
      postingKey: `grn:${grn._id}:approved`,
      debit: 0,
      credit: amount,
      tallySyncStatus: 'not_synced',
      createdBy: asObjectId(grn.createdBy) || undefined,
      ...ledgerTimestamps(grn, entryDate),
    }, grnStats);
  }
  logSourceStats(grnStats);

  const salesReturnStats = sourceStats('Issued sales-return credit notes');
  const salesReturns = SalesReturn.find({ status: 'credit_issued', adjustmentType: 'credit_note' }).lean().cursor();
  for await (const salesReturn of salesReturns) {
    salesReturnStats.sources += 1;
    const source = validatePostingSource(salesReturn, 'dealer', dealerMap, branchIds, salesReturnStats);
    if (!source) continue;
    const amount = positiveAmount(salesReturn.grandTotal);
    if (!amount) {
      salesReturnStats.skippedInvalidAmount += 1;
      continue;
    }
    const entryDate = historicalDate(salesReturn, salesReturn.returnDate);
    await upsertHistoricalEntry(DealerLedger.collection, {
      branch: source.branch,
      dealer: source.partyId,
      dealerName: source.party.businessName,
      dealerCode: source.party.dealerCode,
      entryType: 'credit_note',
      entryDate,
      description: `Credit note for sales return ${salesReturn.returnNumber || salesReturn._id}`,
      referenceNumber: salesReturn.creditNoteNumber || salesReturn.returnNumber,
      referenceModel: 'SalesReturn',
      referenceId: salesReturn._id,
      postingKey: `sales-return:${salesReturn._id}:credit-note`,
      debit: 0,
      credit: amount,
      tallySyncStatus: 'not_synced',
      createdBy: asObjectId(salesReturn.createdBy) || undefined,
      ...ledgerTimestamps(salesReturn, entryDate),
    }, salesReturnStats);
  }
  logSourceStats(salesReturnStats);

  const purchaseReturnStats = sourceStats('Issued purchase-return debit notes');
  const purchaseReturns = PurchaseReturn.find({ status: 'debit_issued' }).lean().cursor();
  for await (const purchaseReturn of purchaseReturns) {
    purchaseReturnStats.sources += 1;
    const source = validatePostingSource(purchaseReturn, 'supplier', supplierMap, branchIds, purchaseReturnStats);
    if (!source) continue;
    const amount = positiveAmount(purchaseReturn.grandTotal);
    if (!amount) {
      purchaseReturnStats.skippedInvalidAmount += 1;
      continue;
    }
    const entryDate = historicalDate(purchaseReturn, purchaseReturn.returnDate);
    await upsertHistoricalEntry(SupplierLedger.collection, {
      branch: source.branch,
      supplier: source.partyId,
      supplierName: source.party.companyName,
      supplierCode: source.party.supplierCode,
      entryType: 'debit_note',
      entryDate,
      description: `Debit note for purchase return ${purchaseReturn.debitNoteNumber || purchaseReturn._id}`,
      referenceNumber: purchaseReturn.debitNoteNumber,
      referenceModel: 'PurchaseReturn',
      referenceId: purchaseReturn._id,
      postingKey: `purchase-return:${purchaseReturn._id}:debit-note`,
      debit: amount,
      credit: 0,
      tallySyncStatus: 'not_synced',
      createdBy: asObjectId(purchaseReturn.createdBy) || undefined,
      ...ledgerTimestamps(purchaseReturn, entryDate),
    }, purchaseReturnStats);
  }
  logSourceStats(purchaseReturnStats);
}

async function ledgerBalances(Ledger, partyField, dealerSign) {
  const rows = await Ledger.collection.aggregate([
    { $match: { [partyField]: { $type: 'objectId' } } },
    {
      $group: {
        _id: `$${partyField}`,
        debit: { $sum: { $ifNull: ['$debit', 0] } },
        credit: { $sum: { $ifNull: ['$credit', 0] } },
      },
    },
  ]).toArray();
  return new Map(rows.map((row) => [
    String(row._id),
    dealerSign ? Number(row.debit || 0) - Number(row.credit || 0) : Number(row.credit || 0) - Number(row.debit || 0),
  ]));
}

async function reconcileOpeningAdjustments({ defaultBranch, dealers, suppliers }) {
  const reconcilePartyType = async ({
    parties,
    Party,
    Ledger,
    partyField,
    nameField,
    codeField,
    ledgerNameField,
    ledgerCodeField,
    keyPrefix,
    dealerSign,
  }) => {
    const totals = await ledgerBalances(Ledger, partyField, dealerSign);
    const existingOpenings = await Ledger.collection.find({
      branch: defaultBranch,
      postingKey: { $regex: `^migration:${keyPrefix}:[0-9a-fA-F]{24}:opening$` },
    }).toArray();
    const openingMap = new Map(existingOpenings.map((row) => [row.postingKey, row]));
    let inserted = 0;
    let updated = 0;
    let zeroResidual = 0;
    let skipped = 0;

    for (const party of parties) {
      const target = Number(party.currentOutstanding || 0);
      if (!Number.isFinite(target)) {
        skipped += 1;
        continue;
      }
      const postingKey = `migration:${keyPrefix}:${party._id}:opening`;
      const existing = openingMap.get(postingKey);
      const existingBalance = existing
        ? (dealerSign
          ? Number(existing.debit || 0) - Number(existing.credit || 0)
          : Number(existing.credit || 0) - Number(existing.debit || 0))
        : 0;
      const balanceWithoutOpening = Number(totals.get(String(party._id)) || 0) - existingBalance;
      let residual = target - balanceWithoutOpening;
      if (Math.abs(residual) < 1e-9) residual = 0;
      if (!existing && residual === 0) {
        zeroResidual += 1;
        continue;
      }

      const amount = Math.abs(residual);
      const debit = dealerSign
        ? (residual > 0 ? amount : 0)
        : (residual < 0 ? amount : 0);
      const credit = dealerSign
        ? (residual < 0 ? amount : 0)
        : (residual > 0 ? amount : 0);
      const entryDate = historicalDate(party, party.createdAt);
      const result = await Ledger.collection.updateOne(
        { branch: defaultBranch, postingKey },
        {
          $set: {
            [partyField]: party._id,
            [ledgerNameField]: party[nameField],
            [ledgerCodeField]: party[codeField],
            debit,
            credit,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            branch: defaultBranch,
            entryType: 'opening',
            entryDate,
            description: 'Migration opening adjustment preserving legacy consolidated outstanding',
            referenceNumber: postingKey,
            referenceModel: '',
            postingKey,
            tallySyncStatus: 'not_synced',
            createdBy: asObjectId(party.createdBy) || undefined,
            createdAt: entryDate,
          },
        },
        { upsert: true }
      );
      if (result.upsertedCount) inserted += 1;
      else updated += 1;
    }

    console.log(
      `${keyPrefix} opening reconciliation: ${inserted} inserted, ${updated} updated, `
      + `${zeroResidual} zero residual without row, ${skipped} invalid legacy balance(s) skipped`
    );

    const recomputed = await ledgerBalances(Ledger, partyField, dealerSign);
    const operations = parties.map((party) => ({
      updateOne: {
        filter: { _id: party._id },
        update: { $set: { currentOutstanding: Number(recomputed.get(String(party._id)) || 0) } },
      },
    }));
    for (let offset = 0; offset < operations.length; offset += 500) {
      await Party.collection.bulkWrite(operations.slice(offset, offset + 500), { ordered: true });
    }
    console.log(`Recomputed consolidated currentOutstanding for ${operations.length} ${keyPrefix}(s) from all branch ledger rows`);
  };

  await reconcilePartyType({
    parties: dealers,
    Party: Dealer,
    Ledger: DealerLedger,
    partyField: 'dealer',
    nameField: 'businessName',
    codeField: 'dealerCode',
    ledgerNameField: 'dealerName',
    ledgerCodeField: 'dealerCode',
    keyPrefix: 'dealer',
    dealerSign: true,
  });
  await reconcilePartyType({
    parties: suppliers,
    Party: Supplier,
    Ledger: SupplierLedger,
    partyField: 'supplier',
    nameField: 'companyName',
    codeField: 'supplierCode',
    ledgerNameField: 'supplierName',
    ledgerCodeField: 'supplierCode',
    keyPrefix: 'supplier',
    dealerSign: false,
  });
}

async function backfillPurchaseRequisitionItemIds() {
  let updated = 0;
  const cursor = PurchaseRequisition.collection.find({ 'items.0': { $exists: true } });
  for await (const requisition of cursor) {
    let changed = false;
    const items = (requisition.items || []).map((item) => {
      if (item._id) return item;
      changed = true;
      return { ...item, _id: new mongoose.Types.ObjectId() };
    });
    if (changed) {
      await PurchaseRequisition.collection.updateOne({ _id: requisition._id }, { $set: { items } });
      updated += 1;
    }
  }
  console.log(`Backfilled item identities for ${updated} purchase requisition(s)`);
}

async function initializeAllSequences(settings) {
  const nonAllTotals = await BranchSequence.collection.aggregate([
    { $match: { fiscalYear: { $ne: 'ALL' } } },
    {
      $group: {
        _id: { branch: '$branch', documentType: '$documentType' },
        value: { $sum: { $ifNull: ['$value', 0] } },
      },
    },
  ]).toArray();
  const totals = new Map(nonAllTotals.map((row) => [
    `${row._id.branch}:${row._id.documentType}`,
    Math.max(0, Number(row.value || 0)),
  ]));
  let created = 0;
  let raised = 0;
  let unchanged = 0;

  for (const setting of settings) {
    for (const documentType of Object.keys(DEFAULT_NUMBERING)) {
      if (setting.numbering?.[documentType]?.includeFiscalYear !== false) continue;
      const filter = { branch: setting.branch, documentType, fiscalYear: 'ALL' };
      const target = totals.get(`${setting.branch}:${documentType}`) || 0;
      const existing = await BranchSequence.collection.findOne(filter);
      await BranchSequence.collection.updateOne(
        filter,
        {
          $setOnInsert: { branch: setting.branch, documentType, fiscalYear: 'ALL', createdAt: new Date() },
          $max: { value: target },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      );
      if (!existing) created += 1;
      else if (Number(existing.value || 0) < target) raised += 1;
      else unchanged += 1;
    }
  }
  console.log(`ALL sequence continuity: ${created} created, ${raised} raised to non-ALL totals, ${unchanged} already sufficient; no counter decremented`);
}

async function createSupplierInvoiceIndexes() {
  const collection = mongoose.connection.collection('supplierinvoices');
  await collection.createIndex({ branch: 1 }, { name: 'branch_1' });
  await collection.createIndex(
    { branch: 1, invoiceRefNumber: 1 },
    { unique: true, name: 'branch_1_invoiceRefNumber_1' }
  );
  await collection.createIndex(
    { branch: 1, supplier: 1, invoiceDate: -1 },
    { name: 'branch_1_supplier_1_invoiceDate_-1' }
  );
  await collection.createIndex({ branch: 1, status: 1 }, { name: 'branch_1_status_1' });
  await collection.createIndex({ supplier: 1, invoiceDate: -1 }, { name: 'supplier_1_invoiceDate_-1' });
  await collection.createIndex({ status: 1 }, { name: 'status_1' });
}

async function dropLegacyGlobalIndexes() {
  const legacyIndexes = [
    [ApprovalRequest.collection, 'requestNumber_1'],
    [BankReconciliation.collection, 'reconciliationNumber_1'],
    [SalesOrder.collection, 'orderNumber_1'],
    [Quotation.collection, 'quotationNumber_1'],
    [Invoice.collection, 'invoiceNumber_1'],
    [PurchaseOrder.collection, 'poNumber_1'],
    [PurchaseRequisition.collection, 'prNumber_1'],
    [GRN.collection, 'grnNumber_1'],
    [Payment.collection, 'paymentNumber_1'],
    [Expense.collection, 'expenseNumber_1'],
    [StockTransfer.collection, 'transferNumber_1'],
    [SalesReturn.collection, 'returnNumber_1'],
    [SalesReturn.collection, 'creditNoteNumber_1'],
    [PurchaseReturn.collection, 'debitNoteNumber_1'],
    [PickList.collection, 'pickListNumber_1'],
    [DispatchTrip.collection, 'tripNumber_1'],
    [Delivery.collection, 'deliveryNumber_1'],
    [mongoose.connection.collection('supplierinvoices'), 'invoiceRefNumber_1'],
    [Warehouse.collection, 'warehouseCode_1'],
    [Warehouse.collection, 'name_1'],
    [Stock.collection, 'product_1_warehouse_1_shade_1_batch_1'],
    [DealerPricing.collection, 'customerType_1_customerId_1_product_1'],
    [DealerPricing.collection, 'dealer_1_product_1'],
  ];
  for (const [collection, indexName] of legacyIndexes) {
    await dropIndexIfPresent(collection, indexName);
  }
}

async function backfillSalesOrderLifecycle() {
  const products = await Product.find({}).select('_id piecesPerBox sqftPerBox').lean();
  const productMap = new Map(products.map(product => [String(product._id), product]));
  let orderUpdates = 0;
  const orderCursor = SalesOrder.collection.find({});
  for await (const order of orderCursor) {
    const fullyDispatched = ['dispatched', 'delivered'].includes(order.status);
    const items = (order.items || []).map(item => {
      const product = productMap.get(String(item.product));
      const piecesPerBox = Number(product?.piecesPerBox || 0);
      const sqftPerBox = Number(product?.sqftPerBox || 0);
      const quantity = Number(item.quantity || item.boxes || 0);
      const dispatchedQuantity = Number(item.dispatchedQuantity ?? (fullyDispatched ? quantity : 0));
      const remainingQuantity = Math.max(0, Number(item.remainingQuantity ?? (quantity - dispatchedQuantity)));
      const reservedQuantity = Number(item.reservedQuantity || 0);
      return {
        ...item,
        quantity,
        boxes: Number(item.boxes) > 0 ? Number(item.boxes) : quantity,
        pieces: Number(item.pieces) > 0 ? Number(item.pieces) : piecesPerBox > 0 ? quantity * piecesPerBox : 0,
        sqft: Number(item.sqft) > 0 ? Number(item.sqft) : sqftPerBox > 0 ? quantity * sqftPerBox : 0,
        reservedQuantity,
        allocatedQuantity: Number(item.allocatedQuantity || 0),
        pickedQuantity: Number(item.pickedQuantity || 0),
        shortQuantity: Number(item.shortQuantity || 0),
        damagedQuantity: Number(item.damagedQuantity || 0),
        dispatchedQuantity,
        fulfilledQuantity: Number(item.fulfilledQuantity ?? dispatchedQuantity),
        remainingQuantity,
        backorderQuantity: Number(item.backorderQuantity ?? Math.max(0, remainingQuantity - reservedQuantity)),
      };
    });
    await SalesOrder.collection.updateOne(
      { _id: order._id },
      {
        $set: {
          items,
          confirmationRequested: Boolean(order.confirmationRequested),
          reservationStatus: order.reservationStatus || (fullyDispatched ? 'consumed' : 'none'),
          cancellationRequestStatus: order.cancellationRequestStatus || 'none',
        },
      }
    );
    orderUpdates += 1;
  }

  let pickUpdates = 0;
  const pickCursor = PickList.collection.find({});
  for await (const pickList of pickCursor) {
    const order = await SalesOrder.collection.findOne({ _id: pickList.salesOrder });
    const usedLineIds = new Set();
    const items = (pickList.items || []).map((item, itemIndex) => {
      let line = item.salesOrderItem
        ? order?.items?.find(candidate => String(candidate._id) === String(item.salesOrderItem))
        : null;
      if (!line) {
        const matches = (order?.items || []).filter(candidate =>
          !usedLineIds.has(String(candidate._id))
          && String(candidate.product) === String(item.product)
          && String(candidate.warehouse || '') === String(item.warehouse || '')
          && String(candidate.shade || '') === String(item.shade || '')
          && String(candidate.batch || '') === String(item.batch || '')
        );
        if (matches.length === 1) [line] = matches;
        else {
          const positional = order?.items?.[itemIndex];
          if (positional && String(positional.product) === String(item.product)) line = positional;
        }
      }
      if (line) usedLineIds.add(String(line._id));
      return {
        ...item,
        ...(line ? { salesOrderItem: line._id } : {}),
        allocatedQty: Number(item.allocatedQty ?? item.requestedQty ?? 0),
        dispatchedQty: Number(item.dispatchedQty ?? (pickList.stockConsumedAt ? item.pickedQty || 0 : 0)),
      };
    });
    await PickList.collection.updateOne({ _id: pickList._id }, { $set: { items } });
    pickUpdates += 1;
  }
  const legacyOrderCursor = SalesOrder.collection.find({ reservationStatus: 'none' });
  for await (const order of legacyOrderCursor) {
    const pickLists = await PickList.collection.find({ salesOrder: order._id }).toArray();
    if (!pickLists.length) continue;
    const counters = new Map((order.items || []).map(item => [String(item._id), {
      reserved: 0, allocated: 0, picked: 0, short: 0, damaged: 0, dispatched: 0,
    }]));
    for (const pickList of pickLists) {
      const activeReservation = !pickList.stockConsumedAt
        && pickList.stockReserved === true
        && !['released', 'consumed'].includes(pickList.reservationState)
        && pickList.status !== 'cancelled';
      const adjusted = ['adjusted', 'consuming'].includes(pickList.reservationState)
        || ['picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch'].includes(pickList.status);
      for (const item of pickList.items || []) {
        const counter = counters.get(String(item.salesOrderItem));
        if (!counter) continue;
        const picked = Number(item.pickedQty || 0);
        counter.picked += picked;
        counter.short += Number(item.shortQty || 0);
        counter.damaged += Number(item.damagedQty || 0);
        if (pickList.stockConsumedAt) counter.dispatched += Number(item.dispatchedQty ?? picked);
        if (activeReservation) {
          const activeQuantity = adjusted ? picked : Number(item.requestedQty || 0);
          counter.reserved += activeQuantity;
          counter.allocated += activeQuantity;
        }
      }
    }
    const items = (order.items || []).map(item => {
      const counter = counters.get(String(item._id));
      const quantity = Number(item.quantity || 0);
      const dispatchedQuantity = Math.min(quantity, counter?.dispatched || 0);
      const remainingQuantity = Math.max(0, quantity - dispatchedQuantity);
      const reservedQuantity = Math.min(remainingQuantity, counter?.reserved || 0);
      return {
        ...item,
        reservedQuantity,
        allocatedQuantity: Math.min(reservedQuantity, counter?.allocated || 0),
        pickedQuantity: counter?.picked || 0,
        shortQuantity: counter?.short || 0,
        damagedQuantity: counter?.damaged || 0,
        dispatchedQuantity,
        fulfilledQuantity: dispatchedQuantity,
        remainingQuantity,
        backorderQuantity: Math.max(0, remainingQuantity - reservedQuantity),
      };
    });
    const hasReserved = items.some(item => Number(item.reservedQuantity || 0) > 0);
    const allDispatched = items.length > 0 && items.every(item => Number(item.remainingQuantity || 0) <= 0.0001);
    await SalesOrder.collection.updateOne(
      { _id: order._id, reservationStatus: 'none' },
      {
        $set: {
          items,
          confirmationRequested: order.confirmationRequested || !['draft', 'cancelled', 'expired'].includes(order.status),
          reservationStatus: allDispatched ? 'consumed' : hasReserved ? 'partial' : 'none',
        },
      }
    );
  }
  console.log(`Backfilled lifecycle fields for ${orderUpdates} sales order(s) and ${pickUpdates} pick list(s)`);
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}`);

  const defaultBranch = await Branch.findOneAndUpdate(
    { branchCode: DEFAULT_CODE },
    {
      $setOnInsert: {
        branchCode: DEFAULT_CODE,
        name: DEFAULT_NAME,
        legalName: process.env.DEFAULT_BRANCH_LEGAL_NAME || 'BDM GRANIMARMO PRIVATE LIMITED',
        gstin: process.env.DEFAULT_BRANCH_GSTIN || '',
        pan: process.env.DEFAULT_BRANCH_PAN || '',
        address: process.env.DEFAULT_BRANCH_ADDRESS || '',
        city: process.env.DEFAULT_BRANCH_CITY || '',
        state: process.env.DEFAULT_BRANCH_STATE || 'Karnataka',
        stateCode: process.env.DEFAULT_BRANCH_STATE_CODE || '29',
        pinCode: process.env.DEFAULT_BRANCH_PIN_CODE || '',
        phone: process.env.DEFAULT_BRANCH_PHONE || '',
        email: process.env.DEFAULT_BRANCH_EMAIL || '',
        status: 'active',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (defaultBranch.status !== 'active') {
    throw new Error(`Default branch ${DEFAULT_CODE} exists but is inactive. Activate it before migration.`);
  }
  console.log(`Using default branch ${defaultBranch.branchCode} (${defaultBranch._id})`);

  const branches = await Branch.find({}).select('_id branchCode status createdAt').lean();
  let settings = await ensureBranchSettings(branches);

  const warehouseResult = await Warehouse.collection.updateMany(
    { $or: [{ branch: { $exists: false } }, { branch: null }, { branch: '' }] },
    { $set: { branch: defaultBranch._id } }
  );
  console.log(`Backfilled ${warehouseResult.modifiedCount} warehouse(s)`);

  const userResult = await User.collection.updateMany(
    { $or: [{ assignedBranches: { $exists: false } }, { assignedBranches: { $size: 0 } }] },
    { $set: { assignedBranches: [defaultBranch._id], defaultBranch: defaultBranch._id } }
  );
  await User.collection.updateMany(
    { assignedBranches: defaultBranch._id, $or: [{ defaultBranch: { $exists: false } }, { defaultBranch: null }] },
    { $set: { defaultBranch: defaultBranch._id } }
  );
  console.log(`Backfilled ${userResult.modifiedCount} user assignment(s)`);

  for (const collectionName of branchOwnedCollections) {
    const collection = mongoose.connection.collection(collectionName);
    const result = await collection.updateMany(
      {
        $or: [
          { branch: { $exists: false } },
          { branch: null },
          { branch: '' },
          { branch: { $type: 'string' } },
        ],
      },
      [
        { $set: { legacyBranch: { $cond: [{ $eq: [{ $type: '$branch' }, 'string'] }, '$branch', '$legacyBranch'] } } },
        { $set: { branch: defaultBranch._id } },
      ]
    );
    console.log(`Backfilled ${result.modifiedCount} record(s) in ${collectionName}`);
  }

  const stockTransfers = mongoose.connection.collection('stocktransfers');
  const sourceTransferResult = await stockTransfers.updateMany(
    {
      $or: [
        { sourceBranch: { $exists: false } },
        { sourceBranch: null },
        { sourceBranch: '' },
        { sourceBranch: { $type: 'string' } },
      ],
    },
    [
      { $set: { legacySourceBranch: { $cond: [{ $eq: [{ $type: '$sourceBranch' }, 'string'] }, '$sourceBranch', '$legacySourceBranch'] } } },
      { $set: { sourceBranch: defaultBranch._id } },
    ]
  );
  const destinationTransferResult = await stockTransfers.updateMany(
    {
      $or: [
        { destinationBranch: { $exists: false } },
        { destinationBranch: null },
        { destinationBranch: '' },
        { destinationBranch: { $type: 'string' } },
      ],
    },
    [
      { $set: { legacyDestinationBranch: { $cond: [{ $eq: [{ $type: '$destinationBranch' }, 'string'] }, '$destinationBranch', '$legacyDestinationBranch'] } } },
      { $set: { destinationBranch: defaultBranch._id } },
    ]
  );
  console.log(`Backfilled ${sourceTransferResult.modifiedCount} source and ${destinationTransferResult.modifiedCount} destination stock-transfer branch field(s)`);

  await backfillSalesOrderLifecycle();
  await backfillPurchaseRequisitionItemIds();
  await preflightActiveInvoiceDuplicates();
  // Multiple Sales Orders per quotation are valid; conversion lineage is
  // backfilled by scripts/migrateQuotationConversions.js.
  await preflightNumberDuplicates();

  await Invoice.collection.updateMany(
    { status: 'cancelled', activeSalesOrderKey: { $exists: true } },
    { $unset: { activeSalesOrderKey: '' } }
  );
  await Invoice.collection.updateMany(
    {
      status: { $ne: 'cancelled' },
      branch: { $type: 'objectId' },
      salesOrder: { $type: 'objectId' },
      activeSalesOrderKey: { $exists: true },
    },
    { $unset: { activeSalesOrderKey: '' } }
  );
  const activeInvoiceKeys = await Invoice.collection.updateMany(
    {
      status: { $ne: 'cancelled' },
      branch: { $type: 'objectId' },
      salesOrder: { $type: 'objectId' },
    },
    [{ $set: { activeSalesOrderKey: { $concat: [{ $toString: '$branch' }, ':', { $toString: '$salesOrder' }] } } }]
  );
  console.log(`Rebuilt ${activeInvoiceKeys.modifiedCount} active invoice uniqueness key(s)`);

  const branchIds = new Set(branches.map((branch) => String(branch._id)));
  const [dealers, suppliers] = await Promise.all([
    Dealer.find({}).select('_id businessName dealerCode currentOutstanding createdBy createdAt updatedAt').lean(),
    Supplier.find({}).select('_id companyName supplierCode currentOutstanding createdBy createdAt updatedAt').lean(),
  ]);
  await backfillHistoricalSubledgers({ branchIds, dealers, suppliers });
  await reconcileOpeningAdjustments({
    defaultBranch: defaultBranch._id,
    dealers,
    suppliers,
  });

  settings = await BranchSettings.find({ branch: { $in: branches.map((branch) => branch._id) } }).lean();
  await initializeAllSequences(settings);

  // Build every replacement constraint before removing any legacy global unique index.
  await Promise.all([
    ...indexedModels.map((Model) => Model.createIndexes()),
    createSupplierInvoiceIndexes(),
  ]);
  console.log(`Built/synchronized replacement indexes for ${indexedModels.length} model collection(s) and raw supplierinvoices`);

  await dropLegacyGlobalIndexes();

  await Promise.all(indexedModels.map((Model) => Model.syncIndexes()));

  console.log('Multi-branch migration completed successfully.');
}

run()
  .catch((error) => {
    console.error('Multi-branch migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
