import { Router } from 'express';
import mongoose from 'mongoose';
import DispatchReturn from '../models/DispatchReturn.js';
import Delivery from '../models/Delivery.js';
import SalesOrder from '../models/SalesOrder.js';
import Invoice from '../models/Invoice.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { applyStockMovement, stockOperationKey } from '../services/stockMovementService.js';
import { refreshSalesOrderLine, QUANTITY_TOLERANCE } from '../utils/salesOrderInventory.js';

const router = Router();
router.use(protect);
router.use(requireBranch);
router.get(['/', '/:id'], requireAnyPermission('delivery.view', 'stock.view'));
router.post('/', requirePermission('dispatch.return'), requirePermission('delivery.complete'));
router.patch('/:id/verify', requirePermission('dispatch.return'), requirePermission('warehouse.verification'));
router.patch('/:id/approve', requirePermission('dispatch.return'), requirePermission('sales.order.approve'));
router.patch('/:id/reject', requirePermission('dispatch.return'), requirePermission('sales.order.approve'));
router.patch('/:id/cancel', requirePermission('dispatch.return'), requirePermission('delivery.complete'));

const error = (status, message) => Object.assign(new Error(message), { status });
const activeStatuses = ['requested', 'warehouse_verified', 'approved'];

async function refreshDeliveryRecoveryStates(delivery, session = null, excludeReturnId = null) {
  let query = DispatchReturn.find({
    branch: delivery.branch,
    delivery: delivery._id,
    status: { $in: activeStatuses },
    ...(excludeReturnId ? { _id: { $ne: excludeReturnId } } : {}),
  }).select('items').lean();
  if (session) query = query.session(session);
  const active = await query;
  const pendingByItem = new Map();
  for (const record of active) for (const item of record.items || []) pendingByItem.set(String(item.deliveryItem), (pendingByItem.get(String(item.deliveryItem)) || 0) + Number(item.quantity || 0));
  for (const item of delivery.items || []) {
    const pending = pendingByItem.get(String(item._id)) || 0;
    const recoverable = Math.max(0, Number(item.dispatchedQuantity || 0) - Number(item.acceptedQuantity || 0) - Number(item.dispatchReturnedQuantity || 0));
    const discrepancyOutstanding = Math.max(0, Number(item.shortQuantity || 0) + Number(item.damagedRejectedQuantity || 0) - Number(item.dispatchReturnedQuantity || 0));
    item.discrepancyResolutionState = pending > QUANTITY_TOLERANCE
      ? 'return_requested'
      : recoverable <= QUANTITY_TOLERANCE && Number(item.dispatchReturnedQuantity || 0) > 0
        ? 'resolved'
        : discrepancyOutstanding > QUANTITY_TOLERANCE ? 'recorded' : 'none';
  }
}

router.get('/', async (req, res) => {
  try {
    const data = await DispatchReturn.find({ branch: req.branchId }).sort({ createdAt: -1 })
      .populate('delivery', 'deliveryNumber status').populate('salesOrder', 'orderNumber status')
      .populate('requestedBy warehouseVerifiedBy approvedBy', 'name').lean();
    return res.json({ success: true, data });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await DispatchReturn.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('delivery').populate('salesOrder', 'orderNumber status items')
      .populate('requestedBy warehouseVerifiedBy approvedBy rejectedBy cancelledBy', 'name').lean();
    if (!data) return res.status(404).json({ success: false, message: 'Dispatch return not found.' });
    return res.json({ success: true, data });
  } catch (e) { return res.status(e.name === 'CastError' ? 422 : 500).json({ success: false, message: e.message }); }
});

