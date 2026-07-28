import { Router } from 'express';
import Dispatch from '../models/Dispatch.js';
import SalesOrder from '../models/SalesOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/dispatch — list
router.get('/', requirePermission('dispatch.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
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
router.get('/stats', requirePermission('dispatch.management'), async (req, res) => {
  try {
    const [total, planned, inTransit, completed, cancelled] = await Promise.all([
      Dispatch.countDocuments(),
      Dispatch.countDocuments({ status: 'planned' }),
      Dispatch.countDocuments({ status: 'in_transit' }),
      Dispatch.countDocuments({ status: 'completed' }),
      Dispatch.countDocuments({ status: 'cancelled' }),
    ]);
    // Orders ready for dispatch (confirmed/processing, no dispatch yet)
    const pendingOrders = await SalesOrder.countDocuments({ status: { $in: ['confirmed', 'processing'] } });
    res.json({ success: true, data: { total, planned, inTransit, completed, cancelled, pendingOrders } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch/pending-orders — orders ready for dispatch
router.get('/pending-orders', requirePermission('dispatch.management'), async (req, res) => {
  try {
    const orders = await SalesOrder.find({ status: { $in: ['confirmed', 'processing', 'approved'] } })
      .select('orderNumber orderDate dealerName dealerCode deliveryAddress grandTotal expectedDeliveryDate items deliveryPriority')
      .sort({ deliveryPriority: 1, orderDate: 1 }).limit(100).lean();
    res.json({ success: true, data: orders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch/:id
router.get('/:id', requirePermission('dispatch.management'), async (req, res) => {
  try {
    const d = await Dispatch.findById(req.params.id)
      .populate('route', 'name').populate('warehouse', 'name').lean();
    if (!d) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/dispatch — create dispatch plan
router.post('/', requirePermission('dispatch.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Dispatch.countDocuments();
    data.dispatchNumber = `DSP-${String(count + 1).padStart(5, '0')}`;
    data.totalOrders = data.orders?.length || 0;
    const dispatch = await Dispatch.create(data);
    // Update SO status to partial_dispatch
    if (data.orders?.length) {
      for (const o of data.orders) {
        if (o.salesOrder) await SalesOrder.findByIdAndUpdate(o.salesOrder, { status: 'partial_dispatch' });
      }
    }
    res.status(201).json({ success: true, message: `Dispatch ${dispatch.dispatchNumber} planned.`, data: dispatch });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/dispatch/:id/status
router.patch('/:id/status', requirePermission('dispatch.management'), async (req, res) => {
  try {
    const { status } = req.body;
    const dispatch = await Dispatch.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!dispatch) return res.status(404).json({ success: false, message: 'Not found.' });
    // If completed, mark all linked SOs as dispatched
    if (status === 'completed' || status === 'in_transit') {
      for (const o of dispatch.orders || []) {
        if (o.salesOrder) {
          await SalesOrder.findByIdAndUpdate(o.salesOrder, {
            status: status === 'completed' ? 'delivered' : 'dispatched',
          });
        }
      }
    }
    res.json({ success: true, message: `Status → ${status}`, data: dispatch });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
