import SalesReturn from '../models/SalesReturn.js';
import SalesOrder from '../models/SalesOrder.js';
import Invoice from '../models/Invoice.js';
import Stock from '../models/Stock.js';
import Dealer from '../models/Dealer.js';
import { assertWarehousesInBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

export const ACTIVE_INVOICE_STATUSES = ['generated', 'sent'];
export const POSTED_RETURN_STATUSES = ['credit_issued', 'refund_pending', 'replacement_pending'];
const legacyLineKey = (item) => `${String(item.product)}|${item.shade || ''}|${item.batch || ''}`;
const stockKey = (item) => `${String(item.product)}|${String(item.warehouse)}|${item.shade || ''}|${item.batch || ''}|${item.condition}`;
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const routeError = (status, message) => Object.assign(new Error(message), { status });

function invoiceLineValues(source, quantity) {
  const invoiceQuantity = Number(source.quantity || 0);
  if (!Number.isFinite(invoiceQuantity) || invoiceQuantity <= 0) {
    throw routeError(409, 'The source sales invoice contains an invalid quantity.');
  }
  const ratio = quantity / invoiceQuantity;
  return {
    rate: Number(source.rate || 0),
    discountAmount: roundMoney(Number(source.discountAmount || 0) * ratio),
    schemeDiscount: roundMoney(Number(source.schemeDiscount || 0) * ratio),
    taxableAmount: roundMoney(Number(source.taxableAmount || 0) * ratio),
    gstPercentage: Number(source.gstPercentage || 0),
    gstAmount: roundMoney(Number(source.gstAmount || 0) * ratio),
    totalAmount: roundMoney(Number(source.totalAmount || 0) * ratio),
  };
}

export async function validateSalesReturnItems(data, invoice, options = {}) {
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw routeError(422, 'At least one return item is required.');
  }
  const invoiceLines = new Map((invoice.items || []).map((item) => [String(item._id), item]));
  const requested = new Map();
  const normalizedItems = [];

  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index];
    const returnQty = Number(item.returnQty);
    const source = invoiceLines.get(String(item.invoiceItem || ''));
    if (!source || !Number.isFinite(returnQty) || returnQty <= 0) {
      throw routeError(422, `items[${index}] requires a valid invoiceItem and a finite returnQty greater than zero.`);
    }
    if (!item.condition || !['resaleable', 'damaged', 'scrap'].includes(item.condition)) {
      throw routeError(422, `items[${index}] requires a valid product condition.`);
    }
    if (item.condition !== 'scrap' && !item.warehouse) {
      throw routeError(422, `items[${index}] requires a receiving warehouse for stock adjustment.`);
    }
    const sourceId = String(source._id);
    requested.set(sourceId, (requested.get(sourceId) || 0) + returnQty);
    normalizedItems.push({
      invoiceItem: source._id,
      product: source.product,
      productCode: source.productCode || '',
      productName: source.productName || '',
      shade: source.shade || '',
      batch: source.batch || '',
      returnQty,
      unit: source.unit || 'Box',
      reason: item.reason,
      reasonDetails: String(item.reasonDetails || '').trim(),
      condition: item.condition,
      warehouse: item.condition === 'scrap' ? undefined : item.warehouse,
      ...invoiceLineValues(source, returnQty),
    });
  }

  let query = SalesReturn.find({
    branch: data.branch,
    status: { $nin: ['cancelled', 'reversed'] },
    $or: [
      { invoice: invoice._id },
      { salesOrder: invoice.salesOrder, invoice: { $exists: false } },
      { salesOrder: invoice.salesOrder, invoice: null },
    ],
    ...(options.excludeId ? { _id: { $ne: options.excludeId } } : {}),
  }).select('items').lean();
  if (options.session) query = query.session(options.session);
  const previous = new Map();
  const previousLegacy = new Map();
  for (const existing of await query) {
    for (const item of existing.items || []) {
      if (item.invoiceItem) {
        const key = String(item.invoiceItem);
        previous.set(key, (previous.get(key) || 0) + Number(item.returnQty || 0));
      } else {
        const key = legacyLineKey(item);
        previousLegacy.set(key, (previousLegacy.get(key) || 0) + Number(item.returnQty || 0));
      }
    }
  }
  for (const [sourceId, quantity] of requested) {
    const source = invoiceLines.get(sourceId);
    const priorQuantity = (previous.get(sourceId) || 0) + (previousLegacy.get(legacyLineKey(source)) || 0);
    if (priorQuantity + quantity > Number(source.quantity || 0) + 1e-9) {
      throw routeError(422, 'Return quantity exceeds the remaining quantity on the selected invoice.');
    }
  }
  return normalizedItems;
}

export function applySalesReturnTotals(data) {
  data.subtotal = roundMoney(data.items.reduce((sum, item) => sum + Number(item.taxableAmount || 0), 0));
  data.totalTax = roundMoney(data.items.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0));
  data.grandTotal = roundMoney(data.items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0));
}

