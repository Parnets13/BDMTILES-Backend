import { Router } from 'express';
import DispatchTrip from '../models/DispatchTrip.js';
import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import { protect } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/dispatch-trips — list
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ tripNumber: regex }, { vehicleNumber: regex }, { driverName: regex }, { routeName: regex }];
    }
    if (status) filter.status = status;

    const [trips, total] = await Promise.all([
      DispatchTrip.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('vehicle', 'vehicleNumber vehicleType')
        .populate('deliveryExecutive', 'name phone')
        .populate('createdBy', 'name')
        .lean(),
      DispatchTrip.countDocuments(filter),
    ]);

    res.json({ success: true, data: trips, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch-trips/stats
router.get('/stats', async (req, res) => {
  try {
    const [total, planning, loading, dispatched, inTransit, completed, cancelled] = await Promise.all([
      DispatchTrip.countDocuments(),
      DispatchTrip.countDocuments({ status: 'planning' }),
      DispatchTrip.countDocuments({ status: { $in: ['loading', 'loaded'] } }),
      DispatchTrip.countDocuments({ status: 'dispatched' }),
      DispatchTrip.countDocuments({ status: 'in_transit' }),
      DispatchTrip.countDocuments({ status: 'completed' }),
      DispatchTrip.countDocuments({ status: 'cancelled' }),
    ]);
    res.json({ success: true, data: { total, planning, loading, dispatched, inTransit, completed, cancelled } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch-trips/ready-orders — orders ready for dispatch (pick list ready_for_dispatch)
router.get('/ready-orders', async (req, res) => {
  try {
    const readyPickLists = await PickList.find({ status: 'ready_for_dispatch' })
      .populate('salesOrder', 'orderNumber dealerName dealerCode deliveryAddress grandTotal')
      .select('pickListNumber orderNumber dealerName dealerCode deliveryAddress totalRequestedQty totalBoxes salesOrder')
      .lean();

    // Filter out orders already in a trip
    const existingTripOrderIds = await DispatchTrip.distinct('orders.salesOrder', { status: { $nin: ['cancelled', 'completed'] } });
    const available = readyPickLists.filter(pl => !existingTripOrderIds.some(id => String(id) === String(pl.salesOrder?._id)));

    res.json({ success: true, data: available });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/dispatch-trips — create trip
router.post('/', async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };

    const count = await DispatchTrip.countDocuments();
    data.tripNumber = `TR-${String(count + 1).padStart(5, '0')}`;

    if (data.orders?.length) {
      data.totalOrders = data.orders.length;
      data.totalBoxes = data.orders.reduce((s, o) => s + (o.totalBoxes || 0), 0);
      data.totalWeight = data.orders.reduce((s, o) => s + (o.totalWeight || 0), 0);
      // Set sequence
      data.orders = data.orders.map((o, i) => ({ ...o, sequence: i + 1 }));
    }

    const trip = await DispatchTrip.create(data);
    res.status(201).json({ success: true, message: `Trip ${trip.tripNumber} created.`, data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dispatch-trips/:id
router.get('/:id', async (req, res) => {
  try {
    const trip = await DispatchTrip.findById(req.params.id)
      .populate('vehicle', 'vehicleNumber vehicleType capacity')
      .populate('deliveryExecutive', 'name phone')
      .populate('loadingSupervisor', 'name')
      .populate('orders.salesOrder', 'orderNumber dealerName grandTotal')
      .lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/dispatch-trips/:id/start-loading
router.patch('/:id/start-loading', async (req, res) => {
  try {
    const trip = await DispatchTrip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Not found.' });
    trip.status = 'loading';
    trip.loadingStartTime = new Date();
    await trip.save();
    res.json({ success: true, message: 'Loading started.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/dispatch-trips/:id/verify-loading
router.patch('/:id/verify-loading', async (req, res) => {
  try {
    const { orders } = req.body;
    const trip = await DispatchTrip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Not found.' });

    // Update per-order loading verification
    if (orders?.length) {
      for (const updOrder of orders) {
        const existing = trip.orders.id(updOrder._id);
        if (existing) {
          existing.loadingVerified = updOrder.loadingVerified ?? true;
          existing.loadedBoxes = updOrder.loadedBoxes || existing.totalBoxes;
          existing.loadingRemarks = updOrder.loadingRemarks || '';
        }
      }
    } else {
      trip.orders.forEach(o => { o.loadingVerified = true; o.loadedBoxes = o.totalBoxes; });
    }

    trip.loadedBoxes = trip.orders.reduce((s, o) => s + (o.loadedBoxes || 0), 0);
    trip.loadingVerified = trip.orders.every(o => o.loadingVerified);
    trip.loadingEndTime = new Date();
    trip.loadingSupervisor = req.user._id;
    trip.status = 'loaded';
    await trip.save();

    res.json({ success: true, message: 'Loading verified.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/dispatch-trips/:id/dispatch — final dispatch
router.patch('/:id/dispatch', async (req, res) => {
  try {
    const trip = await DispatchTrip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Not found.' });
    if (!['loaded', 'loading', 'planning'].includes(trip.status)) {
      return res.status(400).json({ success: false, message: `Cannot dispatch from "${trip.status}" status.` });
    }

    trip.status = 'dispatched';
    trip.dispatchTime = new Date();

    // Update all orders delivery status
    trip.orders.forEach(o => { o.deliveryStatus = 'in_transit'; });

    // Update related Sales Orders to 'dispatched'
    for (const order of trip.orders) {
      if (order.salesOrder) {
        await SalesOrder.findByIdAndUpdate(order.salesOrder, { status: 'dispatched' });
      }
    }

    await trip.save();
    res.json({ success: true, message: 'Trip dispatched.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/dispatch-trips/:id/complete
router.patch('/:id/complete', async (req, res) => {
  try {
    const trip = await DispatchTrip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Not found.' });
    trip.status = 'completed';
    trip.completionTime = new Date();
    await trip.save();
    res.json({ success: true, message: 'Trip completed.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/dispatch-trips/:id/cancel
router.patch('/:id/cancel', async (req, res) => {
  try {
    const trip = await DispatchTrip.findById(req.params.id);
    if (!trip) return res.status(404).json({ success: false, message: 'Not found.' });
    if (['completed', 'cancelled'].includes(trip.status)) return res.status(400).json({ success: false, message: 'Cannot cancel.' });
    trip.status = 'cancelled';
    await trip.save();
    res.json({ success: true, message: 'Trip cancelled.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
