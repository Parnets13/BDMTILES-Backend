import { Router } from 'express';
import mongoose from 'mongoose';
import Dispatch from '../models/Dispatch.js';
import SalesOrder from '../models/SalesOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);
router.use(requirePermission('dispatch.management'));

const DISPATCH_STATUSES = new Set(['planned', 'loaded', 'in_transit', 'partially_delivered', 'completed', 'cancelled']);

async function assertSalesOrdersInBranch(orders, branchId) {
  const references = (orders || []).map(order => order?.salesOrder).filter(Boolean);
  if (references.some(id => !mongoose.isValidObjectId(id))) {
    const error = new Error('One or more Sales Order references are invalid.');
    error.status = 422;
    throw error;
  }
  const uniqueIds = [...new Set(references.map(String))];
  if (uniqueIds.length !== references.length) {
    const error = new Error('Each Sales Order may appear only once in a dispatch.');
    error.status = 422;
    throw error;
  }
  if (!uniqueIds.length) return [];
  const salesOrders = await SalesOrder.find({ _id: { $in: uniqueIds }, branch: branchId }).select('_id').lean();
  if (salesOrders.length !== uniqueIds.length) {
    const error = new Error('One or more Sales Orders are outside the active branch or unavailable.');
    error.status = 403;
    throw error;
  }
  return uniqueIds;
}

// GET /api/v1/dispatch — list
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    const filter = { branch: req.branchId };
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ dispatchNumber: r }, { vehicle: r }, { driverName: r }]; }
    if (status) filter.status = status;
    const [data, total] = await Promise.all([
      Dispatch.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('route', 'name').populate('warehouse', 'name').lean(),
      Dispatch.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch/stats
router.get('/stats', async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, planned, inTransit, completed, cancelled] = await Promise.all([
      Dispatch.countDocuments(scope),
      Dispatch.countDocuments({ ...scope, status: 'planned' }),
      Dispatch.countDocuments({ ...scope, status: 'in_transit' }),
      Dispatch.countDocuments({ ...scope, status: 'completed' }),
      Dispatch.countDocuments({ ...scope, status: 'cancelled' }),
    ]);
    // Orders ready for dispatch (confirmed/processing, no dispatch yet)
    const pendingOrders = await SalesOrder.countDocuments({ ...scope, status: { $in: ['confirmed', 'processing'] } });
    res.json({ success: true, data: { total, planned, inTransit, completed, cancelled, pendingOrders } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch/pending-orders — orders ready for dispatch
router.get('/pending-orders', async (req, res) => {
  try {
    const orders = await SalesOrder.find({ branch: req.branchId, status: { $in: ['confirmed', 'processing', 'approved'] } })
      .select('orderNumber orderDate dealerName dealerCode deliveryAddress grandTotal expectedDeliveryDate items deliveryPriority')
      .sort({ deliveryPriority: 1, orderDate: 1 }).limit(100).lean();
    res.json({ success: true, data: orders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch/:id
router.get('/:id', async (req, res) => {
  try {
    const d = await Dispatch.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('route', 'name').populate('warehouse', 'name').lean();
    if (!d) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/dispatch — compatibility endpoint; new workflows should use dispatch-trips
router.post('/', async (req, res) => {
  try {
    const data = { ...req.body, branch: req.branchId, createdBy: req.user._id };
    const salesOrderIds = await assertSalesOrdersInBranch(data.orders, req.branchId);
    if (data.warehouse) await assertWarehousesInBranch([data.warehouse], req.branchId);
    data.dispatchNumber = await generateBranchNumber(req.branchId, 'dispatch', data.dispatchDate || new Date());
    data.totalOrders = data.orders?.length || 0;
    const dispatch = await Dispatch.create(data);
    if (salesOrderIds.length) {
      await SalesOrder.updateMany(
        { _id: { $in: salesOrderIds }, branch: req.branchId },
        { $set: { status: 'partial_dispatch' } }
      );
    }
    res.status(201).json({ success: true, message: `Dispatch ${dispatch.dispatchNumber} planned.`, data: dispatch });
  } catch (e) { res.status(e.status || (['CastError', 'ValidationError'].includes(e.name) ? 422 : 500)).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/dispatch/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!DISPATCH_STATUSES.has(status)) {
      return res.status(422).json({ success: false, message: 'Invalid dispatch status.' });
    }
    const current = await Dispatch.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!current) return res.status(404).json({ success: false, message: 'Not found.' });
    const salesOrderIds = await assertSalesOrdersInBranch(current.orders, req.branchId);
    const dispatch = await Dispatch.findOneAndUpdate(
      { _id: current._id, branch: req.branchId },
      { status },
      { new: true, runValidators: true }
    );
    // If completed, mark all linked SOs as dispatched
    if ((status === 'completed' || status === 'in_transit') && salesOrderIds.length) {
      await SalesOrder.updateMany(
        { _id: { $in: salesOrderIds }, branch: req.branchId },
        { $set: { status: status === 'completed' ? 'delivered' : 'dispatched' } }
      );
    }
    res.json({ success: true, message: `Status → ${status}`, data: dispatch });
  } catch (e) { res.status(e.status || (['CastError', 'ValidationError'].includes(e.name) ? 422 : 500)).json({ success: false, message: e.message }); }
});

export default router;
