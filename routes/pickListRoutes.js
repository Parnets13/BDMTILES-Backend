import { Router } from 'express';
import mongoose from 'mongoose';
import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import SalesOrder from '../models/SalesOrder.js';
import { applyStockMovement, stockOperationKey } from '../services/stockMovementService.js';
import { stableUomSnapshot } from '../services/stockUomService.js';
import User from '../models/User.js';
import Vehicle from '../models/Vehicle.js';
import Delivery from '../models/Delivery.js';
import { ROLE_DEFAULT_PERMISSIONS } from '../config/permissions.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { QUANTITY_TOLERANCE, refreshSalesOrderLine, reserveSalesOrderInventory } from '../utils/salesOrderInventory.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

router.get(['/', '/stats', '/:id'], requireAnyPermission('picking.management', 'sorting.management', 'dispatch.management'));
router.get('/assignable-staff', requireAnyPermission('picking.management', 'sorting.management', 'dispatch.management'));
router.get('/delivery-executives', requireAnyPermission('dispatch.management', 'dispatch.verify'));
router.get('/available-vehicles', requireAnyPermission('dispatch.management', 'dispatch.verify'));
router.post('/generate/:soId', requireAnyPermission('sales.order.approve', 'picking.management'));
router.patch(
  ['/:id/assign', '/:id/start', '/:id/complete-picking', '/:id/verify'],
  requirePermission('picking.management')
);
router.patch(['/:id/sort', '/:id/pack'], requirePermission('sorting.management'));
router.patch('/:id/ready', requireAnyPermission('sorting.management', 'dispatch.management'));
router.patch('/:id/verify-loading', requireAnyPermission('dispatch.management', 'dispatch.verify'));
router.patch('/:id/mark-short', requireAnyPermission('picking.management', 'sorting.management'));

