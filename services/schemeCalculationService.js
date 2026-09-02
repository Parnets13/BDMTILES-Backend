import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import Invoice from '../models/Invoice.js';
import SupplierInvoice from '../models/SupplierInvoice.js';
import SalesReturn from '../models/SalesReturn.js';
import PurchaseReturn from '../models/PurchaseReturn.js';
import Payment from '../models/Payment.js';
import { requestFingerprint } from '../utils/idempotency.js';

const round = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const id = value => String(value?._id || value || '');
const atStart = value => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date; };
const atEnd = value => { const date = new Date(value); date.setHours(23, 59, 59, 999); return date; };

function serviceError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function lineTotals(items, productIds, quantityField, valueField) {
  const allowed = new Set((productIds || []).map(id));
  return (items || []).reduce((totals, item) => {
    if (allowed.size && !allowed.has(id(item.product))) return totals;
    totals.quantity += Number(item[quantityField] || 0);
    totals.value += Number(item[valueField] || 0);
    return totals;
  }, { quantity: 0, value: 0 });
}

function metricFor(scheme, netValue, netQuantity) {
  return scheme.basis.endsWith('quantity') ? netQuantity : netValue;
}

function targetReached(scheme, metric) {
  const target = scheme.basis.endsWith('quantity')
    ? Number(scheme.targetQuantity || 0)
    : Number(scheme.targetAmount || 0);
  return target <= 0 || metric + 0.0001 >= target;
}

function calculateReward(scheme, netValue, netQuantity) {
  const metric = metricFor(scheme, netValue, netQuantity);
  const eligible = targetReached(scheme, metric) && metric > 0;
  let earnedAmount = 0;
  let appliedSlabs = [];

  if (eligible && scheme.calculationType === 'fixed') {
    earnedAmount = Number(scheme.fixedAmount || 0);
  } else if (eligible && scheme.calculationType === 'percentage') {
    earnedAmount = netValue * Number(scheme.rate || 0) / 100;
  } else if (eligible && scheme.calculationType === 'per_unit') {
    earnedAmount = netQuantity * Number(scheme.rate || 0);
  } else if (eligible && scheme.calculationType === 'highest_slab') {
    const slab = [...(scheme.slabs || [])]
      .sort((left, right) => Number(right.from) - Number(left.from))
      .find(row => metric >= Number(row.from) && (row.to == null || metric < Number(row.to)));
    if (slab) {
      earnedAmount = Number(slab.fixedAmount || 0)
        || (scheme.basis.endsWith('quantity')
          ? metric * Number(slab.rate || 0)
          : netValue * Number(slab.rate || 0) / 100);
      appliedSlabs = [{ from: slab.from, to: slab.to, rate: slab.rate, fixedAmount: slab.fixedAmount, base: metric }];
    }
  } else if (eligible && scheme.calculationType === 'progressive_slab') {
    const ordered = [...(scheme.slabs || [])].sort((left, right) => Number(left.from) - Number(right.from));
    for (const slab of ordered) {
      const from = Number(slab.from || 0);
      const upper = slab.to == null ? metric : Math.min(metric, Number(slab.to));
      const base = Math.max(0, upper - from);
      if (base <= 0) continue;
      const reward = scheme.basis.endsWith('quantity')
        ? base * Number(slab.rate || 0)
        : base * Number(slab.rate || 0) / 100;
      earnedAmount += reward;
      appliedSlabs.push({ from: slab.from, to: slab.to, rate: slab.rate, base: round(base), reward: round(reward) });
    }
  }

  return { metric: round(metric), eligible: eligible && earnedAmount > 0, earnedAmount: round(earnedAmount), appliedSlabs };
}

function ensureSchemeCalculable(scheme) {
  if (!scheme) throw serviceError(404, 'Scheme not found in the active branch.');
  if (!['active', 'expired', 'closed'].includes(scheme.status)) {
    throw serviceError(409, `A ${scheme.status} scheme cannot be calculated or submitted.`);
  }
}

async function assertDealerEligible(scheme, dealerId, session, options = {}) {
  const dealerFilter = { _id: dealerId };
  if (!options.historical) Object.assign(dealerFilter, { status: 'active', schemeEligible: { $ne: false } });
  const dealer = await Dealer.findOne(dealerFilter).session(session).lean();
  if (!dealer) throw serviceError(404, options.historical ? 'Dealer not found.' : 'Active scheme-eligible dealer not found.');
  if (options.historical) return dealer;
  const eligible = scheme.applicableTo === 'all'
    || (scheme.applicableTo === 'specific_dealers' && (scheme.dealers || []).some(value => id(value) === id(dealerId)))
    || (scheme.applicableTo === 'dealer_category' && id(scheme.dealerCategory) === id(dealer.dealerCategory))
    || (scheme.applicableTo === 'dealer_type' && id(scheme.dealerType) === id(dealer.dealerType));
  if (!eligible) throw serviceError(422, 'Dealer is outside this scheme applicability rule.');
  return dealer;
}

