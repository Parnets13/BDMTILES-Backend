import { Router } from 'express';
import PickList from '../models/PickList.js';
import SalesOrder from '../models/SalesOrder.js';
import Stock from '../models/Stock.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

router.get(['/', '/stats', '/:id'], requireAnyPermission('picking.management', 'sorting.management', 'dispatch.management'));
router.post('/generate/:soId', requireAnyPermission('sales.order.approve', 'picking.management'));
router.patch(
  ['/:id/assign', '/:id/start', '/:id/complete-picking', '/:id/verify'],
  requirePermission('picking.management')
);
router.patch(['/:id/sort', '/:id/pack'], requirePermission('sorting.management'));
router.patch('/:id/ready', requireAnyPermission('sorting.management', 'dispatch.management'));

const stockKey = item => [
  item.product?._id || item.product,
  item.warehouse?._id || item.warehouse,
  item.shade || '',
  item.batch || '',
].map(String).join('|');

const aggregateItems = (items, quantitySelector, branch) => {
  const requirements = new Map();
  for (const item of items) {
    const quantity = Number(quantitySelector(item));
    if (!(quantity > 0)) continue;
    if (!item.product || !item.warehouse) {
      throw new Error(`Warehouse is required for ${item.productName || item.productCode || 'every item'}.`);
    }
    const key = stockKey(item);
    const current = requirements.get(key);
    if (current) current.quantity += quantity;
    else requirements.set(key, {
      branch,
      product: item.product?._id || item.product,
      warehouse: item.warehouse?._id || item.warehouse,
      shade: item.shade || '',
      batch: item.batch || '',
      productName: item.productName || item.productCode || 'item',
      quantity,
    });
  }
  return [...requirements.values()];
};

const rollbackReservation = async changes => {
  for (const change of [...changes].reverse()) {
    await Stock.updateOne(
      { branch: change.branch, product: change.product, warehouse: change.warehouse, shade: change.shade, batch: change.batch },
      { $inc: { availableQty: change.quantity, reservedQty: -change.quantity } }
    );
  }
};

const reserveStock = async (items, branch) => {
  const applied = [];
  try {
    for (const requirement of aggregateItems(items, item => item.quantity, branch)) {
      const stock = await Stock.findOneAndUpdate(
        {
          branch: requirement.branch,
          product: requirement.product,
          warehouse: requirement.warehouse,
          shade: requirement.shade,
          batch: requirement.batch,
          availableQty: { $gte: requirement.quantity },
        },
        { $inc: { availableQty: -requirement.quantity, reservedQty: requirement.quantity } },
        { new: true }
      );
      if (!stock) {
        throw new Error(`Insufficient available stock for ${requirement.productName} (shade ${requirement.shade || 'default'}, batch ${requirement.batch || 'default'}).`);
      }
      applied.push(requirement);
    }
    return applied;
  } catch (error) {
    await rollbackReservation(applied);
    throw error;
  }
};

const releaseReservation = async (pickList, updatedItems) => {
  if (!pickList.stockReserved) return [];
  const requirements = new Map();
  for (const item of updatedItems) {
    for (const [type, quantity] of [['short', Number(item.shortQty)], ['damaged', Number(item.damagedQty)]]) {
      if (!(quantity > 0)) continue;
      const key = `${stockKey(item)}|${type}`;
      const existing = requirements.get(key);
      if (existing) existing.quantity += quantity;
      else requirements.set(key, {
        branch: pickList.branch,
        product: item.product?._id || item.product,
        warehouse: item.warehouse?._id || item.warehouse,
        shade: item.shade || '',
        batch: item.batch || '',
        productName: item.productName || item.productCode || 'item',
        quantity,
        type,
      });
    }
  }

  const applied = [];
  try {
    for (const requirement of requirements.values()) {
      const quantityMove = requirement.type === 'short'
        ? { reservedQty: -requirement.quantity, availableQty: requirement.quantity }
        : { reservedQty: -requirement.quantity, damagedQty: requirement.quantity };
      const stock = await Stock.findOneAndUpdate(
        {
          branch: requirement.branch,
          product: requirement.product,
          warehouse: requirement.warehouse,
          shade: requirement.shade,
          batch: requirement.batch,
          reservedQty: { $gte: requirement.quantity },
        },
        { $inc: quantityMove },
        { new: true }
      );
      if (!stock) throw new Error(`Reserved stock is inconsistent for ${requirement.productName}.`);
      applied.push(requirement);
    }
    return applied;
  } catch (error) {
    await rollbackReleasedReservation(applied);
    throw error;
  }
};

