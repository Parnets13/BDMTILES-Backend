import ApprovalRequest from '../models/ApprovalRequest.js';
import DealerLedger from '../models/DealerLedger.js';
import DispatchTrip from '../models/DispatchTrip.js';
import PickList from '../models/PickList.js';
import SalesOrder from '../models/SalesOrder.js';
import { applyStockMovement, stockOperationKey } from './stockMovementService.js';
import { stableUomSnapshot } from './stockUomService.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';
import { QUANTITY_TOLERANCE, refreshSalesOrderLine } from '../utils/salesOrderInventory.js';

const domainError = (status, message) => Object.assign(new Error(message), { status });
const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export async function actionSalesOrderRemainingCancellation({ branchId, orderId, approvalRequestId, actorId, nextStatus, remarks, session }) {
  if (!session) throw domainError(500, 'Remaining cancellation action requires an active transaction.');
  if (!['approved', 'rejected'].includes(nextStatus)) throw domainError(422, 'Unsupported remaining-cancellation action.');
  const reviewReason = String(remarks || '').trim();
  if (!reviewReason) throw domainError(422, 'A review reason is required.');

  const order = await SalesOrder.findOne({ _id: orderId, branch: branchId, remainingCancellationStatus: 'pending' }).session(session);
  if (!order) throw domainError(409, 'Sales Order is not pending remaining cancellation.');
  if (order.remainingCancellationRequestedBy && String(order.remainingCancellationRequestedBy) === String(actorId)) {
    throw domainError(403, 'Maker-checker violation: the requester cannot review this cancellation.');
  }
  const approval = await ApprovalRequest.findOne({
    _id: approvalRequestId || order.remainingCancellationApprovalRequest,
    branch: branchId,
    type: 'sales_order_remaining_cancellation',
    referenceModel: 'SalesOrder',
    referenceId: order._id,
    status: 'pending',
  }).session(session);
  if (!approval || String(order.remainingCancellationApprovalRequest) !== String(approval._id)) {
    throw domainError(409, 'The linked approval request is unavailable, mismatched, or already actioned.');
  }
  if (approval.requestedBy && String(approval.requestedBy) === String(actorId)) {
    throw domainError(403, 'Maker-checker violation: the approval requester cannot review this cancellation.');
  }
  const reviewedAt = new Date();
  if (nextStatus === 'rejected') {
    const actioned = await ApprovalRequest.findOneAndUpdate(
      { _id: approval._id, branch: branchId, status: 'pending' },
      { $set: { status: 'rejected', approvedBy: actorId, approvedAt: reviewedAt, approvalRemarks: reviewReason } },
      { new: true, session }
    );
    if (!actioned) throw domainError(409, 'Approval was actioned by another request.');
    order.remainingCancellationStatus = 'rejected';
    order.remainingCancellationReviewedAt = reviewedAt;
    order.remainingCancellationReviewedBy = actorId;
    await order.save({ session });
    return { order, approval: actioned };
  }

  if (order.closureFinancialSummary) throw domainError(409, 'This Sales Order already has an immutable closure financial summary.');
  const activeClaim = await DispatchTrip.exists({ branch: branchId, stockDeductedAt: null, status: { $in: ['planning', 'loading', 'loaded'] }, 'orders.salesOrder': order._id }).session(session);
  const progressedPick = await PickList.exists({ branch: branchId, salesOrder: order._id, stockConsumedAt: null, status: { $in: ['in_progress', 'picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch', 'loaded'] } }).session(session);
  if (activeClaim || progressedPick) throw domainError(409, 'Cancel or complete active claimed/in-progress picks before closing the remaining quantity.');
  await PickList.updateMany(
    { branch: branchId, salesOrder: order._id, stockConsumedAt: null, status: { $in: ['generated', 'assigned'] } },
    { $set: { status: 'cancelled', stockReserved: false, reservationState: 'released', reservationReleasedAt: reviewedAt }, $unset: { dispatchTrip: 1, tripClaimedAt: 1 } },
    { session }
  );

  const version = Number(order.remainingCancellationVersion || 0) + 1;
  let cancelledLineCommercial = 0;
  const originalLineCommercial = order.items.reduce((sum, line) => sum + Number(line.totalAmount || 0), 0);
  const lines = [];
  for (const line of order.items) {
    const ordered = Number(line.quantity || 0);
    const cancelQuantity = Math.max(0, ordered - Number(line.dispatchedQuantity || 0) + Number(line.dispatchReversedQuantity || 0) - Number(line.cancelledRemainingQuantity || 0));
    if (!(cancelQuantity > QUANTITY_TOLERANCE)) continue;
    const releaseQuantity = Math.min(cancelQuantity, Number(line.reservedQuantity || 0));
    if (releaseQuantity > QUANTITY_TOLERANCE) {
      const snapshot = stableUomSnapshot(line);
      const baseQuantity = releaseQuantity * snapshot.conversionFactor;
      await applyStockMovement({
        operationKey: stockOperationKey('sales-order', order._id, line._id, 'remaining-cancel', version),
        correlationKey: stockOperationKey('sales-order', order._id, 'remaining-cancel', version),
        movementType: 'sales_remaining_cancel', phase: 'released', branch: order.branch,
        product: line.product, warehouse: line.warehouse, shade: line.shade || '', batch: line.batch || '',
        deltas: { reservedQty: -baseQuantity, availableQty: baseQuantity }, enteredQuantity: releaseQuantity, ...snapshot, baseQuantity,
        sourceType: 'SalesOrder', sourceModel: 'SalesOrder', sourceId: order._id, sourceLineId: line._id,
        sourceNumber: order.orderNumber, actor: actorId, occurredAt: reviewedAt, reason: order.remainingCancellationReason,
        metadata: { remainingCancellationVersion: version, cancelQuantity, releaseQuantity },
        guardMessage: `Reserved stock changed for ${line.productName || 'Sales Order item'}.`,
      }, { session });
    }
    const commercial = money(Number(line.totalAmount || 0) * cancelQuantity / ordered);
    cancelledLineCommercial += commercial;
    lines.push({ salesOrderItem: line._id, orderedQuantity: ordered, dispatchedQuantity: Number(line.dispatchedQuantity || 0), cancelledQuantity: cancelQuantity, releasedReservedQuantity: releaseQuantity, commercialCredit: commercial });
    line.cancelledRemainingQuantity = Number(line.cancelledRemainingQuantity || 0) + cancelQuantity;
    line.reservedQuantity = Math.max(0, Number(line.reservedQuantity || 0) - releaseQuantity);
    line.allocatedQuantity = 0;
    refreshSalesOrderLine(line);
  }
  if (!lines.length) throw domainError(409, 'No open quantity remains to cancel.');

  const headerRatio = originalLineCommercial > 0 ? cancelledLineCommercial / originalLineCommercial : 0;
  const chargeFields = ['freightCharges', 'loadingCharges', 'installationCharges', 'otherCharges'];
  const headerCharges = Object.fromEntries(chargeFields.map(field => [field, money(Number(order[field] || 0) * headerRatio)]));
  const headerCredit = Object.values(headerCharges).reduce((sum, value) => sum + value, 0);
  const retainedLineCommercial = order.items.reduce((sum, line) => {
    const ordered = Number(line.quantity || 0);
    const netDispatched = Math.max(0, Number(line.dispatchedQuantity || 0) - Number(line.dispatchReversedQuantity || 0));
    return sum + (ordered > 0 ? Number(line.totalAmount || 0) * netDispatched / ordered : 0);
  }, 0);
  const retainedHeaderCharges = Object.fromEntries(chargeFields.map(field => [field, Math.max(0, Number(order[field] || 0) - Number(headerCharges[field] || 0))]));
  const expectedFinalInvoiceGrandTotal = Math.round(retainedLineCommercial + Object.values(retainedHeaderCharges).reduce((sum, value) => sum + value, 0));
  const totalCredit = Math.max(0, money(Number(order.grandTotal || 0) - expectedFinalInvoiceGrandTotal));
  const roundingCredit = money(totalCredit - cancelledLineCommercial - headerCredit);
  const originalPosting = order.dealer ? await DealerLedger.exists({ branch: order.branch, dealer: order.dealer, postingKey: `sales-order:${order._id}:confirmed` }).session(session) : null;
  if (originalPosting && totalCredit > 0) {
    await postSubledgerEntry({ session, branch: order.branch, partyType: 'dealer', partyId: order.dealer, amount: totalCredit, side: 'credit',
      postingKey: `sales-order:${order._id}:remaining-cancel:${version}`, entryType: 'credit_note', entryDate: reviewedAt,
      description: `Commercial credit for cancelled remaining quantity on ${order.orderNumber}`, referenceNumber: order.orderNumber,
      referenceModel: 'SalesOrder', referenceId: order._id, createdBy: actorId });
  }
  order.closureFinancialSummary = { version, postedAt: reviewedAt, postedBy: actorId, reason: order.remainingCancellationReason, lines, cancelledLineCommercial, headerCharges, headerCredit, retainedHeaderCharges, retainedLineCommercial: Math.round(retainedLineCommercial * 100) / 100, expectedFinalInvoiceGrandTotal, roundingCredit, originalConfirmationReceivable: Number(order.grandTotal || 0), totalCredit, reconciliationEquation: `${Number(order.grandTotal || 0)} - ${totalCredit} = ${expectedFinalInvoiceGrandTotal}`, receivableCreditPosted: Boolean(originalPosting && totalCredit > 0) };
  order.remainingCancellationVersion = version;
  order.remainingCancellationStatus = 'approved';
  order.remainingCancellationReviewedAt = reviewedAt;
  order.remainingCancellationReviewedBy = actorId;
  order.reservationStatus = 'released';
  order.reservationReleasedAt = reviewedAt;
  order.status = 'partially_closed';
  const actioned = await ApprovalRequest.findOneAndUpdate(
    { _id: approval._id, branch: branchId, status: 'pending' },
    { $set: { status: 'approved', approvedBy: actorId, approvedAt: reviewedAt, approvalRemarks: reviewReason } },
    { new: true, session }
  );
  if (!actioned) throw domainError(409, 'Approval was actioned by another request.');
  await order.save({ session });
  return { order, approval: actioned };
}

export default actionSalesOrderRemainingCancellation;