function paymentConfirmationDate(payment) {
  return new Date(payment.confirmedAt || payment.paymentDate || payment.updatedAt || payment.createdAt);
}

function paymentQualifies(payment, invoiceDate, start, end, withinDays) {
  const confirmedAt = paymentConfirmationDate(payment);
  if (withinDays > 0) {
    const latest = new Date(invoiceDate);
    latest.setDate(latest.getDate() + withinDays);
    latest.setHours(23, 59, 59, 999);
    return confirmedAt >= start && confirmedAt <= latest;
  }
  return confirmedAt >= start && confirmedAt <= end;
}

async function dealerSources(scheme, dealerId, session) {
  const start = atStart(scheme.startDate);
  const end = atEnd(scheme.endDate);
  const invoices = await Invoice.find({
    branch: scheme.branch,
    dealer: dealerId,
    invoiceType: 'tax_invoice',
    status: { $in: ['generated', 'sent'] },
    invoiceDate: { $gte: start, $lte: end },
  }).select('invoiceNumber invoiceDate salesOrder taxableTotal grandTotal items').session(session).lean();
  const invoiceIds = invoices.map(row => row._id);
  const returns = invoiceIds.length ? await SalesReturn.find({
    branch: scheme.branch,
    dealer: dealerId,
    invoice: { $in: invoiceIds },
    status: { $in: ['credit_issued', 'refund_pending', 'replacement_pending'] },
  }).select('returnNumber creditNoteNumber returnDate invoice subtotal grandTotal items').session(session).lean() : [];

  let grossValue = 0;
  let grossQuantity = 0;
  for (const invoice of invoices) {
    const totals = lineTotals(invoice.items, scheme.products, 'quantity', 'taxableAmount');
    grossValue += totals.value;
    grossQuantity += totals.quantity;
  }
  let returnValue = 0;
  let returnQuantity = 0;
  for (const row of returns) {
    const totals = lineTotals(row.items, scheme.products, 'returnQty', 'taxableAmount');
    returnValue += totals.value;
    returnQuantity += totals.quantity;
  }

  const paymentSources = [];
  if (scheme.basis === 'confirmed_payment' && invoiceIds.length) {
    const salesOrderIds = invoices.map(row => row.salesOrder).filter(Boolean);
    const allocationTargets = [...invoiceIds, ...salesOrderIds];
    const payments = await Payment.find({
      branch: scheme.branch,
      dealer: dealerId,
      paymentType: 'dealer_receipt',
      status: 'confirmed',
      'againstOrders.order': { $in: allocationTargets },
    }).select('paymentNumber paymentDate confirmedAt updatedAt againstOrders').session(session).lean();
    const invoiceMap = new Map(invoices.map(row => [id(row._id), row]));
    const salesOrderInvoiceMap = new Map(invoices.filter(row => row.salesOrder).map(row => [id(row.salesOrder), row]));
    grossValue = 0;
    for (const payment of payments) {
      for (const allocation of payment.againstOrders || []) {
        const invoice = allocation.orderModel === 'Invoice'
          ? invoiceMap.get(id(allocation.order))
          : allocation.orderModel === 'SalesOrder'
            ? salesOrderInvoiceMap.get(id(allocation.order))
            : null;
        if (!invoice || !paymentQualifies(payment, invoice.invoiceDate, start, end, Number(scheme.paymentWithinDays || 0))) continue;
        const amount = Number(allocation.allocatedAmount || 0);
        grossValue += amount;
        paymentSources.push({
          id: id(payment._id), number: payment.paymentNumber, confirmedAt: paymentConfirmationDate(payment),
          allocationModel: allocation.orderModel,
          invoiceId: id(invoice._id), invoiceNumber: invoice.invoiceNumber, allocatedAmount: round(amount),
        });
      }
    }
  }

  return {
    grossValue: round(grossValue), returnValue: round(returnValue),
    grossQuantity: round(grossQuantity), returnQuantity: round(returnQuantity),
    invoices: invoices.map(row => ({ id: id(row._id), number: row.invoiceNumber, date: row.invoiceDate })),
    returns: returns.map(row => ({ id: id(row._id), number: row.returnNumber, noteNumber: row.creditNoteNumber, date: row.returnDate })),
    payments: paymentSources,
  };
}