const rollbackReleasedReservation = async changes => {
  for (const change of [...changes].reverse()) {
    const quantityMove = change.type === 'short'
      ? { reservedQty: change.quantity, availableQty: -change.quantity }
      : { reservedQty: change.quantity, damagedQty: -change.quantity };
    await Stock.updateOne(
      { branch: change.branch, product: change.product, warehouse: change.warehouse, shade: change.shade, batch: change.batch },
      { $inc: quantityMove }
    );
  }
};

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
    const statuses = ['generated', 'assigned', 'in_progress', 'picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch'];
    const [total, ...counts] = await Promise.all([
      PickList.countDocuments({ branch: req.branchId }),
      ...statuses.map(status => PickList.countDocuments({ branch: req.branchId, status })),
    ]);
    const data = { total };
    statuses.forEach((status, index) => { data[status === 'in_progress' ? 'inProgress' : status === 'ready_for_dispatch' ? 'ready' : status] = counts[index]; });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/generate/:soId', async (req, res) => {
  let reservation = [];
  let pickList = null;
  try {
    const so = await SalesOrder.findOne({ _id: req.params.soId, branch: req.branchId })
      .populate('items.product', 'productCode itemName images hsnCode')
      .populate('items.warehouse', 'name')
      .lean();
    if (!so) return res.status(404).json({ success: false, message: 'Sales Order not found.' });
    if (!['confirmed', 'approved', 'processing'].includes(so.status)) {
      return res.status(409).json({ success: false, message: `Cannot generate pick list for "${so.status}" order.` });
    }

    const existing = await PickList.findOne({ branch: req.branchId, $or: [{ fulfillmentKey: `SO:${so._id}` }, { salesOrder: so._id }] }).lean();
    if (existing) return res.status(409).json({ success: false, message: `Pick list ${existing.pickListNumber} already exists for this order.` });

    const pickListNumber = await generateBranchNumber(req.branchId, 'pickList', new Date());
    const items = so.items.map(item => {
      const product = item.product || {};
      return {
        product: product._id || item.product,
        productCode: item.productCode || product.productCode || '',
        productName: item.productName || product.itemName || '',
        productImage: item.productImage || product.images?.[0] || '',
        hsnCode: product.hsnCode || '',
        shade: item.shade || '',
        batch: item.batch || '',
        requestedQty: item.quantity,
        unit: item.unit || 'Box',
        warehouse: item.warehouse?._id || item.warehouse,
        warehouseName: item.warehouse?.name || '',
        status: 'pending',
      };
    });

    // The unique fulfillment key claims this Sales Order before any stock is moved.
    pickList = await PickList.create({
      pickListNumber,
      branch: so.branch,
      fulfillmentKey: `SO:${so._id}`,
      salesOrder: so._id,
      orderNumber: so.orderNumber,
      dealerName: so.dealerName || so.customerName || '',
      dealerCode: so.dealerCode || '',
      items,
      priority: so.deliveryPriority || 'normal',
      deliveryAddress: so.deliveryAddress || '',
      totalItems: items.length,
      totalRequestedQty: items.reduce((sum, item) => sum + item.requestedQty, 0),
      reservationState: 'pending',
      createdBy: req.user._id,
    });

    reservation = await reserveStock(so.items, so.branch);
    pickList.stockReserved = true;
    pickList.reservationState = 'reserved';
    pickList.reservedAt = new Date();
    await pickList.save();
    await SalesOrder.findOneAndUpdate({ _id: so._id, branch: req.branchId }, { status: 'processing' });
    res.status(201).json({ success: true, message: `Pick list ${pickListNumber} generated and stock reserved.`, data: pickList });
  } catch (e) {
    if (reservation.length) await rollbackReservation(reservation);
    if (pickList?._id) await PickList.deleteOne({ _id: pickList._id, stockConsumedAt: null });
    if (e.code === 11000) {
      const existing = await PickList.findOne({ branch: req.branchId, fulfillmentKey: `SO:${req.params.soId}` }).lean();
      return res.status(409).json({ success: false, message: existing ? `Pick list ${existing.pickListNumber} already exists for this order.` : 'Pick-list generation conflicted with another request. Refresh and retry.' });
    }
    res.status(e.message.startsWith('Insufficient') || e.message.includes('Warehouse') ? 409 : 500).json({ success: false, message: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('assignedTo', 'name phone')
      .populate('sortedBy', 'name')
      .populate('packedBy', 'name')
      .populate('verifiedBy', 'name')
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
  let released = [];
  let claimedPickList = null;
  try {
    const current = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (current.status === 'picked') return res.json({ success: true, message: 'Picking already completed.', data: current });
    if (current.status !== 'in_progress') return stateError(res, current, 'in_progress', 'complete picking');

    const submitted = req.body.items;
    if (!Array.isArray(submitted) || submitted.length !== current.items.length) {
      return res.status(400).json({ success: false, message: 'Submit explicit verification for every pick-list item.' });
    }
    const submittedById = new Map(submitted.map(item => [String(item._id), item]));
    if (submittedById.size !== current.items.length) {
      return res.status(400).json({ success: false, message: 'Every pick-list item must appear exactly once.' });
    }

    const updates = [];
    for (const existing of current.items) {
      const item = submittedById.get(String(existing._id));
      if (!item) return res.status(400).json({ success: false, message: `Missing verification for ${existing.productName}.` });
      const pickedQty = Number(item.pickedQty);
      const shortQty = Number(item.shortQty || 0);
      const damagedQty = Number(item.damagedQty || 0);
      if (![pickedQty, shortQty, damagedQty].every(value => Number.isFinite(value) && value >= 0)) {
        return res.status(400).json({ success: false, message: `Invalid quantities for ${existing.productName}.` });
      }
      if (Math.abs(pickedQty + shortQty + damagedQty - existing.requestedQty) > 0.0001) {
        return res.status(400).json({ success: false, message: `${existing.productName}: picked + short + damaged must equal requested quantity.` });
      }
      if (item.barcodeVerified !== true || item.shadeConfirmed !== true || item.batchConfirmed !== true) {
        return res.status(400).json({ success: false, message: `Confirm barcode, shade, and batch for ${existing.productName}.` });
      }
      updates.push({
        _id: existing._id,
        product: existing.product,
        productName: existing.productName,
        productCode: existing.productCode,
        warehouse: existing.warehouse,
        shade: existing.shade,
        batch: existing.batch,
        requestedQty: existing.requestedQty,
        pickedQty,
        shortQty,
        damagedQty,
        remarks: item.remarks || '',
      });
    }

    claimedPickList = await PickList.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, status: 'in_progress', pickingCompletionProcessing: { $ne: true } },
      { $set: { pickingCompletionProcessing: true, reservationState: current.stockReserved ? 'adjusting' : current.reservationState } },
      { new: true }
    );
    if (!claimedPickList) return res.status(409).json({ success: false, message: 'Picking completion is already being processed. Refresh before retrying.' });

    released = await releaseReservation(claimedPickList, updates);
    for (const update of updates) {
      const existing = claimedPickList.items.id(update._id);
      existing.pickedQty = update.pickedQty;
      existing.shortQty = update.shortQty;
      existing.damagedQty = update.damagedQty;
      existing.barcodeVerified = true;
      existing.shadeConfirmed = true;
      existing.batchConfirmed = true;
      existing.status = update.damagedQty > 0 ? 'damaged' : update.shortQty > 0 ? 'short' : 'picked';
      existing.remarks = update.remarks;
    }
    claimedPickList.status = 'picked';
    claimedPickList.pickingEndTime = new Date();
    claimedPickList.reservationAdjustedAt = claimedPickList.stockReserved ? new Date() : undefined;
    claimedPickList.reservationState = claimedPickList.stockReserved ? 'adjusted' : claimedPickList.reservationState;
    claimedPickList.pickingCompletionProcessing = false;
    claimedPickList.totalPickedQty = claimedPickList.items.reduce((sum, item) => sum + item.pickedQty, 0);
    claimedPickList.totalShortQty = claimedPickList.items.reduce((sum, item) => sum + item.shortQty, 0);
    await claimedPickList.save();
    res.json({ success: true, message: 'Picking completed with item-level verification.', data: claimedPickList });
  } catch (e) {
    if (released.length) await rollbackReleasedReservation(released);
    if (claimedPickList?._id) {
      await PickList.updateOne(
        { _id: claimedPickList._id, branch: req.branchId, status: 'in_progress' },
        { $set: { pickingCompletionProcessing: false, reservationState: claimedPickList.stockReserved ? 'reserved' : claimedPickList.reservationState } }
      );
    }
    res.status(e.message.includes('Reserved stock') ? 409 : 500).json({ success: false, message: e.message });
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

router.patch('/:id/sort', async (req, res) => {
  try {
    const pickList = await PickList.findOne({ _id: req.params.id, branch: req.branchId });
    if (!pickList) return res.status(404).json({ success: false, message: 'Pick list not found.' });
    if (pickList.status === 'sorted') return res.json({ success: true, message: 'Pick list already sorted.', data: pickList });
    if (pickList.status !== 'verified') return stateError(res, pickList, 'verified', 'complete sorting');
    pickList.status = 'sorted';
    pickList.sortedBy = req.user._id;
    pickList.sortingStartTime = pickList.sortingStartTime || new Date();
    pickList.sortingEndTime = new Date();
    pickList.deliveryRoute = req.body.deliveryRoute ?? pickList.deliveryRoute;
    pickList.remarks = req.body.remarks ?? pickList.remarks;
    await pickList.save();
    res.json({ success: true, message: 'Sorting completed.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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

export default router;
