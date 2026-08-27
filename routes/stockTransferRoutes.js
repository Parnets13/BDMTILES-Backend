import { Router } from 'express';
import mongoose from 'mongoose';
import StockTransfer from '../models/StockTransfer.js';
import Warehouse from '../models/Warehouse.js';
import Stock from '../models/Stock.js';
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
    data.items = data.items.map((item, index) => {
      const requestedQty = Number(item.requestedQty);
      if (!item.product || !Number.isFinite(requestedQty) || requestedQty <= 0) {
        throw routeError(422, `items[${index}] requires a product and a finite requestedQty greater than zero.`);
      }
      const normalized = { ...item, requestedQty, dispatchedQty: 0, receivedQty: 0, damagedQty: 0, shortQty: 0 };
      const key = stockKey(data.sourceBranch, item.product, data.fromWarehouse, item.shade, item.batch);
      const existing = requirements.get(key);
      requirements.set(key, { item: normalized, quantity: (existing?.quantity || 0) + requestedQty });
      return normalized;
    });

    for (const { item, quantity } of requirements.values()) {
      const stock = await Stock.findOne({
        branch: data.sourceBranch,
        product: item.product,
        warehouse: data.fromWarehouse,
        shade: item.shade || '',
        batch: item.batch || '',
      }).lean();
      const available = Number(stock?.availableQty || 0);
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
  try {
    const { action, remarks } = req.body;
    if (!['approve', 'reject'].includes(action)) throw routeError(422, 'action must be approve or reject.');
    const transfer = await StockTransfer.findOne({ _id: req.params.id, sourceBranch: req.branchId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found in the active source branch.' });
    if (transfer.status !== 'requested') throw routeError(409, `Cannot ${action}; status is ${transfer.status}.`);

    transfer.status = action === 'approve' ? 'approved' : 'rejected';
    transfer.approvedBy = req.user._id;
    transfer.approvalDate = new Date();
    if (action === 'approve') transfer.approvalRemarks = remarks || '';
    else transfer.rejectionReason = remarks || '';
    await transfer.save();
    return res.json({ success: true, message: `Transfer ${action}d.`, data: transfer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.patch('/:id/dispatch', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let transfer;
    await session.withTransaction(async () => {
      transfer = await StockTransfer.findOne({ _id: req.params.id, sourceBranch: req.branchId }).session(session);
      if (!transfer) throw routeError(404, 'Not found in the active source branch.');
      if (transfer.status !== 'approved') throw routeError(409, 'Transfer must be approved first.');

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
          if (!Number.isFinite(quantity) || quantity < 0 || quantity > Number(item.requestedQty)) {
            throw routeError(422, `items[${index}].dispatchedQty must be between zero and requestedQty.`);
          }
          item.dispatchedQty = quantity;
        }
      } else {
        transfer.items.forEach((item) => { item.dispatchedQty = Number(item.requestedQty); });
      }

      const requirements = new Map();
      for (const item of transfer.items) {
        const quantity = Number(item.dispatchedQty);
        if (!Number.isFinite(quantity) || quantity < 0 || quantity > Number(item.requestedQty)) {
          throw routeError(422, 'Every dispatched quantity must be finite, nonnegative, and no greater than requested quantity.');
        }
        if (quantity === 0) continue;
        const key = stockKey(transfer.sourceBranch, item.product, transfer.fromWarehouse, item.shade, item.batch);
        const existing = requirements.get(key);
        requirements.set(key, { item, quantity: (existing?.quantity || 0) + quantity });
      }
      const totalDispatched = [...requirements.values()].reduce((sum, item) => sum + item.quantity, 0);
      if (totalDispatched <= 0) throw routeError(422, 'At least one item must have a dispatched quantity greater than zero.');

      for (const { item, quantity } of requirements.values()) {
        const deducted = await Stock.findOneAndUpdate(
          {
            branch: transfer.sourceBranch,
            product: item.product,
            warehouse: transfer.fromWarehouse,
            shade: item.shade || '',
            batch: item.batch || '',
            totalQty: { $gte: quantity },
            availableQty: { $gte: quantity },
          },
          { $inc: { availableQty: -quantity, transitQty: quantity } },
          { new: true, session }
        );
        if (!deducted) throw routeError(409, `Insufficient stock for ${item.productName || 'transfer item'}.`);
      }

      transfer.status = 'in_transit';
      transfer.dispatchedBy = req.user._id;
      transfer.dispatchDate = new Date();
      transfer.vehicleNumber = req.body.vehicleNumber || '';
      transfer.driverName = req.body.driverName || '';
      transfer.driverPhone = req.body.driverPhone || '';
      transfer.totalDispatchedQty = totalDispatched;
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
        transfer.items.forEach((item) => {
          item.receivedQty = 0;
          item.damagedQty = 0;
          item.shortQty = Number(item.dispatchedQty);
        });
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

      const sourceClosures = new Map();
      for (const item of transfer.items) {
        const dispatchedQty = Number(item.dispatchedQty || 0);
        const shortQty = Number(item.shortQty || 0);
        if (dispatchedQty <= 0) continue;
        const key = stockKey(transfer.sourceBranch, item.product, transfer.fromWarehouse, item.shade, item.batch);
        const existing = sourceClosures.get(key);
        sourceClosures.set(key, {
          item,
          dispatchedQty: (existing?.dispatchedQty || 0) + dispatchedQty,
          shortQty: (existing?.shortQty || 0) + shortQty,
        });
      }
      for (const { item, dispatchedQty, shortQty } of sourceClosures.values()) {
        const closed = await Stock.findOneAndUpdate(
          {
            branch: transfer.sourceBranch,
            product: item.product,
            warehouse: transfer.fromWarehouse,
            shade: item.shade || '',
            batch: item.batch || '',
            totalQty: { $gte: dispatchedQty },
            transitQty: { $gte: dispatchedQty },
          },
          { $inc: { totalQty: -dispatchedQty, transitQty: -dispatchedQty, shortQty } },
          { new: true, session }
        );
        if (!closed) throw routeError(409, 'In-transit source stock changed before receipt could be posted.');
      }

      const additions = new Map();
      for (const item of transfer.items) {
        const receivedQty = Number(item.receivedQty);
        const damagedQty = Number(item.damagedQty);
        if (!Number.isFinite(receivedQty) || receivedQty < 0 || !Number.isFinite(damagedQty) || damagedQty < 0
          || receivedQty + damagedQty > Number(item.dispatchedQty)) {
          throw routeError(422, 'Every received and damaged quantity must be finite, nonnegative, and bounded by dispatched quantity.');
        }
        if (receivedQty === 0 && damagedQty === 0) continue;
        const key = stockKey(transfer.destinationBranch, item.product, transfer.toWarehouse, item.shade, item.batch);
        const existing = additions.get(key);
        additions.set(key, {
          item,
          receivedQty: (existing?.receivedQty || 0) + receivedQty,
          damagedQty: (existing?.damagedQty || 0) + damagedQty,
        });
      }
      for (const { item, receivedQty, damagedQty } of additions.values()) {
        await Stock.findOneAndUpdate(
          {
            branch: transfer.destinationBranch,
            product: item.product,
            warehouse: transfer.toWarehouse,
            shade: item.shade || '',
            batch: item.batch || '',
          },
          {
            $inc: { availableQty: receivedQty, totalQty: receivedQty + damagedQty, damagedQty },
            $set: { branch: transfer.destinationBranch },
          },
          { upsert: true, new: true, session }
        );
      }

      transfer.status = 'completed';
      transfer.receivedBy = req.user._id;
      transfer.receivedDate = new Date();
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
  try {
    const transfer = await StockTransfer.findOne({ _id: req.params.id, sourceBranch: req.branchId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found in the active source branch.' });
    if (transfer.status === 'cancelled') return res.json({ success: true, message: 'Transfer is already cancelled.', data: transfer });
    if (!['requested', 'approved'].includes(transfer.status)) {
      throw routeError(409, `Cannot cancel a transfer in ${transfer.status} status without reversing stock.`);
    }
    transfer.status = 'cancelled';
    await transfer.save();
    return res.json({ success: true, message: 'Transfer cancelled.', data: transfer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