const stateError = (res, record, expected, action) => res.status(409).json({
  success: false,
  message: `Cannot ${action} while pick list is "${record.status}". Expected "${expected}".`,
});

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, assignedTo, priority } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ pickListNumber: regex }, { orderNumber: regex }, { dealerName: regex }];
    }
    if (status) {
      const statuses = String(status).split(',').map(value => value.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }
    if (assignedTo) filter.assignedTo = assignedTo;
    if (priority) filter.priority = priority;

    const [pickLists, total] = await Promise.all([
      PickList.find(filter).sort({ priority: -1, createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('assignedTo', 'name')
        .populate('salesOrder', 'orderNumber dealerName status')
        .lean(),
      PickList.countDocuments(filter),
    ]);
    res.json({ success: true, data: pickLists, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const statuses = ['generated', 'assigned', 'in_progress', 'picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch', 'loaded'];
    const [total, ...counts] = await Promise.all([
      PickList.countDocuments({ branch: req.branchId }),
      ...statuses.map(status => PickList.countDocuments({ branch: req.branchId, status })),
    ]);
    const data = { total };
    statuses.forEach((status, index) => { data[status === 'in_progress' ? 'inProgress' : status === 'ready_for_dispatch' ? 'ready' : status] = counts[index]; });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/reserve-backorder/:soId', requireAnyPermission('sales.order.approve', 'picking.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      order = await SalesOrder.findOne({ _id: req.params.soId, branch: req.branchId }).session(session);
      if (!order) throw Object.assign(new Error('Sales Order not found.'), { status: 404 });
      if (!['confirmed', 'approved', 'processing', 'partial_dispatch'].includes(order.status)) {
        throw Object.assign(new Error(`Cannot reserve a backorder for a Sales Order in "${order.status}" status.`), { status: 409 });
      }
      if (['pending', 'rejected'].includes(order.approvalStatus)) {
        throw Object.assign(new Error(`Sales Order cannot reserve backorder stock while approval is ${order.approvalStatus}.`), { status: 409 });
      }
      await reserveSalesOrderInventory(order, { session, actor: req.user._id, reason: 'Backorder reservation' });
    });
    return res.json({ success: true, message: 'Remaining backorder quantity is reserved and available for pick-list allocation.', data: order });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

router.post('/generate/:soId', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const pickListNumber = await generateBranchNumber(req.branchId, 'pickList', new Date());
    let pickList;
    await session.withTransaction(async () => {
      const so = await SalesOrder.findOne({ _id: req.params.soId, branch: req.branchId })
        .session(session)
        .populate('items.product', 'productCode itemName images hsnCode barcode')
        .populate('items.warehouse', 'name');
      if (!so) throw Object.assign(new Error('Sales Order not found.'), { status: 404 });
      if (!['confirmed', 'approved', 'processing', 'partial_dispatch'].includes(so.status)) {
        throw Object.assign(new Error(`Cannot generate pick list for "${so.status}" order.`), { status: 409 });
      }
      if (!['reserved', 'partial'].includes(so.reservationStatus)) {
        throw Object.assign(new Error('Sales Order has no active stock reservation to allocate.'), { status: 409 });
      }

      const requestedRows = Array.isArray(req.body.items) ? req.body.items : null;
      const requestedByLine = new Map();
      if (requestedRows) {
        for (const row of requestedRows) {
          const lineId = String(row.salesOrderItem || row.itemId || '');
          const quantity = Number(row.quantity ?? row.allocatedQty);
          if (!lineId || !Number.isFinite(quantity) || quantity <= 0 || requestedByLine.has(lineId)) {
            throw Object.assign(new Error('Each requested allocation needs one unique salesOrderItem and a positive quantity.'), { status: 422 });
          }
          requestedByLine.set(lineId, quantity);
        }
      }

      const items = [];
      for (const line of so.items) {
        const lineId = String(line._id);
        const availableToAllocate = Number(line.reservedQuantity || 0) - Number(line.allocatedQuantity || 0);
        const requestedQty = requestedRows ? requestedByLine.get(lineId) : availableToAllocate;
        if (requestedQty === undefined || requestedQty <= QUANTITY_TOLERANCE) continue;
        if (requestedQty - availableToAllocate > QUANTITY_TOLERANCE) {
          throw Object.assign(new Error(`${line.productName || line.productCode}: allocation exceeds the line's unallocated reservation.`), { status: 409 });
        }
        if (!line.warehouse) throw Object.assign(new Error(`Warehouse is required for ${line.productName || line.productCode}.`), { status: 409 });
        const product = line.product || {};
        items.push({
          salesOrderItem: line._id,
          product: product._id || line.product,
          productCode: line.productCode || product.productCode || '',
          productName: line.productName || product.itemName || '',
          productImage: line.productImage || product.images?.[0] || '',
          hsnCode: product.hsnCode || '',
          barcode: product.barcode || '',
          shade: line.shade || '',
          batch: line.batch || '',
          allocatedQty: requestedQty,
          requestedQty,
          unit: line.unit || 'Box',
          baseQuantity: requestedQty * Number(line.conversionFactor || 1),
          baseUnit: line.baseUnit || line.unit || 'Box',
          conversionFactor: Number(line.conversionFactor || 1),
          uomVersion: Number(line.uomVersion || 1),
          warehouse: line.warehouse?._id || line.warehouse,
          warehouseName: line.warehouse?.name || '',
          status: 'pending',
        });
        line.allocatedQuantity = Number(line.allocatedQuantity || 0) + requestedQty;
        refreshSalesOrderLine(line);
        requestedByLine.delete(lineId);
      }
      if (requestedByLine.size) throw Object.assign(new Error('One or more requested Sales Order items were not found.'), { status: 422 });
      if (!items.length) throw Object.assign(new Error('No unallocated reserved quantity remains for a new pick list.'), { status: 409 });

      [pickList] = await PickList.create([{
        pickListNumber,
        branch: so.branch,
        fulfillmentKey: `SO:${so._id}:${pickListNumber}`,
        salesOrder: so._id,
        orderNumber: so.orderNumber,
        dealerName: so.dealerName || so.customerName || '',
        dealerCode: so.dealerCode || '',
        items,
        priority: so.deliveryPriority || 'normal',
        deliveryAddress: so.deliveryAddress || '',
        totalItems: items.length,
        totalRequestedQty: items.reduce((sum, item) => sum + item.requestedQty, 0),
        stockReserved: true,
        reservationState: 'reserved',
        reservedAt: so.reservedAt || new Date(),
        createdBy: req.user._id,
      }], { session });
      if (so.status !== 'partial_dispatch') so.status = 'processing';
      await so.save({ session });
    });
    return res.status(201).json({ success: true, message: `Pick list ${pickListNumber} allocated from the Sales Order reservation.`, data: pickList });
  } catch (e) {
    const status = e.status || (e.code === 11000 ? 409 : ['CastError', 'ValidationError'].includes(e.name) ? 422 : 500);
    return res.status(status).json({ success: false, message: e.code === 11000 ? 'Pick-list generation conflicted with another request. Refresh and retry.' : e.message });
  } finally {
    await session.endSession();
  }
});

// Warehouse staff who can be assigned a pick list — active users in this branch
// whose permissions (or role defaults) include a picking/sorting/dispatch grant.
// Kept on pickListRoutes so it is reachable by warehouse supervisors (the /users
// API is gated behind users.manage, which floor supervisors do not hold).
router.get('/assignable-staff', async (req, res) => {
  try {
    const WAREHOUSE_PERMS = ['picking.management', 'sorting.management', 'dispatch.management'];
    const warehouseRoles = Object.entries(ROLE_DEFAULT_PERMISSIONS)
      .filter(([, perms]) => Array.isArray(perms) && (perms.includes('*') || perms.some(p => WAREHOUSE_PERMS.includes(p))))
      .map(([role]) => role);

    const users = await User.find({
      status: 'Active',
      assignedBranches: req.branchId,
      $or: [
        { permissions: { $in: [...WAREHOUSE_PERMS, '*'] } },
        { role: { $in: warehouseRoles } },
      ],
    })
      .select('name role')
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, data: users.map(u => ({ _id: u._id, name: u.name, role: u.role })) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Delivery executives for loading verification — active users with delivery_executive role.
// Kept on pickListRoutes so it is reachable by warehouse staff (the /users API is gated
// behind users.manage, which warehouse staff do not hold).
router.get('/delivery-executives', async (req, res) => {
  try {
    const users = await User.find({
      status: 'Active',
      role: 'delivery_executive',
      assignedBranches: req.branchId,
    })
      .select('name phone email')
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, data: users });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Available vehicles for loading verification — active vehicles.
// Kept on pickListRoutes so it is reachable by warehouse staff (the /masters/vehicles
// API is gated behind vehicle.master, which warehouse staff do not hold).
router.get('/available-vehicles', async (req, res) => {
  try {
    const vehicles = await Vehicle.find({
      isActive: true,
    })
      .select('vehicleNumber vehicleType driverName driverPhone')
      .sort({ vehicleNumber: 1 })
      .lean();

    res.json({ success: true, data: vehicles });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('assignedTo', 'name phone')
      .populate('sortedBy', 'name')
      .populate('packedBy', 'name')
      .populate('verifiedBy', 'name')
      .populate('loadingVerifiedBy', 'name')
      .populate('deliveryExecutive', 'name phone')
      .populate('salesOrder', 'orderNumber dealerName dealerCode orderDate')
      .populate('items.product', 'productCode itemName images')
      .lean();
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    res.json({ success: true, data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/assign', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (pickList.status === 'assigned') return res.json({ success: true, message: 'Picker already assigned.', data: pickList });
    if (pickList.status !== 'generated') return stateError(res, pickList, 'generated', 'assign picker');
    pickList.assignedTo = req.body.assignedTo || req.user._id;
    pickList.assignedToName = req.body.assignedToName || req.user.name || 'Self';
    pickList.assignedAt = new Date();
    pickList.status = 'assigned';
    await pickList.save();
    res.json({ success: true, message: 'Picker assigned.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/start', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (pickList.status === 'in_progress') return res.json({ success: true, message: 'Picking already started.', data: pickList });
    if (pickList.status !== 'assigned') return stateError(res, pickList, 'assigned', 'start picking');
    pickList.status = 'in_progress';
    pickList.pickingStartTime = new Date();
    await pickList.save();
    res.json({ success: true, message: 'Picking started.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/complete-picking', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let completed;
    await session.withTransaction(async () => {
      const current = await PickList.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw Object.assign(new Error('Pick list not found.'), { status: 404 });
      if (current.status === 'picked') { completed = current; return; }
      if (current.status !== 'in_progress') throw Object.assign(new Error(`Cannot complete picking while pick list is "${current.status}". Expected "in_progress".`), { status: 409 });
      const submitted = req.body.items;
      if (!Array.isArray(submitted) || submitted.length !== current.items.length) {
        throw Object.assign(new Error('Submit explicit verification for every pick-list item.'), { status: 400 });
      }
      const submittedById = new Map(submitted.map(item => [String(item._id), item]));
      if (submittedById.size !== current.items.length) throw Object.assign(new Error('Every pick-list item must appear exactly once.'), { status: 400 });

      const claimed = await PickList.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'in_progress', pickingCompletionProcessing: { $ne: true } },
        { $set: { pickingCompletionProcessing: true, reservationState: 'adjusting' } },
        { new: true, session }
      );
      if (!claimed) throw Object.assign(new Error('Picking completion is already being processed. Refresh before retrying.'), { status: 409 });
      const order = await SalesOrder.findOne({ _id: claimed.salesOrder, branch: req.branchId }).session(session);
      if (!order) throw Object.assign(new Error('Linked Sales Order not found.'), { status: 409 });

      for (const pickItem of claimed.items) {
        const submittedItem = submittedById.get(String(pickItem._id));
        if (!submittedItem) throw Object.assign(new Error(`Missing verification for ${pickItem.productName}.`), { status: 400 });
        const pickedQty = Number(submittedItem.pickedQty);
        const shortQty = Number(submittedItem.shortQty || 0);
        const damagedQty = Number(submittedItem.damagedQty || 0);
        if (![pickedQty, shortQty, damagedQty].every(value => Number.isFinite(value) && value >= 0)) {
          throw Object.assign(new Error(`Invalid quantities for ${pickItem.productName}.`), { status: 400 });
        }
        if (Math.abs(pickedQty + shortQty + damagedQty - pickItem.requestedQty) > QUANTITY_TOLERANCE) {
          throw Object.assign(new Error(`${pickItem.productName}: picked + short + damaged must equal requested quantity.`), { status: 400 });
        }
        if (submittedItem.barcodeVerified !== true || submittedItem.shadeConfirmed !== true || submittedItem.batchConfirmed !== true) {
          throw Object.assign(new Error(`Confirm barcode, shade, and batch for ${pickItem.productName}.`), { status: 400 });
        }
        const orderLine = order.items.id(pickItem.salesOrderItem);
        if (!orderLine) throw Object.assign(new Error(`Source Sales Order item is missing for ${pickItem.productName}.`), { status: 409 });
        const unfulfilled = shortQty + damagedQty;
        if (Number(orderLine.allocatedQuantity || 0) + QUANTITY_TOLERANCE < pickItem.requestedQty
            || Number(orderLine.reservedQuantity || 0) + QUANTITY_TOLERANCE < pickItem.requestedQty) {
          throw Object.assign(new Error(`Sales Order allocation changed for ${pickItem.productName}.`), { status: 409 });
        }

        for (const [type, quantity] of [['short', shortQty], ['damaged', damagedQty]]) {
          if (!(quantity > QUANTITY_TOLERANCE)) continue;
          const snapshot = stableUomSnapshot(pickItem);
          const baseQuantity = quantity * snapshot.conversionFactor;
          const quantityMove = type === 'short'
            ? { reservedQty: -baseQuantity, availableQty: baseQuantity }
            : { reservedQty: -baseQuantity, damagedQty: baseQuantity };
          await applyStockMovement({
            operationKey: stockOperationKey('pick-list', claimed._id, pickItem._id, type),
            correlationKey: stockOperationKey('pick-list', claimed._id, 'completion'),
            movementType: type === 'short' ? 'pick_short_release' : 'pick_damage',
            phase: type === 'short' ? 'released' : 'reclassified',
            branch: req.branchId, product: pickItem.product, warehouse: pickItem.warehouse,
            shade: pickItem.shade || '', batch: pickItem.batch || '', deltas: quantityMove,
            enteredQuantity: quantity, ...snapshot, baseQuantity,
            sourceType: 'PickList', sourceModel: 'PickList', sourceId: claimed._id, sourceLineId: pickItem._id,
            sourceNumber: claimed.pickListNumber, actor: req.user._id, occurredAt: new Date(),
            reason: type === 'short' ? 'Pick shortage reservation release' : 'Picking damage reclassification',
            remarks: submittedItem.remarks || '',
            metadata: { salesOrder: order._id, salesOrderItem: orderLine._id },
            guardMessage: `Reserved stock is inconsistent for ${pickItem.productName}.`,
          }, { session });
        }

        orderLine.allocatedQuantity = Math.max(0, Number(orderLine.allocatedQuantity || 0) - unfulfilled);
        orderLine.reservedQuantity = Math.max(0, Number(orderLine.reservedQuantity || 0) - unfulfilled);
        orderLine.pickedQuantity = Number(orderLine.pickedQuantity || 0) + pickedQty;
        orderLine.shortQuantity = Number(orderLine.shortQuantity || 0) + shortQty;
        orderLine.damagedQuantity = Number(orderLine.damagedQuantity || 0) + damagedQty;
        refreshSalesOrderLine(orderLine);

        pickItem.pickedQty = pickedQty;
        pickItem.shortQty = shortQty;
        pickItem.damagedQty = damagedQty;
        pickItem.barcodeVerified = true;
        pickItem.shadeConfirmed = true;
        pickItem.batchConfirmed = true;
        pickItem.status = damagedQty > 0 ? 'damaged' : shortQty > 0 ? 'short' : 'picked';
        pickItem.remarks = submittedItem.remarks || '';
      }

      order.reservationStatus = order.items.some(item => Number(item.reservedQuantity || 0) > QUANTITY_TOLERANCE) ? 'partial' : 'released';
      await order.save({ session });
      claimed.status = 'picked';
      claimed.pickingEndTime = new Date();
      claimed.reservationAdjustedAt = new Date();
      claimed.reservationState = 'adjusted';
      claimed.pickingCompletionProcessing = false;
      claimed.totalPickedQty = claimed.items.reduce((sum, item) => sum + Number(item.pickedQty || 0), 0);
      claimed.totalShortQty = claimed.items.reduce((sum, item) => sum + Number(item.shortQty || 0), 0);
      await claimed.save({ session });
      completed = claimed;
    });
    return res.json({ success: true, message: completed.status === 'picked' ? 'Picking completed with item-level verification.' : 'Picking already completed.', data: completed });
  } catch (e) {
    return res.status(e.status || (['CastError', 'ValidationError'].includes(e.name) ? 422 : 500)).json({ success: false, message: e.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/verify', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (pickList.status === 'verified') return res.json({ success: true, message: 'Pick list already verified.', data: pickList });
    if (pickList.status !== 'picked') return stateError(res, pickList, 'picked', 'verify pick list');
    const invalid = pickList.items.some(item =>
      !item.barcodeVerified || !item.shadeConfirmed || !item.batchConfirmed ||
      Math.abs(item.pickedQty + item.shortQty + item.damagedQty - item.requestedQty) > 0.0001
    );
    if (invalid) return res.status(409).json({ success: false, message: 'All item quantities and barcode/shade/batch checks must be complete.' });
    pickList.status = 'verified';
    pickList.verifiedBy = req.user._id;
    pickList.supervisorRemarks = req.body.remarks || '';
    await pickList.save();
    res.json({ success: true, message: 'Pick list verified.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Mark a single item short (quantity + optional reason). Usable while the pick
// list is being picked (in_progress) or sorted (verified). Evidence only — no
// stock is moved here; reservation reconciliation happens at complete-picking.
router.patch('/:id/mark-short', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (!['in_progress', 'picked', 'verified'].includes(pickList.status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot mark items short while pick list is "${pickList.status}".`,
      });
    }

    const { itemId, shortQty, reason } = req.body;
    const item = pickList.items.id(itemId);
    if (!item) return res.status(404).json({ success: false, message: 'Pick-list item not found.' });

    const qty = Number(shortQty);
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ success: false, message: 'Short quantity must be zero or a positive number.' });
    }
    const cap = Number(item.requestedQty || 0);
    if (qty > cap + QUANTITY_TOLERANCE) {
      return res.status(400).json({ success: false, message: `Short quantity cannot exceed the requested quantity (${cap}).` });
    }

    item.shortQty = qty;
    item.shortReason = String(reason || '');
    item.status = qty > QUANTITY_TOLERANCE ? 'short' : (Number(item.pickedQty || 0) > 0 ? 'picked' : 'pending');

    pickList.totalShortQty = pickList.items.reduce((sum, row) => sum + Number(row.shortQty || 0), 0);
    await pickList.save();
    res.json({
      success: true,
      message: qty > QUANTITY_TOLERANCE ? `Shortage recorded for ${item.productName}.` : `Shortage cleared for ${item.productName}.`,
      data: pickList,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/sort', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let sorted;
    await session.withTransaction(async () => {
      const current = await PickList.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw Object.assign(new Error('Pick list not found.'), { status: 404 });
      if (current.status === 'sorted' && current.sortingPostedAt) { sorted = current; return; }
      if (current.sortingPostedAt) throw Object.assign(new Error('Posted sorting reconciliation is immutable and cannot be edited.'), { status: 409 });
      if (current.status !== 'verified') throw Object.assign(new Error(`Cannot complete sorting while pick list is "${current.status}". Expected "verified".`), { status: 409 });
      const submitted = req.body.items;
      if (!Array.isArray(submitted) || submitted.length !== current.items.length) {
        throw Object.assign(new Error('Submit explicit sorting verification for every pick-list item.'), { status: 400 });
      }
      const submittedById = new Map(submitted.map(item => [String(item._id), item]));
      if (submittedById.size !== current.items.length) throw Object.assign(new Error('Every pick-list item must appear exactly once.'), { status: 400 });
      const claimed = await PickList.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'verified', sortingVerificationProcessing: { $ne: true } },
        { $set: { sortingVerificationProcessing: true, sortingStartTime: current.sortingStartTime || new Date() } },
        { new: true, session }
      );
      if (!claimed) throw Object.assign(new Error('Sorting verification is already being processed. Refresh before retrying.'), { status: 409 });
      const order = await SalesOrder.findOne({ _id: claimed.salesOrder, branch: req.branchId }).session(session);
      if (!order) throw Object.assign(new Error('Linked Sales Order not found.'), { status: 409 });
      const sortingVersion = Number(claimed.sortingVersion || 0) + 1;

      const verifiedAt = new Date();
      for (const item of claimed.items) {
        const evidence = submittedById.get(String(item._id));
        if (!evidence) throw Object.assign(new Error(`Missing sorting verification for ${item.productName}.`), { status: 400 });
        const sortedQty = Number(evidence.sortedQty);
        const sortingShortQty = Number(evidence.shortQty || 0);
        const sortingDamagedQty = Number(evidence.damagedQty || 0);
        if (![sortedQty, sortingShortQty, sortingDamagedQty].every(value => Number.isFinite(value) && value >= 0)) {
          throw Object.assign(new Error(`Invalid sorting quantities for ${item.productName}.`), { status: 400 });
        }
        if (Math.abs(sortedQty + sortingShortQty + sortingDamagedQty - Number(item.pickedQty || 0)) > QUANTITY_TOLERANCE) {
          throw Object.assign(new Error(`${item.productName}: sorted + short + damaged must equal the picked quantity.`), { status: 400 });
        }
        if (evidence.barcodeConfirmed !== true || evidence.shadeConfirmed !== true || evidence.batchConfirmed !== true) {
          throw Object.assign(new Error(`Confirm barcode, shade, and batch for ${item.productName}.`), { status: 400 });
        }
        const discrepancy = sortingShortQty + sortingDamagedQty;
        const discrepancyReason = String(evidence.remarks || req.body.reason || req.body.remarks || '').trim();
        if (discrepancy > QUANTITY_TOLERANCE && !discrepancyReason) {
          throw Object.assign(new Error(`A reason is required for sorting discrepancies on ${item.productName}.`), { status: 422 });
        }
        const orderLine = order.items.id(item.salesOrderItem);
        if (!orderLine) throw Object.assign(new Error(`Source Sales Order item is missing for ${item.productName}.`), { status: 409 });
        if (Number(orderLine.reservedQuantity || 0) + QUANTITY_TOLERANCE < discrepancy
            || Number(orderLine.allocatedQuantity || 0) + QUANTITY_TOLERANCE < discrepancy) {
          throw Object.assign(new Error(`Sales Order reservation changed for ${item.productName}.`), { status: 409 });
        }
        const snapshot = stableUomSnapshot(item);
        if (sortingShortQty > QUANTITY_TOLERANCE) {
          const baseQuantity = sortingShortQty * snapshot.conversionFactor;
          const result = await applyStockMovement({
            operationKey: stockOperationKey('pick-list', claimed._id, item._id, 'sorting-short', sortingVersion),
            correlationKey: stockOperationKey('pick-list', claimed._id, 'sorting', sortingVersion),
            movementType: 'sorting_short', phase: 'reclassified',
            branch: req.branchId, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '',
            deltas: { reservedQty: -baseQuantity, totalQty: -baseQuantity, shortQty: baseQuantity },
            enteredQuantity: sortingShortQty, ...snapshot, baseQuantity,
            sourceType: 'PickList', sourceModel: 'PickList', sourceId: claimed._id, sourceLineId: item._id,
            sourceNumber: claimed.pickListNumber, actor: req.user._id, occurredAt: verifiedAt,
            reason: discrepancyReason, metadata: { sortingVersion, salesOrder: order._id, salesOrderItem: orderLine._id },
            guardMessage: `Reserved stock is inconsistent for sorting shortage on ${item.productName}.`,
          }, { session });
          item.sortingShortMovement = result.movement._id;
        }
        if (sortingDamagedQty > QUANTITY_TOLERANCE) {
          const baseQuantity = sortingDamagedQty * snapshot.conversionFactor;
          const result = await applyStockMovement({
            operationKey: stockOperationKey('pick-list', claimed._id, item._id, 'sorting-damage', sortingVersion),
            correlationKey: stockOperationKey('pick-list', claimed._id, 'sorting', sortingVersion),
            movementType: 'sorting_damage', phase: 'reclassified',
            branch: req.branchId, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '',
            deltas: { reservedQty: -baseQuantity, damagedQty: baseQuantity },
            enteredQuantity: sortingDamagedQty, ...snapshot, baseQuantity,
            sourceType: 'PickList', sourceModel: 'PickList', sourceId: claimed._id, sourceLineId: item._id,
            sourceNumber: claimed.pickListNumber, actor: req.user._id, occurredAt: verifiedAt,
            reason: discrepancyReason, metadata: { sortingVersion, salesOrder: order._id, salesOrderItem: orderLine._id },
            guardMessage: `Reserved stock is inconsistent for sorting damage on ${item.productName}.`,
          }, { session });
          item.sortingDamageMovement = result.movement._id;
        }
        orderLine.reservedQuantity = Math.max(0, Number(orderLine.reservedQuantity || 0) - discrepancy);
        orderLine.allocatedQuantity = Math.max(0, Number(orderLine.allocatedQuantity || 0) - discrepancy);
        orderLine.shortQuantity = Number(orderLine.shortQuantity || 0) + sortingShortQty;
        orderLine.damagedQuantity = Number(orderLine.damagedQuantity || 0) + sortingDamagedQty;
        refreshSalesOrderLine(orderLine);
        item.sortedQty = sortedQty;
        item.sortingShortQty = sortingShortQty;
        item.sortingDamagedQty = sortingDamagedQty;
        item.sortingBarcodeConfirmed = true;
        item.sortingShadeConfirmed = true;
        item.sortingBatchConfirmed = true;
        item.sortingRemarks = String(evidence.remarks || '');
        item.sortingVerifiedBy = req.user._id;
        item.sortingVerifiedAt = verifiedAt;
        item.sortingVersion = sortingVersion;
        item.sortingPostedAt = verifiedAt;
        item.sortingPostedBy = req.user._id;
        item.sortingReason = discrepancyReason;
        item.sortingDiscrepancyResolved = true;
      }
      order.reservationStatus = order.items.some(item => Number(item.reservedQuantity || 0) > QUANTITY_TOLERANCE) ? 'partial' : 'released';
      await order.save({ session });
      claimed.status = 'sorted';
      claimed.sortedBy = req.user._id;
      claimed.sortingEndTime = verifiedAt;
      claimed.sortingVersion = sortingVersion;
      claimed.sortingPostedAt = verifiedAt;
      claimed.sortingPostedBy = req.user._id;
      claimed.sortingReason = String(req.body.reason || req.body.remarks || '').trim();
      claimed.deliveryRoute = req.body.deliveryRoute ?? claimed.deliveryRoute;
      claimed.remarks = req.body.remarks ?? claimed.remarks;
      claimed.sortingVerificationProcessing = false;
      await claimed.save({ session });
      sorted = claimed;
    });
    return res.json({
      success: true,
      message: sorted.sortingPostedAt
        ? 'Sorting posted. Short stock was removed from reserved/total; damaged stock was moved from reserved to damaged.'
        : 'Sorting already posted.',
      data: sorted,
    });
  } catch (e) {
    return res.status(e.status || (['CastError', 'ValidationError'].includes(e.name) ? 422 : 500)).json({ success: false, message: e.message });
  } finally { await session.endSession(); }
});

router.patch('/:id/pack', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (pickList.status === 'packed') return res.json({ success: true, message: 'Pick list already packed.', data: pickList });
    if (pickList.status !== 'sorted') return stateError(res, pickList, 'sorted', 'pack pick list');
    const totalBoxes = Number(req.body.totalBoxes);
    const totalWeight = Number(req.body.totalWeight || 0);
    if (!Number.isFinite(totalBoxes) || totalBoxes <= 0 || !Number.isFinite(totalWeight) || totalWeight < 0) {
      return res.status(400).json({ success: false, message: 'Total boxes must be greater than zero and weight cannot be negative.' });
    }

    // Item-wise packing (optional). When an items array is supplied, record the
    // packed quantity per item — it must equal that item's dispatchable quantity
    // (sortedQty when sorted, else pickedQty). When omitted, the whole list packs
    // its dispatchable quantity per item (backward compatible with older clients).
    const submitted = Array.isArray(req.body.items) ? req.body.items : null;
    const dispatchableOf = (item) =>
      Number(item.sortedQty || 0) > 0 ? Number(item.sortedQty) : Number(item.pickedQty || 0);

    if (submitted) {
      if (submitted.length !== pickList.items.length) {
        return res.status(400).json({ success: false, message: 'Submit a packed quantity for every item.' });
      }
      const byId = new Map(submitted.map((row) => [String(row._id), row]));
      if (byId.size !== pickList.items.length) {
        return res.status(400).json({ success: false, message: 'Every item must appear exactly once.' });
      }
      for (const item of pickList.items) {
        const row = byId.get(String(item._id));
        if (!row) return res.status(400).json({ success: false, message: `Missing packed quantity for ${item.productName}.` });
        const packedQty = Number(row.packedQty);
        const expected = dispatchableOf(item);
        if (!Number.isFinite(packedQty) || packedQty < 0) {
          return res.status(400).json({ success: false, message: `Invalid packed quantity for ${item.productName}.` });
        }
        if (Math.abs(packedQty - expected) > QUANTITY_TOLERANCE) {
          return res.status(400).json({ success: false, message: `${item.productName}: packed quantity must equal the sorted/picked quantity (${expected}).` });
        }
        item.packedQty = packedQty;
      }
    } else {
      // No per-item data — pack each item's dispatchable quantity.
      pickList.items.forEach((item) => { item.packedQty = dispatchableOf(item); });
    }

    pickList.status = 'packed';
    pickList.packedBy = req.user._id;
    pickList.packingEndTime = new Date();
    pickList.totalBoxes = totalBoxes;
    pickList.totalWeight = totalWeight;
    pickList.deliveryRoute = req.body.deliveryRoute ?? pickList.deliveryRoute;
    await pickList.save();
    res.json({ success: true, message: 'Packing completed.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/ready', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (pickList.status === 'ready_for_dispatch') return res.json({ success: true, message: 'Pick list already ready for dispatch.', data: pickList });
    if (pickList.status !== 'packed') return stateError(res, pickList, 'packed', 'mark ready for dispatch');
    if (!(pickList.totalBoxes > 0)) return res.status(409).json({ success: false, message: 'Pack and record total boxes before dispatch.' });
    pickList.status = 'ready_for_dispatch';
    await pickList.save();
    res.json({ success: true, message: 'Ready for dispatch planning.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Loading verification — confirms every item is physically loaded onto the
// delivery vehicle by scanning its barcode. Evidence only: no stock is moved
// here (dispatch consumption happens on the DispatchTrip). ready_for_dispatch → loaded.
router.patch('/:id/verify-loading', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let loaded;
    await session.withTransaction(async () => {
      const current = await PickList.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw Object.assign(new Error('Pick list not found.'), { status: 404 });
      if (current.status === 'loaded') { loaded = current; return; }
      if (current.status !== 'ready_for_dispatch') {
        throw Object.assign(new Error(`Cannot verify loading while pick list is "${current.status}". Expected "ready_for_dispatch".`), { status: 409 });
      }
      const submitted = req.body.items;
      if (!Array.isArray(submitted) || submitted.length !== current.items.length) {
        throw Object.assign(new Error('Submit explicit loading verification for every pick-list item.'), { status: 400 });
      }
      const submittedById = new Map(submitted.map(item => [String(item._id), item]));
      if (submittedById.size !== current.items.length) throw Object.assign(new Error('Every pick-list item must appear exactly once.'), { status: 400 });

      const claimed = await PickList.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'ready_for_dispatch', loadingVerificationProcessing: { $ne: true } },
        { $set: { loadingVerificationProcessing: true } },
        { new: true, session }
      );
      if (!claimed) throw Object.assign(new Error('Loading verification is already being processed. Refresh before retrying.'), { status: 409 });

      const verifiedAt = new Date();
      for (const item of claimed.items) {
        const evidence = submittedById.get(String(item._id));
        if (!evidence) throw Object.assign(new Error(`Missing loading verification for ${item.productName}.`), { status: 400 });
        // The dispatchable quantity is what survived sorting (sortedQty when sorted,
        // otherwise the picked quantity). Loading confirms this whole quantity is on the vehicle.
        const dispatchableQty = Number(item.sortedQty || 0) > 0 ? Number(item.sortedQty) : Number(item.pickedQty || 0);
        const dispatchedQty = Number(evidence.dispatchedQty ?? dispatchableQty);
        if (!Number.isFinite(dispatchedQty) || dispatchedQty < 0) {
          throw Object.assign(new Error(`Invalid loaded quantity for ${item.productName}.`), { status: 400 });
        }
        if (Math.abs(dispatchedQty - dispatchableQty) > QUANTITY_TOLERANCE) {
          throw Object.assign(new Error(`${item.productName}: loaded quantity must equal the dispatchable quantity (${dispatchableQty}).`), { status: 400 });
        }
        if (evidence.barcodeConfirmed !== true) {
          throw Object.assign(new Error(`Scan and confirm the barcode for ${item.productName} before loading.`), { status: 400 });
        }
        item.dispatchedQty = dispatchedQty;
        item.loadingBarcodeConfirmed = true;
        item.loadingRemarks = String(evidence.remarks || '');
        item.loadingVerifiedBy = req.user._id;
        item.loadingVerifiedAt = verifiedAt;
      }

      claimed.status = 'loaded';
      claimed.loadingVerifiedBy = req.user._id;
      claimed.loadingEndTime = verifiedAt;
      claimed.remarks = req.body.remarks ?? claimed.remarks;
      
      // Save driver & vehicle details if provided
      if (req.body.deliveryExecutive) claimed.deliveryExecutive = req.body.deliveryExecutive;
      if (req.body.vehicleNumber) claimed.vehicleNumber = req.body.vehicleNumber;
      if (req.body.vehicleType) claimed.vehicleType = req.body.vehicleType;
      if (req.body.driverName) claimed.driverName = req.body.driverName;
      if (req.body.driverPhone) claimed.driverPhone = req.body.driverPhone;
      
      claimed.loadingVerificationProcessing = false;
      await claimed.save({ session });

      // Propagate driver/vehicle selection to the linked DispatchTrip so that
      // when the trip is dispatched the Delivery document inherits the correct
      // deliveryExecutive. This is the source that deliveryRoutes reads for
      // role-based filtering — without this the driver cannot see their deliveries.
      if (claimed.dispatchTrip && (req.body.deliveryExecutive || req.body.vehicleNumber)) {
        const tripUpdate = {};
        if (req.body.deliveryExecutive) {
          tripUpdate.deliveryExecutive = req.body.deliveryExecutive;
          // Resolve the name so the denormalised field stays consistent
          const deUser = await User.findById(req.body.deliveryExecutive)
            .select('name')
            .session(session)
            .lean();
          tripUpdate.deliveryExecutiveName = deUser?.name || req.body.driverName || '';
        }
        if (req.body.vehicleNumber) tripUpdate.vehicleNumber = req.body.vehicleNumber;
        if (req.body.vehicleType)   tripUpdate.vehicleType   = req.body.vehicleType;
        if (req.body.driverName)    tripUpdate.driverName    = req.body.driverName;
        if (req.body.driverPhone)   tripUpdate.driverPhone   = req.body.driverPhone;
        await DispatchTrip.updateOne(
          { _id: claimed.dispatchTrip, branch: req.branchId },
          { $set: tripUpdate },
          { session }
        );

        // If the trip was already dispatched before loading verification ran
        // (edge case: re-entry after partial dispatch), update the Delivery
        // document directly so the driver's role-based filter works immediately
        // without waiting for a re-dispatch.
        if (tripUpdate.deliveryExecutive) {
          const deliveryUpdate = {
            deliveryExecutive: tripUpdate.deliveryExecutive,
            deliveryExecutiveName: tripUpdate.deliveryExecutiveName || '',
          };
          if (tripUpdate.vehicleNumber) deliveryUpdate.vehicleNumber = tripUpdate.vehicleNumber;
          if (tripUpdate.vehicleType)   deliveryUpdate.vehicleType   = tripUpdate.vehicleType;
          if (tripUpdate.driverName)    deliveryUpdate.driverName    = tripUpdate.driverName;
          if (tripUpdate.driverPhone)   deliveryUpdate.driverPhone   = tripUpdate.driverPhone;
          await Delivery.updateMany(
            {
              branch: req.branchId,
              dispatchTrip: claimed.dispatchTrip,
              // Only update deliveries that haven't been completed yet
              status: { $nin: ['delivered', 'partially_delivered', 'failed'] },
            },
            { $set: deliveryUpdate },
            { session }
          );
        }
      }

      loaded = claimed;
    });
    return res.json({
      success: true,
      message: loaded.status === 'loaded' ? 'Loading verified — every item scanned and confirmed on the vehicle.' : 'Loading already verified.',
      data: loaded,
    });
  } catch (e) {
    return res.status(e.status || (['CastError', 'ValidationError'].includes(e.name) ? 422 : 500)).json({ success: false, message: e.message });
  } finally {
    await session.endSession();
  }
});

export default router;