async function supplierSources(scheme, session) {
  const start = atStart(scheme.startDate);
  const end = atEnd(scheme.endDate);
  const invoices = await SupplierInvoice.find({
    branch: scheme.branch,
    supplier: scheme.supplier,
    status: { $in: ['verified', 'partial', 'paid'] },
    invoiceDate: { $gte: start, $lte: end },
  }).select('invoiceRefNumber invoiceNumber invoiceDate invoiceAmount grandTotal items').session(session).lean();
  const invoiceIds = invoices.map(row => row._id);
  const returns = invoiceIds.length ? await PurchaseReturn.find({
    branch: scheme.branch,
    supplier: scheme.supplier,
    supplierInvoice: { $in: invoiceIds },
    status: 'debit_issued',
  }).select('debitNoteNumber returnDate supplierInvoice subtotal grandTotal items').session(session).lean() : [];

  let grossValue = 0;
  let grossQuantity = 0;
  for (const invoice of invoices) {
    const totals = lineTotals(invoice.items, scheme.products, 'invoiceQuantity', 'taxableAmount');
    grossValue += totals.value;
    grossQuantity += totals.quantity;
  }
  let returnValue = 0;
  let returnQuantity = 0;
  for (const row of returns) {
    const totals = lineTotals(row.items, scheme.products, 'returnQty', 'taxableAmount');
    returnValue += totals.value;
    returnQuantity += totals.quantity;
  }

  const paymentSources = [];
  if (scheme.basis === 'confirmed_payment' && invoiceIds.length) {
    const payments = await Payment.find({
      branch: scheme.branch,
      supplier: scheme.supplier,
      paymentType: 'supplier_payment',
      status: 'confirmed',
      'againstOrders.order': { $in: invoiceIds },
    }).select('paymentNumber paymentDate confirmedAt updatedAt againstOrders').session(session).lean();
    const invoiceMap = new Map(invoices.map(row => [id(row._id), row]));
    grossValue = 0;
    for (const payment of payments) {
      for (const allocation of payment.againstOrders || []) {
        if (allocation.orderModel !== 'SupplierInvoice') continue;
        const invoice = invoiceMap.get(id(allocation.order));
        if (!invoice || !paymentQualifies(payment, invoice.invoiceDate, start, end, Number(scheme.paymentWithinDays || 0))) continue;
        const amount = Number(allocation.allocatedAmount || 0);
        grossValue += amount;
        paymentSources.push({
          id: id(payment._id), number: payment.paymentNumber, confirmedAt: paymentConfirmationDate(payment),
          invoiceId: id(invoice._id), invoiceNumber: invoice.invoiceRefNumber, allocatedAmount: round(amount),
        });
      }
    }
  }

  return {
    grossValue: round(grossValue), returnValue: round(returnValue),
    grossQuantity: round(grossQuantity), returnQuantity: round(returnQuantity),
    invoices: invoices.map(row => ({ id: id(row._id), number: row.invoiceRefNumber, supplierNumber: row.invoiceNumber, date: row.invoiceDate })),
    returns: returns.map(row => ({ id: id(row._id), noteNumber: row.debitNoteNumber, date: row.returnDate })),
    payments: paymentSources,
  };
}

function buildCalculation(scheme, sources) {
  const netValue = round(Math.max(0, sources.grossValue - sources.returnValue));
  const netQuantity = round(Math.max(0, sources.grossQuantity - sources.returnQuantity));
  const reward = calculateReward(scheme, netValue, netQuantity);
  const calculation = {
    basis: scheme.basis,
    calculationType: scheme.calculationType,
    grossValue: sources.grossValue,
    returnValue: sources.returnValue,
    netValue,
    grossQuantity: sources.grossQuantity,
    returnQuantity: sources.returnQuantity,
    netQuantity,
    metric: reward.metric,
    eligible: reward.eligible,
    earnedAmount: reward.earnedAmount,
    paymentWithinDays: Number(scheme.paymentWithinDays || 0),
    appliedSlabs: reward.appliedSlabs,
    sources: { invoices: sources.invoices, returns: sources.returns, payments: sources.payments },
  };
  return { calculation, fingerprint: requestFingerprint({ schemeVersion: scheme.version, calculation }) };
}

export async function calculateDealerScheme(scheme, dealerId, session = null, options = {}) {
  ensureSchemeCalculable(scheme);
  const dealer = await assertDealerEligible(scheme, dealerId, session, options);
  const result = buildCalculation(scheme, await dealerSources(scheme, dealerId, session));
  return { ...result, party: dealer, partyName: dealer.businessName };
}

export async function calculateSupplierScheme(scheme, session = null, options = {}) {
  ensureSchemeCalculable(scheme);
  const supplierFilter = { _id: scheme.supplier };
  if (!options.historical) supplierFilter.status = 'active';
  const supplier = await Supplier.findOne(supplierFilter).session(session).lean();
  if (!supplier) throw serviceError(404, options.historical ? 'Supplier not found.' : 'Active supplier not found.');
  const result = buildCalculation(scheme, await supplierSources(scheme, session));
  return { ...result, party: supplier, partyName: supplier.companyName };
}