export function postedStatus(adjustmentType) {
  if (adjustmentType === 'credit_note') return 'credit_issued';
  if (adjustmentType === 'refund') return 'refund_pending';
  return 'replacement_pending';
}

export function postedMessage(adjustmentType) {
  if (adjustmentType === 'credit_note') return 'Sales Return approved. Stock updated and credit note issued.';
  if (adjustmentType === 'refund') return 'Sales Return approved and stock updated. Customer refund is pending settlement.';
  return 'Sales Return approved and stock updated. Replacement fulfilment is pending.';
}

export async function approveSalesReturn({ current, branchId, approver, remarks = '', session, warehouseVerifier }) {
  if (!session) throw routeError(500, 'Sales Return approval requires an active transaction.');
  if (POSTED_RETURN_STATUSES.includes(current.status)) return current;
  if (current.status !== 'draft') throw routeError(409, `Cannot approve a sales return in ${current.status} status.`);
  if (current.createdBy && String(current.createdBy) === String(approver)) {
    throw routeError(403, 'Maker-checker violation: the Sales Return creator cannot approve it.');
  }
  if (warehouseVerifier && String(warehouseVerifier) === String(approver)) {
    throw routeError(403, 'Maker-checker violation: the warehouse verifier cannot perform finance approval.');
  }

  const [order, invoice] = await Promise.all([
    SalesOrder.findOne({ _id: current.salesOrder, branch: branchId, dealer: current.dealer }).session(session).lean(),
    Invoice.findOne({
      _id: current.invoice,
      branch: branchId,
      dealer: current.dealer,
      status: { $in: ACTIVE_INVOICE_STATUSES },
      invoiceType: 'tax_invoice',
    }).session(session).lean(),
  ]);
  if (!order || !invoice || String(invoice.salesOrder) !== String(order._id)) {
    throw routeError(409, 'The source sales order or active invoice is unavailable or no longer matches the dealer.');
  }
  current.items = await validateSalesReturnItems(current.toObject(), invoice, { excludeId: current._id, session });
  await assertWarehousesInBranch(current.items.map((item) => item.warehouse).filter(Boolean), branchId, { session });
  applySalesReturnTotals(current);

  const stockUpdates = new Map();
  for (const item of current.items) {
    if (!['resaleable', 'damaged'].includes(item.condition)) continue;
    const key = stockKey(item);
    const previous = stockUpdates.get(key);
    stockUpdates.set(key, { item, quantity: (previous?.quantity || 0) + Number(item.returnQty || 0) });
  }
  for (const { item, quantity } of stockUpdates.values()) {
    const increment = item.condition === 'resaleable'
      ? { totalQty: quantity, availableQty: quantity }
      : { totalQty: quantity, damagedQty: quantity };
    await Stock.findOneAndUpdate(
      { branch: current.branch, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '' },
      { $inc: increment, $set: { branch: current.branch } },
      { upsert: true, new: true, session, runValidators: true }
    );
  }
  if (current.adjustmentType === 'credit_note' && current.grandTotal > 0) {
    await postSubledgerEntry({
      session,
      branch: branchId,
      partyType: 'dealer',
      partyId: current.dealer,
      amount: current.grandTotal,
      side: 'credit',
      postingKey: `sales-return:${current._id}:credit-note`,
      entryType: 'credit_note',
      entryDate: current.returnDate,
      description: `Credit note for sales return ${current.returnNumber}`,
      referenceNumber: current.creditNoteNumber || current.returnNumber,
      referenceModel: 'SalesReturn',
      referenceId: current._id,
      createdBy: approver,
    });
  }
  current.status = postedStatus(current.adjustmentType);
  current.approvedBy = approver;
  current.approvalDate = new Date();
  current.approvalRemarks = String(remarks || '').trim();
  await current.save({ session });
  return current;
}

const complaintReason = (category) => {
  if (['damaged_goods', 'wrong_product', 'quality_issue', 'shade_mismatch'].includes(category)) {
    return category === 'damaged_goods' ? 'damaged' : category;
  }
  return 'other';
};

