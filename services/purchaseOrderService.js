import mongoose from 'mongoose';
import ApprovalRequest from '../models/ApprovalRequest.js';
import Product from '../models/Product.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import PurchaseRequisition from '../models/PurchaseRequisition.js';
import Supplier from '../models/Supplier.js';
import { assertWarehousesInBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

export const purchaseError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const idText = value => String(value?._id || value || '');

const nonnegative = (value, field) => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw purchaseError(422, `${field} must be a finite nonnegative number.`);
  return parsed;
};

const positive = (value, field) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw purchaseError(422, `${field} must be a finite positive number.`);
  return parsed;
};

export async function calculatePurchaseOrder({ branchId, input, session = null }) {
  if (!input.supplier) throw purchaseError(422, 'Supplier is required.');
  if (!input.receivingWarehouse) throw purchaseError(422, 'Receiving warehouse is required.');
  if (!Array.isArray(input.items) || !input.items.length) throw purchaseError(422, 'At least one purchase order item is required.');

  let supplierQuery = Supplier.findOne({ _id: input.supplier, status: 'active' }).lean();
  if (session) supplierQuery = supplierQuery.session(session);
  const supplier = await supplierQuery;
  if (!supplier) throw purchaseError(404, 'Active supplier not found.');
  await assertWarehousesInBranch([input.receivingWarehouse], branchId, { session });

  const productIds = input.items.map(item => item.product);
  if (productIds.some(id => !mongoose.isValidObjectId(id))) throw purchaseError(422, 'One or more product identifiers are invalid.');
  let productQuery = Product.find({ _id: { $in: productIds }, status: { $ne: 'inactive' } })
    .select('itemName productCode unit gst basicPrice excessPrice maxPurchaseRate').lean();
  if (session) productQuery = productQuery.session(session);
  const products = await productQuery;
  const productMap = new Map(products.map(product => [String(product._id), product]));
  if (productMap.size !== new Set(productIds.map(String)).size) throw purchaseError(404, 'One or more active products were not found.');

  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  const items = input.items.map((item, index) => {
    const product = productMap.get(String(item.product));
    const quantity = positive(item.quantity, `items[${index}].quantity`);
    const rate = nonnegative(item.rate, `items[${index}].rate`);
    const discount = nonnegative(item.discount, `items[${index}].discount`);
    const schemeDiscount = nonnegative(item.schemeDiscount, `items[${index}].schemeDiscount`);
    const gstPercentage = nonnegative(item.gstPercentage ?? product.gst ?? 18, `items[${index}].gstPercentage`);
    if (gstPercentage > 100) throw purchaseError(422, `items[${index}].gstPercentage cannot exceed 100.`);
    if (product.maxPurchaseRate > 0 && rate > product.maxPurchaseRate) {
      throw purchaseError(422, `${product.productCode || product.itemName}: rate ${rate} exceeds maximum purchase rate ${product.maxPurchaseRate}.`);
    }
    const base = money(quantity * rate);
    if (discount + schemeDiscount > base) throw purchaseError(422, `items[${index}] discounts cannot exceed its base amount.`);
    const taxableAmount = money(base - discount - schemeDiscount);
    const gstAmount = money(taxableAmount * gstPercentage / 100);
    subtotal = money(subtotal + base);
    totalDiscount = money(totalDiscount + discount + schemeDiscount);
    totalTax = money(totalTax + gstAmount);
    return {
      product: product._id,
      productCode: product.productCode || '',
      productName: product.itemName,
      quantity,
      unit: product.unit || 'Box',
      rate,
      discount,
      schemeDiscount,
      scheme: String(item.scheme || ''),
      gstPercentage,
      taxableAmount,
      gstAmount,
      totalAmount: money(taxableAmount + gstAmount),
      receivedQty: 0,
      pendingQty: quantity,
    };
  });

  const freight = nonnegative(input.freight, 'freight');
  const loading = nonnegative(input.loading, 'loading');
  const insurance = nonnegative(input.insurance, 'insurance');
  return {
    supplier: supplier._id,
    supplierName: supplier.companyName,
    receivingWarehouse: input.receivingWarehouse,
    items,
    subtotal,
    totalDiscount,
    totalTax,
    freight,
    loading,
    insurance,
    grandTotal: money(subtotal - totalDiscount + totalTax + freight + loading + insurance),
    paymentTerms: String(input.paymentTerms ?? supplier.paymentTerms ?? ''),
    creditDays: nonnegative(input.creditDays ?? supplier.creditDays, 'creditDays'),
    expectedDeliveryDate: input.expectedDeliveryDate || undefined,
    deliveryAddress: String(input.deliveryAddress || ''),
    remarks: String(input.remarks || ''),
  };
}

