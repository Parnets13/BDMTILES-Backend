import ApprovalRequest from '../models/ApprovalRequest.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint } from '../utils/idempotency.js';

const idText = (value) => String(value?._id || value || '');

export function approvalExposureFingerprint(document) {
  const source = document?.toObject?.() || document || {};
  return requestFingerprint({
    dealer: idText(source.dealer),
    dealerType: idText(source.dealerType),
    customerName: source.customerName || '',
    customerPhone: source.customerPhone || '',
    customerAddress: source.customerAddress || source.deliveryAddress || '',
    expectedDeliveryDate: source.expectedDeliveryDate || null,
    orderType: source.orderType || source.customerType || '',
    pricingDate: source.orderDate || source.quotationDate || null,
    items: (source.items || []).map((item) => ({
      product: idText(item.product), warehouse: idText(item.warehouse),
      shade: item.shade || '', batch: item.batch || '',
      boxes: Number(item.boxes || 0), pieces: Number(item.pieces || 0), sqft: Number(item.sqft || 0),
      quantity: Number(item.quantity || 0), rate: Number(item.rate || 0),
      discount: Number(item.discount || 0), schemeDiscount: Number(item.schemeDiscount || 0),
      taxableAmount: Number(item.taxableAmount || 0), gstAmount: Number(item.gstAmount || 0),
      totalAmount: Number(item.totalAmount || 0),
      effectiveRate: Number(item.pricingSnapshot?.effectiveRate ?? item.rate ?? 0),
      minimumSellingRate: Number(item.pricingSnapshot?.minimumSellingRate || 0),
    })),
    subtotal: Number(source.subtotal || 0),
    totalDiscount: Number(source.totalDiscount || 0),
    totalSchemeDiscount: Number(source.totalSchemeDiscount || 0),
    totalTax: Number(source.totalTax || 0),
    freightCharges: Number(source.freightCharges || 0),
    loadingCharges: Number(source.loadingCharges || 0),
    installationCharges: Number(source.installationCharges || 0),
    otherCharges: Number(source.otherCharges || 0),
    advanceAmount: Number(source.advanceAmount || 0),
    grandTotal: Number(source.grandTotal || 0),
    approvalReasons: (source.approvalReasons || []).map((reason) => ({
      type: reason.type, itemIndex: reason.itemIndex,
      product: idText(reason.product), subject: reason.subject || '',
      requestedValue: Number(reason.requestedValue || 0),
      thresholdValue: Number(reason.thresholdValue || 0),
    })),
  });
}

const automaticFilter = ({ branchId, type, referenceModel, referenceId }) => ({
  branch: branchId,
  type,
  referenceModel,
  referenceId,
  isAutomatic: true,
  status: 'pending',
});

function reasonDescription(reasons) {
  return reasons.map((reason) => reason.message).filter(Boolean).join(' ');
}

export async function syncAutomaticApprovalRequest({
  branchId,
  type,
  referenceModel,
  referenceId,
  referenceNumber,
  title,
  reasons = [],
  requestedBy,
  requestedByName,
  requestedValue,
  document,
  session = null,
}) {
  const filter = automaticFilter({ branchId, type, referenceModel, referenceId });
  const pendingReasons = reasons.filter((reason) => reason.status === 'pending');

  if (!pendingReasons.length) {
    await ApprovalRequest.updateMany(
      filter,
      { $set: { status: 'cancelled' } },
      session ? { session } : undefined
    );
    return null;
  }

  const onlyReason = pendingReasons.length === 1 ? pendingReasons[0] : null;
  const values = {
    title,
    description: reasonDescription(pendingReasons),
    referenceNumber,
    requestedValue: onlyReason?.requestedValue ?? requestedValue,
    currentValue: onlyReason?.thresholdValue,
    reason: [...new Set(pendingReasons.map((reason) => reason.type))].join(', '),
    requestedBy,
    requestedByName,
    priority: pendingReasons.some((reason) => ['credit_limit', 'overdue_credit', 'credit_days'].includes(reason.type)) ? 'urgent' : 'normal',
    exposureFingerprint: approvalExposureFingerprint(document),
  };

  let query = ApprovalRequest.findOne(filter);
  if (session) query = query.session(session);
  const existing = await query;
  if (existing) {
    const materialFields = ['title', 'description', 'referenceNumber', 'requestedValue', 'currentValue', 'reason', 'priority', 'exposureFingerprint'];
    const unchanged = materialFields.every((field) => String(existing.get(field) ?? '') === String(values[field] ?? ''));
    if (unchanged) return existing;
    existing.status = 'cancelled';
    await existing.save(session ? { session } : undefined);
  }

  const requestNumber = await generateBranchNumber(branchId, 'approval', new Date());
  const data = {
    ...filter,
    ...values,
    requestNumber,
  };
  if (session) {
    const [created] = await ApprovalRequest.create([data], { session });
    return created;
  }
  return ApprovalRequest.create(data);
}