function complaintReturnItems(complaint, financeItems, decision) {
  const verifiedItems = complaint.warehouseVerification?.items || [];
  if (!complaint.invoice || !complaint.salesOrder || !complaint.dealer || verifiedItems.length === 0) {
    throw routeError(422, 'Approval requires authoritative invoice-linked per-item warehouse verification.');
  }
  const verifiedByLine = new Map();
  for (const item of verifiedItems) {
    const key = String(item.invoiceItem || '');
    if (!key || !item.product || !item.warehouse) {
      throw routeError(422, 'Every approved complaint item must retain its invoice line, product, and receiving warehouse.');
    }
    if (verifiedByLine.has(key)) throw routeError(422, 'Warehouse verification contains a duplicate invoice line.');
    verifiedByLine.set(key, item);
  }

  let quantities = new Map();
  if (decision === 'partial_approved') {
    if (!Array.isArray(financeItems) || financeItems.length === 0) {
      throw routeError(422, 'Partial approval requires explicit approved quantities per invoice line.');
    }
    for (let index = 0; index < financeItems.length; index += 1) {
      const item = financeItems[index];
      const quantity = Number(item.approvedQty);
      const key = String(item.invoiceItem || '');
      const verified = verifiedByLine.get(key);
      if (!verified || !Number.isFinite(quantity) || quantity <= 0 || quantity > Number(verified.returnQty || 0) + 1e-9) {
        throw routeError(422, `items[${index}] requires a valid invoiceItem and approvedQty within the warehouse-verified return quantity.`);
      }
      if (quantities.has(key)) throw routeError(422, 'Finance approval contains a duplicate invoice line.');
      quantities.set(key, quantity);
    }
  } else {
    quantities = new Map([...verifiedByLine].map(([key, item]) => [key, Number(item.returnQty || 0)]));
  }

  return [...quantities].map(([key, quantity]) => {
    const verified = verifiedByLine.get(key);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw routeError(422, 'Warehouse verified return quantities must be finite and greater than zero.');
    }
    return {
      invoiceItem: verified.invoiceItem,
      returnQty: quantity,
      condition: verified.condition,
      warehouse: verified.warehouse,
      reason: complaintReason(complaint.category),
      reasonDetails: complaint.warehouseVerification.problemDescription,
    };
  });
}

export async function createAndPostComplaintSalesReturn({ complaint, decision, adjustmentType, financeItems, approver, remarks, session }) {
  if (!['credit_note', 'refund', 'replacement'].includes(adjustmentType)) {
    throw routeError(422, 'Approved complaints require credit_note, refund, or replacement as the adjustment type.');
  }
  if (complaint.purchaseLineage?.requested || complaint.purchaseReturn) {
    throw routeError(422, 'Purchase Return posting is unavailable without exact supplier invoice, GRN, and purchase-order line lineage.');
  }

  let salesReturn = complaint.salesReturn
    ? await SalesReturn.findOne({ _id: complaint.salesReturn, branch: complaint.branch }).session(session)
    : await SalesReturn.findOne({ complaint: complaint._id, branch: complaint.branch }).session(session);
  if (!salesReturn) {
    const [dealer, order, invoice] = await Promise.all([
      Dealer.findOne({ _id: complaint.dealer }).session(session).lean(),
      SalesOrder.findOne({ _id: complaint.salesOrder, branch: complaint.branch, dealer: complaint.dealer }).session(session).lean(),
      Invoice.findOne({
        _id: complaint.invoice,
        branch: complaint.branch,
        dealer: complaint.dealer,
        status: { $in: ACTIVE_INVOICE_STATUSES },
        invoiceType: 'tax_invoice',
      }).session(session).lean(),
    ]);
    if (!dealer || !order || !invoice || String(invoice.salesOrder) !== String(order._id)) {
      throw routeError(422, 'Complaint approval requires an active invoice with matching dealer and sales-order lineage.');
    }
    if (!['dispatched', 'delivered'].includes(order.status)) {
      throw routeError(422, 'Only invoiced, dispatched or delivered sales can be returned.');
    }
    const returnDate = new Date();
    const data = {
      branch: complaint.branch,
      complaint: complaint._id,
      dealer: dealer._id,
      dealerName: dealer.businessName,
      dealerCode: dealer.dealerCode,
      salesOrder: order._id,
      orderNumber: order.orderNumber,
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      sourceKey: `${String(complaint.branch)}:complaint:${String(complaint._id)}`,
      requestFingerprint: '',
      returnDate,
      adjustmentType,
      status: 'draft',
      createdBy: complaint.createdBy,
      remarks: String(remarks || '').trim(),
      tallySyncStatus: 'not_synced',
      items: complaintReturnItems(complaint, financeItems, decision),
    };
    data.items = await validateSalesReturnItems(data, invoice, { session });
    await assertWarehousesInBranch(data.items.map((item) => item.warehouse).filter(Boolean), complaint.branch, { session });
    applySalesReturnTotals(data);
    data.returnNumber = await generateBranchNumber(complaint.branch, 'salesReturn', returnDate, { session });
    if (adjustmentType === 'credit_note') {
      data.creditNoteNumber = await generateBranchNumber(complaint.branch, 'creditNote', returnDate, { session });
      data.creditNoteDate = returnDate;
    }
    [salesReturn] = await SalesReturn.create([data], { session });
  } else if (salesReturn.adjustmentType !== adjustmentType) {
    throw routeError(409, 'The complaint is already linked to a Sales Return with a different adjustment type.');
  }

  return approveSalesReturn({
    current: salesReturn,
    branchId: complaint.branch,
    approver,
    remarks,
    session,
    warehouseVerifier: complaint.warehouseVerification?.verifiedBy,
  });
}
