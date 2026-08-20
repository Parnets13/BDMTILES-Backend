import { Router } from 'express';
import Delivery from '../models/Delivery.js';
import SalesOrder from '../models/SalesOrder.js';
import { protect } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/deliveries — list
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, deliveryExecutive } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ deliveryNumber: regex }, { orderNumber: regex }, { dealerName: regex }, { tripNumber: regex }];
    }
    if (status) filter.status = status;
    if (deliveryExecutive) filter.deliveryExecutive = deliveryExecutive;

    const [deliveries, total] = await Promise.all([
      Delivery.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('deliveryExecutive', 'name phone')
        .lean(),
      Delivery.countDocuments(filter),
    ]);

    res.json({ success: true, data: deliveries, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/deliveries/stats
router.get('/stats', async (req, res) => {
  try {
    const [total, assigned, inTransit, delivered, partiallyDelivered, failed, rescheduled] = await Promise.all([
      Delivery.countDocuments(),
      Delivery.countDocuments({ status: 'assigned' }),
      Delivery.countDocuments({ status: 'in_transit' }),
      Delivery.countDocuments({ status: 'delivered' }),
      Delivery.countDocuments({ status: 'partially_delivered' }),
      Delivery.countDocuments({ status: 'failed' }),
      Delivery.countDocuments({ status: 'rescheduled' }),
    ]);
    // Today's deliveries
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayDelivered = await Delivery.countDocuments({ status: 'delivered', completionTime: { $gte: today } });
    res.json({ success: true, data: { total, assigned, inTransit, delivered, partiallyDelivered, failed, rescheduled, todayDelivered } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/deliveries — create delivery record (usually from dispatch trip)
router.post('/', async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Delivery.countDocuments();
    data.deliveryNumber = `DLV-${String(count + 1).padStart(5, '0')}`;

    // Generate OTP (6 digit)
    data.otp = String(Math.floor(100000 + Math.random() * 900000));

    const delivery = await Delivery.create(data);
    res.status(201).json({ success: true, message: `Delivery ${delivery.deliveryNumber} created. OTP: ${delivery.otp}`, data: delivery });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/deliveries/:id
router.get('/:id', async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id)
      .populate('salesOrder', 'orderNumber grandTotal items')
      .populate('deliveryExecutive', 'name phone')
      .populate('dealer', 'businessName dealerCode mobile address city')
      .lean();
    if (!delivery) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: delivery });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/deliveries/:id/start — start delivery (in transit)
router.patch('/:id/start', async (req, res) => {
  try {
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Not found.' });
    delivery.status = 'in_transit';
    delivery.startTime = new Date();
    await delivery.save();
    res.json({ success: true, message: 'Delivery started.', data: delivery });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/deliveries/:id/reached — reached customer location
router.patch('/:id/reached', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Not found.' });
    delivery.status = 'reached';
    delivery.reachTime = new Date();
    if (lat && lng) delivery.deliveryLocation = { lat, lng };
    await delivery.save();
    res.json({ success: true, message: 'Reached customer.', data: delivery });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/deliveries/:id/verify-otp
router.patch('/:id/verify-otp', async (req, res) => {
  try {
    const { otp } = req.body;
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Not found.' });
    if (delivery.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    delivery.otpVerified = true;
    delivery.otpVerifiedAt = new Date();
    await delivery.save();
    res.json({ success: true, message: 'OTP verified.', data: delivery });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/deliveries/:id/complete — mark delivered
router.patch('/:id/complete', async (req, res) => {
  try {
    const { deliveredBoxes, shortBoxes, damagedBoxes, podImage, podSignature, deliveryRemarks, paymentCollected, collectedAmount, paymentMode, chequeNumber, utrNumber, lat, lng } = req.body;
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Not found.' });

    delivery.deliveredBoxes = deliveredBoxes ?? delivery.totalBoxes;
    delivery.shortBoxes = shortBoxes || 0;
    delivery.damagedBoxes = damagedBoxes || 0;
    delivery.podImage = podImage || '';
    delivery.podSignature = podSignature || '';
    delivery.deliveryRemarks = deliveryRemarks || '';
    delivery.completionTime = new Date();
    if (lat && lng) delivery.deliveryLocation = { lat, lng };

    // Payment
    if (paymentCollected) {
      delivery.paymentCollected = true;
      delivery.collectedAmount = collectedAmount || 0;
      delivery.paymentMode = paymentMode || 'cash';
      delivery.chequeNumber = chequeNumber || '';
      delivery.utrNumber = utrNumber || '';
    }

    // Status
    if (delivery.shortBoxes > 0 || delivery.damagedBoxes > 0) {
      delivery.status = 'partially_delivered';
    } else {
      delivery.status = 'delivered';
    }

    // Update SO status
    if (delivery.salesOrder) {
      await SalesOrder.findByIdAndUpdate(delivery.salesOrder, { status: 'delivered' });
    }

    await delivery.save();
    res.json({ success: true, message: `Delivery ${delivery.status === 'delivered' ? 'completed' : 'partially completed'}.`, data: delivery });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/deliveries/:id/fail — mark as failed
router.patch('/:id/fail', async (req, res) => {
  try {
    const { failureReason, failureRemarks, rescheduleDate } = req.body;
    const delivery = await Delivery.findById(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Not found.' });

    delivery.status = rescheduleDate ? 'rescheduled' : 'failed';
    delivery.failureReason = failureReason || 'other';
    delivery.failureRemarks = failureRemarks || '';
    delivery.rescheduleDate = rescheduleDate || null;
    delivery.completionTime = new Date();

    await delivery.save();
    res.json({ success: true, message: `Delivery ${delivery.status}.`, data: delivery });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