router.post('/', async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason || !Array.isArray(req.body.items) || !req.body.items.length) return res.status(422).json({ success: false, message: 'reason and at least one delivery item are required.' });
  const session = await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      const delivery = await Delivery.findOne({ _id: req.body.delivery, branch: req.branchId }).session(session);
      if (!delivery || !delivery.dispatchTrip || !delivery.salesOrder || !delivery.items?.length) throw error(409, 'An itemized dispatched delivery is required.');
      if (!['assigned', 'in_transit', 'reached', 'partially_delivered', 'failed', 'rescheduled'].includes(delivery.status)) throw error(409, 'Only pre-acceptance or discrepancy delivery states can enter dispatch recovery.');
      const order = await SalesOrder.findOne({ _id: delivery.salesOrder, branch: req.branchId }).session(session);
      if (!order) throw error(409, 'The source Sales Order is unavailable.');
      const activeInvoice = await Invoice.exists({ branch: req.branchId, salesOrder: delivery.salesOrder, status: { $in: ['generated', 'sent'] } }).session(session);
      if (activeInvoice) throw error(409, 'An active invoice exists; use Sales Return instead of dispatched-goods recovery.');
      const prior = await DispatchReturn.find({ branch: req.branchId, delivery: delivery._id, status: { $in: activeStatuses } }).session(session).lean();
      const priorByDeliveryItem = new Map();
      for (const record of prior) for (const item of record.items || []) priorByDeliveryItem.set(String(item.deliveryItem), (priorByDeliveryItem.get(String(item.deliveryItem)) || 0) + Number(item.quantity || 0));
      const seen = new Set();
      const items = req.body.items.map((row, index) => {
        const id = String(row.deliveryItem || '');
        const source = delivery.items.id(id);
        const quantity = Number(row.quantity);
        if (!source || seen.has(id) || !Number.isFinite(quantity) || quantity <= 0 || !['resaleable', 'damaged', 'scrap', 'lost'].includes(row.condition)) throw error(422, `items[${index}] is invalid or duplicated.`);
        seen.add(id);
        const orderLine = order.items.id(source.salesOrderItem);
        if (!orderLine) throw error(409, 'Exact Sales Order line lineage is missing.');
        const eligible = Number(source.dispatchedQuantity || 0) - Number(source.dispatchReturnedQuantity || 0) - Number(source.acceptedQuantity || 0)
          - Number(orderLine.returnedQuantity || 0) - (priorByDeliveryItem.get(id) || 0);
        if (quantity > eligible + QUANTITY_TOLERANCE) throw error(409, `Recovery exceeds remaining dispatched quantity for delivery item ${id}.`);
        return {
          deliveryItem: source._id, pickListItem: source.pickListItem, salesOrderItem: source.salesOrderItem,
          originalDispatchOperationKey: source.originalDispatchOperationKey, product: source.product, warehouse: source.warehouse,
          shade: source.shade || '', batch: source.batch || '', quantity, condition: row.condition,
          enteredUnit: source.enteredUnit || source.baseUnit || 'Unit', baseQuantity: quantity * Number(source.conversionFactor || 1),
          baseUnit: source.baseUnit || source.enteredUnit || 'Unit', conversionFactor: Number(source.conversionFactor || 1),
          uomVersion: Number(source.uomVersion || 1), remarks: String(row.remarks || ''),
        };
      });
      const returnNumber = await generateBranchNumber(req.branchId, 'dispatchReturn', new Date(), { session });
      [created] = await DispatchReturn.create([{
        returnNumber, branch: req.branchId, delivery: delivery._id, dispatchTrip: delivery.dispatchTrip,
        salesOrder: delivery.salesOrder, items, reason, requestedBy: req.user._id, requestedAt: new Date(), status: 'requested',
      }], { session });
      await refreshDeliveryRecoveryStates(delivery, session);
      await delivery.save({ session });
    });
    return res.status(201).json({ success: true, message: `Dispatch return ${created.returnNumber} requested.`, data: created });
  } catch (e) { return res.status(e.status || (e.name === 'CastError' ? 422 : 500)).json({ success: false, message: e.message }); }
  finally { await session.endSession(); }
});

router.patch('/:id/verify', async (req, res) => {
  try {
    const current = await DispatchReturn.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) return res.status(404).json({ success: false, message: 'Dispatch return not found.' });
    if (current.status === 'warehouse_verified') return res.json({ success: true, message: 'Already warehouse verified.', data: current });
    if (current.status !== 'requested') throw error(409, `Cannot verify a ${current.status} dispatch return.`);
    if (String(current.requestedBy) === String(req.user._id)) throw error(403, 'Maker-checker violation: requester cannot warehouse-verify.');
    current.status = 'warehouse_verified'; current.warehouseVerifiedBy = req.user._id; current.warehouseVerifiedAt = new Date();
    await current.save();
    return res.json({ success: true, message: 'Physical recovery warehouse-verified.', data: current });
  } catch (e) { return res.status(e.status || 500).json({ success: false, message: e.message }); }
});

