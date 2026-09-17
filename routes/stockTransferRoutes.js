import { Router } from 'express';
import mongoose from 'mongoose';
import StockTransfer from '../models/StockTransfer.js';
import Stock from '../models/Stock.js';
import Product from '../models/Product.js';
import Warehouse from '../models/Warehouse.js';
import { applyStockMovement, stockOperationKey } from '../services/stockMovementService.js';
import { resolveStockUom, stableUomSnapshot } from '../services/stockUomService.js';
import Branch from '../models/Branch.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);
router.use(requirePermission('stock.transfer'));

const routeError = (status, message) => Object.assign(new Error(message), { status });
const stockKey = (branch, product, warehouse, shade, batch) =>
  `${String(branch)}|${String(product)}|${String(warehouse)}|${shade || ''}|${batch || ''}`;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/destinations', async (req, res) => {
  try {
    const activeBranchIds = await Branch.find({ status: 'active' }).distinct('_id');
    const warehouses = await Warehouse.find({ branch: { $in: activeBranchIds }, status: 'active' })
      .select('warehouseCode name branch city')
      .populate('branch', 'branchCode name status')
      .sort({ name: 1 })
      .lean();
    return res.json({ success: true, data: warehouses.filter((warehouse) => warehouse.branch?.status === 'active') });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, fromWarehouse, toWarehouse } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Number.parseInt(limit, 10) || 20);
    const branchScope = { $or: [{ sourceBranch: req.branchId }, { destinationBranch: req.branchId }] };
    const clauses = [branchScope];
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      clauses.push({ $or: [{ transferNumber: regex }, { fromWarehouseName: regex }, { toWarehouseName: regex }] });
    }
    const filter = clauses.length > 1 ? { $and: clauses } : branchScope;
    if (status) filter.status = status;
    if (fromWarehouse) filter.fromWarehouse = fromWarehouse;
    if (toWarehouse) filter.toWarehouse = toWarehouse;

    const [transfers, total] = await Promise.all([
      StockTransfer.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('fromWarehouse', 'name')
        .populate('toWarehouse', 'name')
        .populate('requestedBy', 'name')
        .populate('approvedBy', 'name')
        .lean(),
      StockTransfer.countDocuments(filter),
    ]);
    return res.json({ success: true, data: transfers, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const scope = { $or: [{ sourceBranch: req.branchId }, { destinationBranch: req.branchId }] };
    const [total, requested, approved, dispatched, inTransit, received, completed, rejected, cancelled] = await Promise.all([
      StockTransfer.countDocuments(scope),
      StockTransfer.countDocuments({ ...scope, status: 'requested' }),
      StockTransfer.countDocuments({ ...scope, status: 'approved' }),
      StockTransfer.countDocuments({ ...scope, status: 'dispatched' }),
      StockTransfer.countDocuments({ ...scope, status: 'in_transit' }),
      StockTransfer.countDocuments({ ...scope, status: 'received' }),
      StockTransfer.countDocuments({ ...scope, status: 'completed' }),
      StockTransfer.countDocuments({ ...scope, status: 'rejected' }),
      StockTransfer.countDocuments({ ...scope, status: 'cancelled' }),
    ]);
    return res.json({ success: true, data: { total, requested, approved, dispatched, inTransit, received, completed, rejected, cancelled } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      $or: [{ sourceBranch: req.branchId }, { destinationBranch: req.branchId }],
    })
      .populate('fromWarehouse', 'name address')
      .populate('toWarehouse', 'name address')
      .populate('requestedBy', 'name')
      .populate('approvedBy', 'name')
      .populate('dispatchedBy', 'name')
      .populate('receivedBy', 'name')
      .populate('items.product', 'productCode itemName images')
      .lean();
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: transfer });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      sourceBranch, destinationBranch, transferNumber, requestedBy, status,
      approvedBy, dispatchedBy, receivedBy, ...input
    } = req.body;
    const data = { ...input, requestedBy: req.user._id, status: 'requested' };
    if (!Array.isArray(data.items) || data.items.length === 0) throw routeError(422, 'At least one transfer item is required.');

    const [fromWarehouse, toWarehouse] = await Promise.all([
      Warehouse.findOne({ _id: data.fromWarehouse, status: 'active' }).select('name branch').lean(),
      Warehouse.findOne({ _id: data.toWarehouse, status: 'active' }).select('name branch').lean(),
    ]);
    if (!fromWarehouse?.branch || !toWarehouse?.branch) throw routeError(422, 'Both warehouses must be active and assigned to branches.');
    const branchIds = [...new Set([String(fromWarehouse.branch), String(toWarehouse.branch)])];
    if (await Branch.countDocuments({ _id: { $in: branchIds }, status: 'active' }) !== branchIds.length) {
      throw routeError(422, 'Both source and destination branches must be active.');
    }
    if (String(fromWarehouse.branch) !== String(req.branchId)) throw routeError(403, 'The active branch must own the source warehouse.');
    if (String(data.fromWarehouse) === String(data.toWarehouse)) throw routeError(400, 'Source and destination warehouse cannot be the same.');

    data.sourceBranch = fromWarehouse.branch;
    data.destinationBranch = toWarehouse.branch;
    data.transferType = String(fromWarehouse.branch) === String(toWarehouse.branch)
      ? 'warehouse_to_warehouse'
      : 'branch_to_branch';
    data.transferNumber = await generateBranchNumber(fromWarehouse.branch, 'stockTransfer', data.transferDate || new Date());
    data.fromWarehouseName = fromWarehouse.name;
    data.toWarehouseName = toWarehouse.name;

    const requirements = new Map();
    const productIds = [...new Set(data.items.map(item => String(item.product || '')))].filter(mongoose.isValidObjectId);
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    const productsById = new Map(products.map(product => [String(product._id), product]));
    const normalizedItems = [];
    for (let index = 0; index < data.items.length; index += 1) {
      const item = data.items[index];
      const requestedQty = Number(item.requestedQty);
      const product = productsById.get(String(item.product));
      if (!product || !Number.isFinite(requestedQty) || requestedQty <= 0) {
        throw routeError(422, `items[${index}] requires a valid product and a finite requestedQty greater than zero.`);
      }
      const uom = await resolveStockUom({ product, enteredQuantity: requestedQty, enteredUnit: item.unit || product.unit });
      const normalized = {
        ...item,
        requestedQty: uom.enteredQuantity,
        approvedQty: 0, blockedQty: 0, cancelledQty: 0, releasedQty: 0,
        dispatchedQty: 0, receivedQty: 0, damagedQty: 0, shortQty: 0,
        unit: uom.enteredUnit, enteredUnit: uom.enteredUnit,
        baseQuantity: uom.baseQuantity, baseUnit: uom.baseUnit,
        conversionFactor: uom.conversionFactor, uomVersion: uom.uomVersion,
      };
      const key = stockKey(data.sourceBranch, item.product, data.fromWarehouse, item.shade, item.batch);
      const existing = requirements.get(key);
      requirements.set(key, { item: normalized, quantity: (existing?.quantity || 0) + uom.baseQuantity });
      normalizedItems.push(normalized);
    }
    data.items = normalizedItems;

    for (const { item, quantity } of requirements.values()) {
      const stock = await Stock.findOne({
        branch: data.sourceBranch,
        product: item.product,
        warehouse: data.fromWarehouse,
        shade: item.shade || '',
        batch: item.batch || '',
      }).lean();
      const available = Number(stock?.availableQty || 0);
      item.availableAtRequest = item.conversionFactor > 0 ? available / item.conversionFactor : available;
      if (!Number.isFinite(available) || available < quantity) {
        throw routeError(409, `Insufficient stock for ${item.productName || 'product'}. Available: ${available}, requested: ${quantity}.`);
      }
    }
    data.totalItems = data.items.length;
    data.totalRequestedQty = data.items.reduce((sum, item) => sum + item.requestedQty, 0);

    const transfer = await StockTransfer.create(data);
    return res.status(201).json({ success: true, message: `Transfer ${transfer.transferNumber} created.`, data: transfer });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.patch('/:id/approve', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let transfer;
    await session.withTransaction(async () => {
      const { action, remarks } = req.body;
      if (!['approve', 'reject'].includes(action)) throw routeError(422, 'action must be approve or reject.');
      transfer = await StockTransfer.findOne({ _id: req.params.id, sourceBranch: req.branchId }).session(session);
      if (!transfer) throw routeError(404, 'Not found in the active source branch.');
      if (transfer.status === (action === 'approve' ? 'approved' : 'rejected')) return;
      if (transfer.status !== 'requested') throw routeError(409, `Cannot ${action}; status is ${transfer.status}.`);
      if (transfer.requestedBy && String(transfer.requestedBy) === String(req.user._id)) {
        throw routeError(403, 'Maker-checker violation: the transfer requester cannot approve or reject it.');
      }
      const actionedAt = new Date();
      if (action === 'reject') {
        transfer.status = 'rejected';
        transfer.reservationState = 'none';
        transfer.rejectionReason = String(remarks || '');
      } else {
        const version = Number(transfer.reservationVersion || 0) + 1;
        transfer.reservationState = 'blocking';
        for (const item of transfer.items) {
          const snapshot = stableUomSnapshot(item);
          const enteredQuantity = Number(item.requestedQty || 0);
          const baseQuantity = enteredQuantity * snapshot.conversionFactor;
          await applyStockMovement({
            operationKey: stockOperationKey('stock-transfer', transfer._id, item._id, 'block', version),
            correlationKey: stockOperationKey('stock-transfer', transfer._id, 'reservation', version),
            movementType: 'transfer_block', phase: 'reserved',
            branch: transfer.sourceBranch, product: item.product, warehouse: transfer.fromWarehouse,
            shade: item.shade || '', batch: item.batch || '', relatedBranch: transfer.destinationBranch, relatedWarehouse: transfer.toWarehouse,
            deltas: { availableQty: -baseQuantity, blockedQty: baseQuantity },
            enteredQuantity, ...snapshot, baseQuantity,
            sourceType: 'StockTransfer', sourceModel: 'StockTransfer', sourceId: transfer._id, sourceLineId: item._id,
            sourceNumber: transfer.transferNumber, actor: req.user._id, occurredAt: actionedAt,
            reason: 'Approved transfer stock block', remarks: String(remarks || ''), metadata: { reservationVersion: version },
            guardMessage: `Insufficient available stock to approve ${item.productName || 'transfer item'}.`,
          }, { session });
          item.approvedQty = enteredQuantity;
          item.blockedQty = enteredQuantity;
          item.baseQuantity = baseQuantity;
        }
        transfer.reservationVersion = version;
        transfer.reservationState = 'blocked';
        transfer.reservationPostedAt = actionedAt;
        transfer.status = 'approved';
        transfer.approvalRemarks = String(remarks || '');
      }
      transfer.approvedBy = req.user._id;
      transfer.approvalDate = actionedAt;
      await transfer.save({ session });
    });
    return res.json({ success: true, message: `Transfer ${req.body.action === 'approve' ? 'approved and stock blocked' : 'rejected'}.`, data: transfer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

router.patch('/:id/dispatch', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let transfer;
    await session.withTransaction(async () => {
      transfer = await StockTransfer.findOne({ _id: req.params.id, sourceBranch: req.branchId }).session(session);
      if (!transfer) throw routeError(404, 'Not found in the active source branch.');
      if (transfer.status !== 'approved') throw routeError(409, 'Transfer must be approved first.');

      // Compatibility for approved records created before approval-time blocking existed.
      if (transfer.reservationState !== 'blocked') {
        const version = Math.max(1, Number(transfer.reservationVersion || 0));
        const blockedAt = transfer.approvalDate || new Date();
        for (const item of transfer.items) {
          const enteredQuantity = Number(item.approvedQty || item.requestedQty || 0);
          if (!(enteredQuantity > 0)) continue;
          const snapshot = stableUomSnapshot(item);
          const baseQuantity = enteredQuantity * snapshot.conversionFactor;
          await applyStockMovement({
            operationKey: stockOperationKey('stock-transfer', transfer._id, item._id, 'block', version),
            correlationKey: stockOperationKey('stock-transfer', transfer._id, 'reservation', version),
            movementType: 'transfer_block', phase: 'reserved', branch: transfer.sourceBranch,
            product: item.product, warehouse: transfer.fromWarehouse, shade: item.shade || '', batch: item.batch || '',
            relatedBranch: transfer.destinationBranch, relatedWarehouse: transfer.toWarehouse,
            deltas: { availableQty: -baseQuantity, blockedQty: baseQuantity }, enteredQuantity, ...snapshot, baseQuantity,
            sourceType: 'StockTransfer', sourceModel: 'StockTransfer', sourceId: transfer._id, sourceLineId: item._id,
            sourceNumber: transfer.transferNumber, actor: transfer.approvedBy || req.user._id, occurredAt: blockedAt,
            reason: 'Legacy approved transfer stock block', remarks: transfer.approvalRemarks || '', metadata: { reservationVersion: version, compatibilityBackfill: true },
            guardMessage: `Insufficient available stock to block legacy approved transfer item ${item.productName || ''}.`,
          }, { session });
          item.approvedQty = enteredQuantity; item.blockedQty = enteredQuantity;
        }
        transfer.reservationVersion = version; transfer.reservationState = 'blocked'; transfer.reservationPostedAt = blockedAt;
      }

      const submitted = Array.isArray(req.body.items) ? req.body.items : null;
      if (submitted) {
        const seen = new Set();
        transfer.items.forEach((item) => { item.dispatchedQty = 0; });
        for (let index = 0; index < submitted.length; index += 1) {
          const update = submitted[index];
          const id = String(update._id || '');
          if (!id || seen.has(id)) throw routeError(422, 'Dispatch items must reference each transfer line exactly once.');
          seen.add(id);
          const item = transfer.items.id(id);
          if (!item) throw routeError(422, `Dispatch item ${index + 1} is not part of this transfer.`);
          const quantity = Number(update.dispatchedQty);
          if (!Number.isFinite(quantity) || quantity < 0 || quantity > Number(item.approvedQty || item.requestedQty)) {
            throw routeError(422, `items[${index}].dispatchedQty must be between zero and approvedQty.`);
          }
          item.dispatchedQty = quantity;
        }
      } else {
        transfer.items.forEach((item) => { item.dispatchedQty = Number(item.approvedQty || item.requestedQty); });
      }

      const requirements = new Map();
      for (const item of transfer.items) {
        const quantity = Number(item.dispatchedQty);
        if (!Number.isFinite(quantity) || quantity < 0 || quantity > Number(item.approvedQty || item.requestedQty)) {
          throw routeError(422, 'Every dispatched quantity must be finite, nonnegative, and no greater than approved quantity.');
        }
        if (quantity === 0) continue;
        const key = stockKey(transfer.sourceBranch, item.product, transfer.fromWarehouse, item.shade, item.batch);
        const existing = requirements.get(key);
        requirements.set(key, { item, quantity: (existing?.quantity || 0) + quantity });
      }
      const totalDispatched = [...requirements.values()].reduce((sum, item) => sum + item.quantity, 0);
      if (totalDispatched <= 0) throw routeError(422, 'At least one item must have a dispatched quantity greater than zero.');

      const dispatchedAt = new Date();
      for (const item of transfer.items) {
        const quantity = Number(item.dispatchedQty || 0);
        if (quantity <= 0) continue;
        const snapshot = stableUomSnapshot(item);
        const baseQuantity = quantity * snapshot.conversionFactor;
        await applyStockMovement({
          operationKey: stockOperationKey('stock-transfer', transfer._id, item._id, 'dispatch-source'),
          correlationKey: stockOperationKey('stock-transfer', transfer._id),
          movementType: 'transfer_dispatch', phase: 'dispatched',
          branch: transfer.sourceBranch, product: item.product, warehouse: transfer.fromWarehouse, shade: item.shade || '', batch: item.batch || '',
          relatedBranch: transfer.destinationBranch, relatedWarehouse: transfer.toWarehouse,
          deltas: { blockedQty: -baseQuantity, transitQty: baseQuantity },
          enteredQuantity: quantity, ...snapshot, baseQuantity,
          sourceType: 'StockTransfer', sourceModel: 'StockTransfer', sourceId: transfer._id, sourceLineId: item._id,
          sourceNumber: transfer.transferNumber, actor: req.user._id, occurredAt: dispatchedAt,
          reason: 'Canonical stock transfer dispatch', remarks: req.body.remarks || '',
          metadata: { leg: 'source_dispatch', requestedQty: item.requestedQty, transferType: transfer.transferType },
          guardMessage: `Insufficient stock for ${item.productName || 'transfer item'}.`,
        }, { session });
      }

      for (const item of transfer.items) {
        const approvedQty = Number(item.approvedQty || item.requestedQty || 0);
        const dispatchedQty = Number(item.dispatchedQty || 0);
        const unusedQty = Math.max(0, approvedQty - dispatchedQty);
        const snapshot = stableUomSnapshot(item);
        if (unusedQty > 0) {
          const baseQuantity = unusedQty * snapshot.conversionFactor;
          await applyStockMovement({
            operationKey: stockOperationKey('stock-transfer', transfer._id, item._id, 'block-release', transfer.reservationVersion || 1),
            correlationKey: stockOperationKey('stock-transfer', transfer._id),
            movementType: 'transfer_block_release', phase: 'released',
            branch: transfer.sourceBranch, product: item.product, warehouse: transfer.fromWarehouse,
            shade: item.shade || '', batch: item.batch || '', relatedBranch: transfer.destinationBranch, relatedWarehouse: transfer.toWarehouse,
            deltas: { blockedQty: -baseQuantity, availableQty: baseQuantity },
            enteredQuantity: unusedQty, ...snapshot, baseQuantity,
            sourceType: 'StockTransfer', sourceModel: 'StockTransfer', sourceId: transfer._id, sourceLineId: item._id,
            sourceNumber: transfer.transferNumber, actor: req.user._id, occurredAt: dispatchedAt,
            reason: 'Partial transfer dispatch released unused approved stock', remarks: req.body.remarks || '',
            metadata: { approvedQty, dispatchedQty, releasedQty: unusedQty },
            guardMessage: `Blocked transfer stock changed for ${item.productName || 'transfer item'}.`,
          }, { session });
        }
        item.cancelledQty = unusedQty;
        item.releasedQty = unusedQty;
        item.blockedQty = 0;
      }

      transfer.status = 'in_transit';
      transfer.dispatchedBy = req.user._id;
      transfer.dispatchDate = dispatchedAt;
      transfer.vehicleNumber = req.body.vehicleNumber || '';
      transfer.driverName = req.body.driverName || '';
      transfer.driverPhone = req.body.driverPhone || '';
      transfer.totalDispatchedQty = totalDispatched;
      transfer.reservationState = 'consumed';
      transfer.reservationReleasedAt = transfer.items.some(item => Number(item.releasedQty || 0) > 0) ? dispatchedAt : undefined;
      await transfer.save({ session });
    });
    return res.json({ success: true, message: 'Transfer dispatched.', data: transfer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/receive', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let transfer;
    await session.withTransaction(async () => {
      transfer = await StockTransfer.findOne({ _id: req.params.id, destinationBranch: req.branchId }).session(session);
      if (!transfer) throw routeError(404, 'Not found in the active destination branch.');
      if (transfer.status !== 'in_transit') throw routeError(409, 'Transfer must be in transit.');

      const submitted = Array.isArray(req.body.items) ? req.body.items : null;
      if (submitted) {
        const seen = new Set();
        const expectedIds = new Set(transfer.items.filter(item => Number(item.dispatchedQty || 0) > 0).map(item => String(item._id)));
        for (let index = 0; index < submitted.length; index += 1) {
          const id = String(submitted[index]?._id || '');
          if (!id || seen.has(id)) throw routeError(422, 'Receipt items must reference every dispatched transfer line exactly once.');
          if (!expectedIds.has(id)) throw routeError(422, `Receipt item ${index + 1} is extra or was not dispatched.`);
          seen.add(id);
        }
        const missing = [...expectedIds].filter(id => !seen.has(id));
        if (missing.length || seen.size !== expectedIds.size) {
          throw routeError(422, `Receipt items must include every dispatched transfer line exactly once. Missing: ${missing.join(', ') || 'none'}.`);
        }
        transfer.items.forEach((item) => {
          item.receivedQty = 0;
          item.damagedQty = 0;
          item.shortQty = Number(item.dispatchedQty);
        });
        seen.clear();
        for (let index = 0; index < submitted.length; index += 1) {
          const update = submitted[index];
          const id = String(update._id || '');
          if (!id || seen.has(id)) throw routeError(422, 'Receipt items must reference each transfer line exactly once.');
          seen.add(id);
          const item = transfer.items.id(id);
          if (!item) throw routeError(422, `Receipt item ${index + 1} is not part of this transfer.`);
          const receivedQty = Number(update.receivedQty ?? 0);
          const damagedQty = Number(update.damagedQty ?? 0);
          if (!Number.isFinite(receivedQty) || receivedQty < 0 || !Number.isFinite(damagedQty) || damagedQty < 0
            || receivedQty + damagedQty > Number(item.dispatchedQty)) {
            throw routeError(422, `items[${index}] receivedQty plus damagedQty must be between zero and dispatchedQty.`);
          }
          item.receivedQty = receivedQty;
          item.damagedQty = damagedQty;
          item.shortQty = Number(item.dispatchedQty) - receivedQty - damagedQty;
          item.remarks = update.remarks || '';
        }
      } else {
        transfer.items.forEach((item) => {
          item.receivedQty = Number(item.dispatchedQty);
          item.damagedQty = 0;
          item.shortQty = 0;
        });
      }

      const receivedAt = new Date();
      for (const item of transfer.items) {
        const dispatchedQty = Number(item.dispatchedQty || 0);
        const shortQty = Number(item.shortQty || 0);
        if (dispatchedQty <= 0) continue;
        const snapshot = stableUomSnapshot(item);
        const baseDispatchedQty = dispatchedQty * snapshot.conversionFactor;
        const baseShortQty = shortQty * snapshot.conversionFactor;
        await applyStockMovement({
          operationKey: stockOperationKey('stock-transfer', transfer._id, item._id, 'receive-source-close'),
          correlationKey: stockOperationKey('stock-transfer', transfer._id),
          movementType: shortQty > 0 ? 'transfer_short' : 'transfer_receive', phase: 'received',
          branch: transfer.sourceBranch, product: item.product, warehouse: transfer.fromWarehouse, shade: item.shade || '', batch: item.batch || '',
          relatedBranch: transfer.destinationBranch, relatedWarehouse: transfer.toWarehouse,
          deltas: { totalQty: -baseDispatchedQty, transitQty: -baseDispatchedQty, shortQty: baseShortQty },
          enteredQuantity: dispatchedQty, ...snapshot, baseQuantity: baseDispatchedQty,
          sourceType: 'StockTransfer', sourceModel: 'StockTransfer', sourceId: transfer._id, sourceLineId: item._id,
          sourceNumber: transfer.transferNumber, actor: req.user._id, occurredAt: receivedAt,
          reason: 'Canonical stock transfer source receipt closure', remarks: item.remarks || req.body.remarks || '',
          metadata: { leg: 'source_close', dispatchedQty, receivedQty: item.receivedQty, damagedQty: item.damagedQty, shortQty },
          guardMessage: 'In-transit source stock changed before receipt could be posted.',
        }, { session });
      }

      for (const item of transfer.items) {
        const receivedQty = Number(item.receivedQty || 0);
        const damagedQty = Number(item.damagedQty || 0);
        if (receivedQty === 0 && damagedQty === 0) continue;
        const snapshot = stableUomSnapshot(item);
        const enteredQuantity = receivedQty + damagedQty;
        const baseQuantity = enteredQuantity * snapshot.conversionFactor;
        const baseReceivedQty = receivedQty * snapshot.conversionFactor;
        const baseDamagedQty = damagedQty * snapshot.conversionFactor;
        await applyStockMovement({
          operationKey: stockOperationKey('stock-transfer', transfer._id, item._id, 'receive-destination'),
          correlationKey: stockOperationKey('stock-transfer', transfer._id),
          movementType: 'transfer_receive', phase: 'received',
          branch: transfer.destinationBranch, product: item.product, warehouse: transfer.toWarehouse, shade: item.shade || '', batch: item.batch || '',
          relatedBranch: transfer.sourceBranch, relatedWarehouse: transfer.fromWarehouse,
          deltas: { availableQty: baseReceivedQty, totalQty: baseQuantity, damagedQty: baseDamagedQty }, upsert: true,
          enteredQuantity, ...snapshot, baseQuantity,
          sourceType: 'StockTransfer', sourceModel: 'StockTransfer', sourceId: transfer._id, sourceLineId: item._id,
          sourceNumber: transfer.transferNumber, actor: req.user._id, occurredAt: receivedAt,
          reason: 'Canonical stock transfer destination receipt', remarks: item.remarks || req.body.remarks || '',
          metadata: { leg: 'destination_receive', dispatchedQty: item.dispatchedQty, receivedQty, damagedQty, shortQty: item.shortQty },
        }, { session });
      }

      transfer.status = 'completed';
      transfer.receivedBy = req.user._id;
      transfer.receivedDate = receivedAt;
      transfer.receivingRemarks = req.body.remarks || '';
      transfer.totalReceivedQty = transfer.items.reduce((sum, item) => sum + Number(item.receivedQty || 0), 0);
      await transfer.save({ session });
    });
    return res.json({ success: true, message: 'Transfer received and stock updated.', data: transfer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/cancel', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let transfer;
    await session.withTransaction(async () => {
      transfer = await StockTransfer.findOne({ _id: req.params.id, sourceBranch: req.branchId }).session(session);
      if (!transfer) throw routeError(404, 'Not found in the active source branch.');
      if (transfer.status === 'cancelled') return;
      if (!['requested', 'approved'].includes(transfer.status)) {
        throw routeError(409, `Cannot cancel a transfer in ${transfer.status} status without a dispatch-return workflow.`);
      }
      const cancelledAt = new Date();
      if (transfer.status === 'approved') {
        for (const item of transfer.items) {
          const blockedQty = Number(item.blockedQty || item.approvedQty || 0);
          if (!(blockedQty > 0)) continue;
          const snapshot = stableUomSnapshot(item);
          const baseQuantity = blockedQty * snapshot.conversionFactor;
          await applyStockMovement({
            operationKey: stockOperationKey('stock-transfer', transfer._id, item._id, 'cancel-block-release', transfer.reservationVersion || 1),
            correlationKey: stockOperationKey('stock-transfer', transfer._id, 'cancel'),
            movementType: 'transfer_block_release', phase: 'released',
            branch: transfer.sourceBranch, product: item.product, warehouse: transfer.fromWarehouse,
            shade: item.shade || '', batch: item.batch || '', relatedBranch: transfer.destinationBranch, relatedWarehouse: transfer.toWarehouse,
            deltas: { blockedQty: -baseQuantity, availableQty: baseQuantity },
            enteredQuantity: blockedQty, ...snapshot, baseQuantity,
            sourceType: 'StockTransfer', sourceModel: 'StockTransfer', sourceId: transfer._id, sourceLineId: item._id,
            sourceNumber: transfer.transferNumber, actor: req.user._id, occurredAt: cancelledAt,
            reason: String(req.body.reason || 'Approved transfer cancelled'),
            guardMessage: `Blocked transfer stock changed for ${item.productName || 'transfer item'}.`,
          }, { session });
          item.cancelledQty = blockedQty;
          item.releasedQty = blockedQty;
          item.blockedQty = 0;
        }
        transfer.reservationState = 'released';
        transfer.reservationReleasedAt = cancelledAt;
      }
      transfer.status = 'cancelled';
      transfer.remarks = String(req.body.reason || transfer.remarks || '');
      await transfer.save({ session });
    });
    return res.json({ success: true, message: 'Transfer cancelled; any approved stock block was released.', data: transfer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

export default router;