const commercialItemSignature = item => JSON.stringify({
  product: idText(item.product),
  quantity: Number(item.quantity),
  unit: String(item.unit || ''),
  rate: Number(item.rate),
  discount: Number(item.discount || 0),
  schemeDiscount: Number(item.schemeDiscount || 0),
  scheme: String(item.scheme || ''),
  gstPercentage: Number(item.gstPercentage),
});

const requisitionItemSignature = item => JSON.stringify({
  product: idText(item.product),
  quantity: Number(item.quantity ?? item.requiredQty),
});

const sortedSignatures = (items, signature) => items.map(signature).sort();
const sameDate = (left, right) => {
  const leftTime = left ? new Date(left).getTime() : null;
  const rightTime = right ? new Date(right).getTime() : null;
  return leftTime === rightTime;
};

export async function assertPurchaseOrderSourceIntegrity({ branchId, po, calculated, session }) {
  if (!po.sourceRequisition) return;

  const requisition = await PurchaseRequisition.findOne({ _id: po.sourceRequisition, branch: branchId }).session(session);
  if (!requisition) throw purchaseError(409, 'The source purchase requisition is no longer available in the active branch.');
  const expectedItems = sortedSignatures(requisition.items, requisitionItemSignature);
  const actualItems = sortedSignatures(calculated.items, requisitionItemSignature);
  if (JSON.stringify(expectedItems) !== JSON.stringify(actualItems)) {
    throw purchaseError(409, 'A requisition-converted PO must retain the requisition products and quantities.');
  }

  if (!po.sourceSupplierQuotation) return;
  const SupplierQuotation = mongoose.model('SupplierQuotation');
  const quotation = await SupplierQuotation.findOne({
    _id: po.sourceSupplierQuotation,
    branch: branchId,
    purchaseRequisition: requisition._id,
  }).session(session);
  const offer = quotation?.offers?.id(po.sourceSupplierOffer);
  if (!quotation || !offer || idText(offer.supplier) !== idText(calculated.supplier)) {
    throw purchaseError(409, 'The selected supplier quotation provenance is invalid.');
  }

  const expectedCommercialItems = sortedSignatures(offer.items.map(item => ({
    product: item.product,
    quantity: item.quantity,
    unit: item.unit,
    rate: item.offeredRate,
    discount: item.discount,
    schemeDiscount: item.schemeDiscount,
    scheme: item.scheme,
    gstPercentage: item.gstPercentage,
  })), commercialItemSignature);
  const actualCommercialItems = sortedSignatures(calculated.items, commercialItemSignature);
  const sourceTermsChanged = idText(calculated.receivingWarehouse) !== idText(quotation.warehouse)
    || JSON.stringify(expectedCommercialItems) !== JSON.stringify(actualCommercialItems)
    || Number(calculated.freight) !== Number(offer.freight)
    || Number(calculated.loading) !== Number(offer.loading)
    || Number(calculated.insurance) !== Number(offer.insurance)
    || Number(calculated.creditDays) !== Number(offer.creditDays)
    || String(calculated.paymentTerms || '') !== String(offer.paymentTerms || '')
    || !sameDate(calculated.expectedDeliveryDate, offer.promisedDeliveryDate);
  if (sourceTermsChanged) {
    throw purchaseError(409, 'Commercial terms converted from a selected supplier quotation cannot be amended on the PO.');
  }
}

export async function createPurchaseOrder({ branchId, input, actorId, session = null, provenance = {} }) {
  const calculated = await calculatePurchaseOrder({ branchId, input, session });
  const poNumber = await generateBranchNumber(branchId, 'purchaseOrder', input.poDate || new Date(), { session });
  const data = {
    ...calculated,
    poNumber,
    branch: branchId,
    poDate: input.poDate || new Date(),
    status: 'draft',
    createdBy: actorId,
    tallySyncStatus: 'not_synced',
    ...provenance,
  };
  if (session) {
    const [po] = await PurchaseOrder.create([data], { session });
    return po;
  }
  return PurchaseOrder.create(data);
}

const prLineKey = line => idText(line._id) || idText(line.product);