router.patch('/:id/approve', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let current;
    await session.withTransaction(async () => {
      current = await DispatchReturn.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw error(404, 'Dispatch return not found.');
      if (current.status === 'posted') return;
      if (current.status !== 'warehouse_verified') throw error(409, 'Warehouse verification is required before approval.');
      if ([current.requestedBy, current.warehouseVerifiedBy].some(actor => String(actor) === String(req.user._id))) throw error(403, 'Maker-checker violation: requester/verifier cannot approve.');
      const [delivery, order] = await Promise.all([
        Delivery.findOne({ _id: current.delivery, branch: req.branchId }).session(session),
        SalesOrder.findOne({ _id: current.salesOrder, branch: req.branchId }).session(session),
      ]);
      if (!delivery || !order) throw error(409, 'Delivery or Sales Order is unavailable.');
      if (!['assigned', 'in_transit', 'reached', 'partially_delivered', 'failed', 'rescheduled'].includes(delivery.status)) throw error(409, 'Delivery reached a customer-accepted or terminal recovery state before posting.');
      const activeInvoice = await Invoice.exists({ branch: req.branchId, salesOrder: order._id, status: { $in: ['generated', 'sent'] } }).session(session);
      if (activeInvoice) throw error(409, 'An active invoice now exists; dispatched recovery cannot be posted.');
      const postedAt = new Date();
      for (const item of current.items) {
        const deliveryItem = delivery.items.id(item.deliveryItem);
        const orderLine = order.items.id(item.salesOrderItem);
        if (!deliveryItem || !orderLine) throw error(409, 'Exact delivery/Sales Order line lineage is missing.');
        const quantity = Number(item.quantity || 0);
        if (Number(deliveryItem.dispatchReturnedQuantity || 0) + Number(deliveryItem.acceptedQuantity || 0) + Number(orderLine.returnedQuantity || 0) + quantity > Number(deliveryItem.dispatchedQuantity || 0) + QUANTITY_TOLERANCE) throw error(409, 'Combined accepted, dispatch recovery, and Sales Return quantity exceeds the original dispatch quantity.');
        if (['resaleable', 'damaged'].includes(item.condition)) {
          const baseQuantity = Number(item.baseQuantity || quantity);
          const deltas = item.condition === 'resaleable' ? { totalQty: baseQuantity, availableQty: baseQuantity } : { totalQty: baseQuantity, damagedQty: baseQuantity };
          await applyStockMovement({
            operationKey: stockOperationKey('dispatch-return', current._id, item._id, 'post'), correlationKey: stockOperationKey('dispatch-return', current._id),
            movementType: 'sales_dispatch_reversal', phase: 'reversed', branch: current.branch, product: item.product, warehouse: item.warehouse,
            shade: item.shade || '', batch: item.batch || '', deltas, upsert: true, enteredQuantity: quantity, enteredUnit: item.enteredUnit,
            baseQuantity, baseUnit: item.baseUnit, conversionFactor: item.conversionFactor, uomVersion: item.uomVersion,
            sourceType: 'DispatchReturn', sourceModel: 'DispatchReturn', sourceId: current._id, sourceLineId: item._id,
            sourceNumber: current.returnNumber, actor: req.user._id, occurredAt: postedAt, reason: current.reason, remarks: item.remarks,
            reversalOfOperationKey: item.originalDispatchOperationKey, metadata: { delivery: delivery._id, deliveryItem: deliveryItem._id, salesOrder: order._id, salesOrderItem: orderLine._id, condition: item.condition },
          }, { session });
        }
        deliveryItem.dispatchReturnedQuantity = Number(deliveryItem.dispatchReturnedQuantity || 0) + quantity;
        orderLine.dispatchReversedQuantity = Number(orderLine.dispatchReversedQuantity || 0) + quantity;
        refreshSalesOrderLine(orderLine);
      }
      order.status = order.items.some(line => Number(line.remainingQuantity || 0) > QUANTITY_TOLERANCE) ? 'partial_dispatch' : order.status;
      current.status = 'posted'; current.approvedBy = req.user._id; current.approvedAt = postedAt; current.postedAt = postedAt;
      await refreshDeliveryRecoveryStates(delivery, session, current._id);
      if (delivery.items.every(item => Number(item.dispatchReturnedQuantity || 0) + QUANTITY_TOLERANCE >= Number(item.dispatchedQuantity || 0))) delivery.status = 'returned';
      await delivery.save({ session }); await order.save({ session }); await current.save({ session });
    });
    return res.json({ success: true, message: 'Recovered dispatched goods posted without altering historical trip dispatch.', data: current });
  } catch (e) { return res.status(e.status || (e.name === 'CastError' ? 422 : 500)).json({ success: false, message: e.message }); }
  finally { await session.endSession(); }
});

router.patch('/:id/reject', async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(422).json({ success: false, message: 'Rejection reason is required.' });
  try {
    const current = await DispatchReturn.findOne({ _id: req.params.id, branch: req.branchId, status: { $in: ['requested', 'warehouse_verified'] } });
    if (!current) return res.status(409).json({ success: false, message: 'Dispatch return is unavailable or already posted.' });
    if (String(current.requestedBy) === String(req.user._id)) throw error(403, 'Requester cannot reject their own request.');
    current.status = 'rejected'; current.rejectedBy = req.user._id; current.rejectedAt = new Date(); current.rejectionReason = reason;
    await current.save();
    const delivery = await Delivery.findOne({ _id: current.delivery, branch: current.branch });
    if (delivery) { await refreshDeliveryRecoveryStates(delivery); await delivery.save(); }
    return res.json({ success: true, message: 'Dispatch return rejected.', data: current });
  } catch (e) { return res.status(e.status || 500).json({ success: false, message: e.message }); }
});

router.patch('/:id/cancel', async (req, res) => {
  try {
    const current = await DispatchReturn.findOne({ _id: req.params.id, branch: req.branchId, status: 'requested', requestedBy: req.user._id });
    if (!current) return res.status(409).json({ success: false, message: 'Only the requester can cancel an unverified dispatch return.' });
    current.status = 'cancelled'; current.cancelledBy = req.user._id; current.cancelledAt = new Date(); await current.save();
    const delivery = await Delivery.findOne({ _id: current.delivery, branch: current.branch });
    if (delivery) { await refreshDeliveryRecoveryStates(delivery); await delivery.save(); }
    return res.json({ success: true, message: 'Dispatch return cancelled.', data: current });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

export default router;