export async function convertRequisitionToPurchaseOrder({
  branchId, requisitionId, input, actorId, sourceKey, requestFingerprint,
  sourceSupplierQuotation = null, sourceSupplierOffer = null, session,
}) {
  const existing = await PurchaseOrder.findOne({ branch: branchId, sourceKey }).session(session);
  if (existing) {
    if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
      throw purchaseError(409, 'This conversion key was already used with a different payload.');
    }
    return { po: existing, replayed: true };
  }

  if (!sourceSupplierQuotation || !sourceSupplierOffer) {
    throw purchaseError(
      405,
      'A selected supplier quotation and supplier offer are required to create a purchase order.',
      'PR_SUPPLIER_QUOTATION_REQUIRED'
    );
  }

  const pr = await PurchaseRequisition.findOne({ _id: requisitionId, branch: branchId }).session(session);
  if (!pr) throw purchaseError(404, 'Approved purchase requisition not found in the active branch.');
  if (pr.linkedPO || pr.status === 'po_created') throw purchaseError(409, 'Purchase requisition is already linked to a purchase order.');
  if (pr.status !== 'approved') throw purchaseError(409, 'Only an approved purchase requisition can be converted.');
  if (!Array.isArray(input.items) || input.items.length !== pr.items.length) {
    throw purchaseError(422, 'PO items must match every purchase requisition item exactly.');
  }

  const expected = new Map();
  for (const line of pr.items) {
    const key = prLineKey(line);
    if (!key || expected.has(key)) throw purchaseError(422, 'Purchase requisition contains ambiguous item identities.');
    expected.set(key, line);
  }
  const seen = new Set();
  for (const [index, item] of input.items.entries()) {
    const key = idText(item.requisitionItem) || idText(item.product);
    const prLine = expected.get(key) || [...expected.values()].find(line => idText(line.product) === idText(item.product));
    if (!prLine || seen.has(prLineKey(prLine))) throw purchaseError(422, `items[${index}] does not uniquely match a requisition item.`);
    if (idText(item.product) !== idText(prLine.product)) throw purchaseError(422, `items[${index}] product does not match the requisition.`);
    if (Number(item.quantity) !== Number(prLine.requiredQty)) throw purchaseError(422, `items[${index}] quantity must equal the requisition quantity.`);
    seen.add(prLineKey(prLine));
  }

  const po = await createPurchaseOrder({
    branchId,
    input: { ...input, receivingWarehouse: input.receivingWarehouse || pr.warehouse },
    actorId,
    session,
    provenance: {
      sourceRequisition: pr._id,
      sourceSupplierQuotation: sourceSupplierQuotation || undefined,
      sourceSupplierOffer: sourceSupplierOffer || undefined,
      sourceKey,
      requestFingerprint,
    },
  });
  const linked = await PurchaseRequisition.findOneAndUpdate(
    { _id: pr._id, branch: branchId, status: 'approved', linkedPO: { $exists: false } },
    { $set: { linkedPO: po._id, status: 'po_created' } },
    { new: true, session }
  );
  if (!linked) throw purchaseError(409, 'Purchase requisition was converted concurrently.');
  return { po, requisition: linked, replayed: false };
}

export async function submitPurchaseOrder({ branchId, poId, actor, remarks = '', session }) {
  const po = await PurchaseOrder.findOne({ _id: poId, branch: branchId }).session(session);
  if (!po) throw purchaseError(404, 'Purchase order not found.');
  if (po.status === 'pending_approval' || po.status === 'submitted') {
    const approval = await ApprovalRequest.findOne({ branch: branchId, type: 'purchase_order', referenceId: po._id, status: 'pending' }).session(session);
    return { po, approval, replayed: true };
  }
  if (po.status !== 'draft') throw purchaseError(409, 'Only a draft purchase order can be submitted.');

  const existing = await ApprovalRequest.findOne({ branch: branchId, type: 'purchase_order', referenceId: po._id, status: 'pending' }).session(session);
  let approval = existing;
  if (!approval) {
    const requestNumber = await generateBranchNumber(branchId, 'approval', new Date(), { session });
    [approval] = await ApprovalRequest.create([{
      requestNumber,
      branch: branchId,
      type: 'purchase_order',
      title: `Approve Purchase Order ${po.poNumber}`,
      description: remarks || `Purchase order for ${po.supplierName}`,
      referenceModel: 'PurchaseOrder',
      referenceId: po._id,
      referenceNumber: po.poNumber,
      requestedValue: po.grandTotal,
      requestedBy: actor._id,
      requestedByName: actor.name,
      status: 'pending',
      priority: 'normal',
      isAutomatic: true,
    }], { session });
  }
  po.status = 'pending_approval';
  po.activeApprovalRequest = approval._id;
  po.approvalWorkflow.push({ level: po.approvalWorkflow.length + 1, approver: actor._id, status: 'pending', date: new Date(), remarks });
  await po.save({ session });
  return { po, approval, replayed: false };
}

export async function actionPurchaseOrderApproval({
  branchId, poId, actorId, nextStatus, remarks = '', session, approvalRequestId = null,
}) {
  if (!['approved', 'rejected'].includes(nextStatus)) throw purchaseError(422, 'Unsupported purchase order approval action.');
  const po = await PurchaseOrder.findOne({ _id: poId, branch: branchId }).session(session);
  if (!po) throw purchaseError(404, 'Purchase order not found.');

  const actionedAt = new Date();
  const pendingRequestFilter = {
    branch: branchId,
    type: 'purchase_order',
    referenceModel: 'PurchaseOrder',
    referenceId: po._id,
    status: 'pending',
  };

  if (po.status === nextStatus) {
    await ApprovalRequest.updateMany(
      pendingRequestFilter,
      { $set: { status: nextStatus, approvedBy: actorId, approvedAt: actionedAt, approvalRemarks: remarks } },
      { session }
    );
    if (po.activeApprovalRequest) {
      po.activeApprovalRequest = undefined;
      await po.save({ session });
    }
    return { po, replayed: true };
  }
  if (!['submitted', 'pending_approval'].includes(po.status)) {
    throw purchaseError(409, `A purchase order in ${po.status} status cannot be ${nextStatus}.`);
  }

  if (approvalRequestId) {
    const approval = await ApprovalRequest.findOne({
      _id: approvalRequestId,
      ...pendingRequestFilter,
    }).session(session);
    if (!approval) throw purchaseError(409, 'The linked purchase order approval request is no longer pending.');
  }

  po.status = nextStatus;
  po.activeApprovalRequest = undefined;
  po.approvalWorkflow.push({
    level: po.approvalWorkflow.length + 1,
    approver: actorId,
    status: nextStatus,
    date: actionedAt,
    remarks,
  });
  if (nextStatus === 'approved') {
    po.approvedBy = actorId;
    po.approvedAt = actionedAt;
    po.rejectionReason = '';
  } else {
    po.approvedBy = undefined;
    po.approvedAt = undefined;
    po.rejectionReason = remarks;
  }
  await po.save({ session });

  await ApprovalRequest.updateMany(
    pendingRequestFilter,
    { $set: { status: nextStatus, approvedBy: actorId, approvedAt: actionedAt, approvalRemarks: remarks } },
    { session }
  );
  return { po, replayed: false };
}

const snapshotItem = item => ({
  product: item.product,
  productCode: item.productCode,
  productName: item.productName,
  quantity: item.quantity,
  unit: item.unit,
  rate: item.rate,
  discount: item.discount,
  schemeDiscount: item.schemeDiscount,
  scheme: item.scheme,
  gstPercentage: item.gstPercentage,
  taxableAmount: item.taxableAmount,
  gstAmount: item.gstAmount,
  totalAmount: item.totalAmount,
  receivedQty: item.receivedQty,
  pendingQty: item.pendingQty,
});

export function purchaseOrderSnapshot(po) {
  return {
    supplier: po.supplier,
    receivingWarehouse: po.receivingWarehouse,
    items: po.items.map(snapshotItem),
    freight: po.freight,
    loading: po.loading,
    insurance: po.insurance,
    paymentTerms: po.paymentTerms,
    creditDays: po.creditDays,
    expectedDeliveryDate: po.expectedDeliveryDate,
    deliveryAddress: po.deliveryAddress,
    remarks: po.remarks,
    totals: {
      subtotal: po.subtotal,
      totalDiscount: po.totalDiscount,
      totalTax: po.totalTax,
      grandTotal: po.grandTotal,
    },
  };
}

export function amendmentDiff(before, after) {
  const diff = [];
  for (const field of ['supplier', 'receivingWarehouse', 'items', 'freight', 'loading', 'insurance', 'paymentTerms', 'creditDays', 'expectedDeliveryDate', 'deliveryAddress', 'remarks', 'totals']) {
    const previous = JSON.stringify(before[field] ?? null);
    const next = JSON.stringify(after[field] ?? null);
    if (previous !== next) diff.push({ field, before: before[field], after: after[field] });
  }
  return diff;
}
