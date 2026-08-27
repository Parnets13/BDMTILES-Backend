import { Router } from 'express';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import DispatchTrip from '../models/DispatchTrip.js';
import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import DealerLedger from '../models/DealerLedger.js';
import { protect, requirePermission, requireAnyPermission, userHasPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

router.get(['/', '/stats', '/:id'], requireAnyPermission('delivery.management', 'delivery.tracking'));
router.post('/', requirePermission('delivery.assignment'));
router.patch(
  ['/:id/start', '/:id/reached', '/:id/verify-otp', '/:id/complete', '/:id/fail'],
  requirePermission('delivery.management')
);

const terminalStatuses = ['delivered', 'partially_delivered', 'failed'];
const deliveryScope = req => ({
  branch: req.branchId,
  ...(req.user.role === 'delivery_executive' ? { deliveryExecutive: req.user._id } : {}),
});
const findAccessibleDelivery = (req, id) => Delivery.findOne({ _id: id, ...deliveryScope(req) });
const safeDelivery = value => {
  const data = typeof value?.toObject === 'function' ? value.toObject() : { ...value };
  delete data.otp;
  return data;
};
const tripDeliveryStatus = status => {
  if (['in_transit', 'reached'].includes(status)) return 'in_transit';
  if (status === 'assigned') return 'pending';
  if (status === 'returned') return 'failed';
  return status;
};

const syncDispatchTrip = async (delivery, session = null) => {
  if (!delivery.dispatchTrip || !delivery.salesOrder) return;
  const updateQuery = DispatchTrip.updateOne(
    { _id: delivery.dispatchTrip, branch: delivery.branch, 'orders.salesOrder': delivery.salesOrder },
    { $set: { 'orders.$.deliveryStatus': tripDeliveryStatus(delivery.status) } }
  );
  if (session) updateQuery.session(session);
  await updateQuery;

  const tripQuery = DispatchTrip.findOne({ _id: delivery.dispatchTrip, branch: delivery.branch });
  if (session) tripQuery.session(session);
  const trip = await tripQuery;
  if (!trip) return;
  if (trip.orders.length && trip.orders.every(order => terminalStatuses.includes(order.deliveryStatus))) {
    trip.status = 'completed';
    trip.completionTime = trip.completionTime || new Date();
  } else if (trip.status === 'dispatched' && trip.orders.some(order => order.deliveryStatus === 'in_transit')) {
    trip.status = 'in_transit';
  }
  await trip.save(session ? { session } : undefined);
};

const stateConflict = (res, delivery, expected, action) => res.status(409).json({
  success: false,
  message: `Cannot ${action} while delivery is "${delivery.status}". Expected "${expected}".`,
});

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, deliveryExecutive } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    const filter = { ...deliveryScope(req) };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ deliveryNumber: regex }, { orderNumber: regex }, { dealerName: regex }, { tripNumber: regex }];
    }
    if (status) filter.status = status;
    if (deliveryExecutive && req.user.role !== 'delivery_executive') filter.deliveryExecutive = deliveryExecutive;

    const [deliveries, total] = await Promise.all([
      Delivery.find(filter).select('-otp').sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('deliveryExecutive', 'name phone')
        .lean(),
      Delivery.countDocuments(filter),
    ]);
    res.json({ success: true, data: deliveries, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const scope = deliveryScope(req);
    const [total, assigned, inTransit, delivered, partiallyDelivered, failed, rescheduled] = await Promise.all([
      Delivery.countDocuments(scope),
      Delivery.countDocuments({ ...scope, status: 'assigned' }),
      Delivery.countDocuments({ ...scope, status: 'in_transit' }),
      Delivery.countDocuments({ ...scope, status: 'delivered' }),
      Delivery.countDocuments({ ...scope, status: 'partially_delivered' }),
      Delivery.countDocuments({ ...scope, status: 'failed' }),
      Delivery.countDocuments({ ...scope, status: 'rescheduled' }),
    ]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDelivered = await Delivery.countDocuments({ ...scope, status: 'delivered', completionTime: { $gte: today } });
    res.json({ success: true, data: { total, assigned, inTransit, delivered, partiallyDelivered, failed, rescheduled, todayDelivered } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    if (!req.body.dispatchTrip || !req.body.salesOrder) {
      return res.status(400).json({ success: false, message: 'Dispatch trip and sales order are required.' });
    }
    const trip = await DispatchTrip.findOne({
      _id: req.body.dispatchTrip,
      branch: req.branchId,
      status: { $in: ['dispatched', 'in_transit'] },
      'orders.salesOrder': req.body.salesOrder,
      stockDeductedAt: { $ne: null },
    });
    if (!trip) return res.status(409).json({ success: false, message: 'Delivery can only be assigned after the linked trip is dispatched and stock is consumed.' });
    const tripOrder = trip.orders.find(order => String(order.salesOrder) === String(req.body.salesOrder));
    const salesOrder = await SalesOrder.findOne({ _id: req.body.salesOrder, branch: req.branchId }).lean();
    if (!tripOrder || !salesOrder) return res.status(404).json({ success: false, message: 'Linked trip order or sales order was not found.' });

    const existing = await Delivery.findOne({ branch: req.branchId, dispatchTrip: trip._id, salesOrder: salesOrder._id });
    if (existing) {
      existing.deliveryExecutive = req.body.deliveryExecutive || existing.deliveryExecutive;
      existing.deliveryExecutiveName = req.body.deliveryExecutiveName || existing.deliveryExecutiveName;
      await existing.save();
      return res.json({ success: true, message: `Delivery ${existing.deliveryNumber} assignment updated.`, data: safeDelivery(existing) });
    }

    const pickList = tripOrder.pickList ? await PickList.findOne({ _id: tripOrder.pickList, branch: req.branchId }).lean() : null;
    const unfulfilledQty = pickList?.items?.reduce((sum, item) => sum + Number(item.shortQty || 0) + Number(item.damagedQty || 0), 0) || 0;
    const deliveryNumber = await generateBranchNumber(req.branchId, 'delivery', new Date());
    const delivery = await Delivery.create({
      deliveryNumber,
      branch: req.branchId,
      salesOrder: salesOrder._id,
      orderNumber: tripOrder.orderNumber || salesOrder.orderNumber,
      dispatchTrip: trip._id,
      tripNumber: trip.tripNumber,
      dealer: salesOrder.dealer || undefined,
      dealerName: tripOrder.dealerName || salesOrder.dealerName || salesOrder.customerName || '',
      dealerCode: tripOrder.dealerCode || salesOrder.dealerCode || '',
      contactPhone: tripOrder.contactPhone || salesOrder.customerPhone || '',
      deliveryAddress: tripOrder.deliveryAddress || salesOrder.deliveryAddress || '',
      deliveryExecutive: req.body.deliveryExecutive || trip.deliveryExecutive || undefined,
      deliveryExecutiveName: req.body.deliveryExecutiveName || trip.deliveryExecutiveName || '',
      totalBoxes: tripOrder.totalBoxes,
      unfulfilledQty,
      hasFulfillmentShortage: unfulfilledQty > 0,
      otp: String(Math.floor(100000 + Math.random() * 900000)),
      status: 'in_transit',
      startTime: trip.dispatchTime || new Date(),
      createdBy: req.user._id,
    });
    await syncDispatchTrip(delivery);
    res.status(201).json({ success: true, message: `Delivery ${delivery.deliveryNumber} created from dispatched trip data.`, data: safeDelivery(delivery) });
  } catch (e) {
    res.status(e.code === 11000 ? 409 : 500).json({ success: false, message: e.code === 11000 ? 'A delivery already exists for this trip order.' : e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const delivery = await findAccessibleDelivery(req, req.params.id)
      .select('-otp')
      .populate('salesOrder', 'orderNumber grandTotal items')
      .populate('deliveryExecutive', 'name phone')
      .populate('dealer', 'businessName dealerCode mobile address city')
      .lean();
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found.' });
    res.json({ success: true, data: safeDelivery(delivery) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/start', async (req, res) => {
  try {
    const delivery = await findAccessibleDelivery(req, req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found.' });
    if (delivery.status === 'in_transit') return res.json({ success: true, message: 'Delivery already in transit.', data: safeDelivery(delivery) });
    if (!['assigned', 'rescheduled'].includes(delivery.status)) return stateConflict(res, delivery, 'assigned/rescheduled', 'start delivery');
    delivery.status = 'in_transit';
    delivery.startTime = new Date();
    await delivery.save();
    await syncDispatchTrip(delivery);
    res.json({ success: true, message: 'Delivery started.', data: safeDelivery(delivery) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/reached', async (req, res) => {
  try {
    const delivery = await findAccessibleDelivery(req, req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found.' });
    if (delivery.status === 'reached') return res.json({ success: true, message: 'Customer location already reached.', data: safeDelivery(delivery) });
    if (delivery.status !== 'in_transit') return stateConflict(res, delivery, 'in_transit', 'mark reached');
    delivery.status = 'reached';
    delivery.reachTime = new Date();
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) delivery.deliveryLocation = { lat, lng };
    await delivery.save();
    await syncDispatchTrip(delivery);
    res.json({ success: true, message: 'Reached customer.', data: safeDelivery(delivery) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/verify-otp', async (req, res) => {
  try {
    const delivery = await findAccessibleDelivery(req, req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found.' });
    if (delivery.otpVerified) return res.json({ success: true, message: 'OTP already verified.', data: safeDelivery(delivery) });
    if (!['in_transit', 'reached'].includes(delivery.status)) return stateConflict(res, delivery, 'in_transit/reached', 'verify OTP');
    if (!req.body.otp || delivery.otp !== String(req.body.otp)) return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    delivery.otpVerified = true;
    delivery.otpVerifiedAt = new Date();
    await delivery.save();
    res.json({ success: true, message: 'OTP verified.', data: safeDelivery(delivery) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/complete', async (req, res) => {
  const session = await mongoose.startSession();
  let response;
  try {
    await session.withTransaction(async () => {
      response = null;
      const current = await findAccessibleDelivery(req, req.params.id).session(session);
      if (!current) {
        response = { status: 404, body: { success: false, message: 'Delivery not found.' } };
        return;
      }
      if (['delivered', 'partially_delivered'].includes(current.status)) {
        if (current.salesOrder) {
          const hasDebt = current.hasFulfillmentShortage || current.status === 'partially_delivered';
          await SalesOrder.findOneAndUpdate(
            { _id: current.salesOrder, branch: current.branch },
            { status: hasDebt ? 'partial_dispatch' : 'delivered' },
            { session }
          );
        }
        await syncDispatchTrip(current, session);
        response = {
          status: 200,
          body: { success: true, message: 'Delivery already completed; no payment was recorded again.', data: safeDelivery(current) },
        };
        return;
      }
      if (!['in_transit', 'reached'].includes(current.status)) {
        response = {
          status: 409,
          body: { success: false, message: `Cannot complete delivery while delivery is "${current.status}". Expected "in_transit/reached".` },
        };
        return;
      }

      const deliveredBoxes = req.body.deliveredBoxes === undefined ? current.totalBoxes : Number(req.body.deliveredBoxes);
      const shortBoxes = Number(req.body.shortBoxes || 0);
      const damagedBoxes = Number(req.body.damagedBoxes || 0);
      if (![deliveredBoxes, shortBoxes, damagedBoxes].every(value => Number.isFinite(value) && value >= 0) ||
          Math.abs(deliveredBoxes + shortBoxes + damagedBoxes - current.totalBoxes) > 0.0001) {
        response = { status: 400, body: { success: false, message: 'Delivered + short + damaged boxes must equal the delivery total.' } };
        return;
      }
      if (req.body.paymentCollected && !userHasPermission(req.user, 'payment')) {
        response = { status: 403, body: { success: false, message: 'Payment permission is required to post a delivery collection.' } };
        return;
      }

      const claimedDelivery = await Delivery.findOneAndUpdate(
        { _id: current._id, ...deliveryScope(req), status: { $in: ['in_transit', 'reached'] }, completionProcessing: { $ne: true } },
        { $set: { completionProcessing: true } },
        { new: true, session }
      );
      if (!claimedDelivery) {
        response = { status: 409, body: { success: false, message: 'Delivery completion is already being processed. Refresh before retrying.' } };
        return;
      }

      claimedDelivery.deliveredBoxes = deliveredBoxes;
      claimedDelivery.shortBoxes = shortBoxes;
      claimedDelivery.damagedBoxes = damagedBoxes;
      claimedDelivery.podImage = req.body.podImage || '';
      claimedDelivery.podSignature = req.body.podSignature || '';
      claimedDelivery.deliveryRemarks = req.body.deliveryRemarks || '';
      claimedDelivery.completionTime = new Date();
      const lat = Number(req.body.lat);
      const lng = Number(req.body.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) claimedDelivery.deliveryLocation = { lat, lng };

      if (req.body.paymentCollected) {
        const collectedAmount = Number(req.body.collectedAmount || 0);
        if (!(collectedAmount > 0) || !claimedDelivery.dealer) {
          const error = new Error('A positive collection amount and dealer are required.');
          error.status = 400;
          throw error;
        }

        const Dealer = (await import('../models/Dealer.js')).default;
        const salesOrder = await SalesOrder.findById(claimedDelivery.salesOrder).session(session).lean();
        const dealer = await Dealer.findById(claimedDelivery.dealer).session(session).lean();
        const [branchLedger] = await DealerLedger.aggregate([
          { $match: { branch: claimedDelivery.branch, dealer: claimedDelivery.dealer } },
          { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
        ]).session(session);
        const orderBalance = Number(salesOrder?.balanceAmount ?? salesOrder?.grandTotal ?? 0);
        const dealerOutstanding = Number((branchLedger?.debit || 0) - (branchLedger?.credit || 0));
        const receivableLimit = Math.min(orderBalance, dealerOutstanding);
        if (!(orderBalance > 0) || !(dealerOutstanding > 0)) {
          const error = new Error('This Sales Order or dealer has no collectible outstanding balance.');
          error.status = 409;
          throw error;
        }
        if (collectedAmount > receivableLimit) {
          const error = new Error(`Collection cannot exceed the authoritative outstanding amount of ${receivableLimit}.`);
          error.status = 409;
          throw error;
        }

        const paymentMode = req.body.paymentMode || 'cash';
        if (!['cash', 'cheque', 'upi', 'bank_transfer'].includes(paymentMode)) {
          const error = new Error('Unsupported payment mode.');
          error.status = 400;
          throw error;
        }
        const paymentModeForLedger = paymentMode === 'bank_transfer' ? 'neft' : paymentMode;
        claimedDelivery.paymentCollected = true;
        claimedDelivery.collectedAmount = collectedAmount;
        claimedDelivery.paymentMode = paymentMode;
        claimedDelivery.chequeNumber = req.body.chequeNumber || '';
        claimedDelivery.utrNumber = req.body.utrNumber || '';

        const Payment = (await import('../models/Payment.js')).default;
        const paymentNumber = await generateBranchNumber(req.branchId, 'payment', new Date());
        const [payment] = await Payment.create([{
          paymentNumber,
          branch: claimedDelivery.branch,
          sourceKey: `delivery:${claimedDelivery._id}`,
          paymentType: 'dealer_receipt',
          dealer: claimedDelivery.dealer,
          againstOrders: [{
            order: claimedDelivery.salesOrder,
            orderModel: 'SalesOrder',
            orderNumber: claimedDelivery.orderNumber,
            allocatedAmount: collectedAmount,
          }],
          amount: collectedAmount,
          paymentMode: paymentModeForLedger,
          paymentDate: new Date(),
          status: 'confirmed',
          remarks: `Collected at delivery ${claimedDelivery.deliveryNumber}`,
          chequeNumber: claimedDelivery.chequeNumber,
          transactionRef: claimedDelivery.utrNumber || claimedDelivery.chequeNumber || claimedDelivery.deliveryNumber,
          tallySyncStatus: 'not_synced',
          createdBy: req.user._id,
        }], { session });

        await postSubledgerEntry({
          session,
          branch: claimedDelivery.branch,
          partyType: 'dealer',
          partyId: claimedDelivery.dealer,
          amount: collectedAmount,
          side: 'credit',
          postingKey: `payment:${payment._id}:confirmed`,
          entryType: 'payment',
          entryDate: payment.paymentDate,
          description: `Dealer receipt ${payment.paymentNumber} collected at delivery ${claimedDelivery.deliveryNumber}`,
          referenceNumber: payment.paymentNumber,
          referenceModel: 'Payment',
          referenceId: payment._id,
          createdBy: req.user._id,
        });

        const updatedSalesOrder = await SalesOrder.findOneAndUpdate(
          { _id: claimedDelivery.salesOrder, branch: claimedDelivery.branch, balanceAmount: { $gte: collectedAmount } },
          [
            {
              $set: {
                balanceAmount: { $subtract: ['$balanceAmount', collectedAmount] },
                advanceAmount: { $add: [{ $ifNull: ['$advanceAmount', 0] }, collectedAmount] },
              },
            },
            {
              $set: {
                paymentStatus: { $cond: [{ $lte: ['$balanceAmount', 0] }, 'paid', 'partial'] },
              },
            },
          ],
          { new: true, session }
        );
        if (!updatedSalesOrder) {
          const error = new Error('Sales Order balance changed while collection was being posted. Refresh and retry.');
          error.status = 409;
          throw error;
        }
      }

      claimedDelivery.status = shortBoxes > 0 || damagedBoxes > 0 ? 'partially_delivered' : 'delivered';
      claimedDelivery.completionProcessing = false;
      await claimedDelivery.save({ session });
      if (claimedDelivery.salesOrder) {
        const hasDebt = claimedDelivery.hasFulfillmentShortage || claimedDelivery.status === 'partially_delivered';
        await SalesOrder.findByIdAndUpdate(
          claimedDelivery.salesOrder,
          { status: hasDebt ? 'partial_dispatch' : 'delivered' },
          { session }
        );
      }
      await syncDispatchTrip(claimedDelivery, session);
      response = {
        status: 200,
        body: {
          success: true,
          message: `Delivery ${claimedDelivery.status === 'delivered' ? 'completed' : 'partially completed'}.`,
          data: safeDelivery(claimedDelivery),
        },
      };
    });

    res.status(response.status).json(response.body);
  } catch (e) {
    res.status(e.status || (e.code === 11000 ? 409 : 500)).json({ success: false, message: e.code === 11000 ? 'This delivery collection was already posted.' : e.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/fail', async (req, res) => {
  try {
    const delivery = await findAccessibleDelivery(req, req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found.' });
    const targetStatus = req.body.rescheduleDate ? 'rescheduled' : 'failed';
    if (delivery.status === targetStatus) return res.json({ success: true, message: `Delivery already ${targetStatus}.`, data: safeDelivery(delivery) });
    if (!['assigned', 'in_transit', 'reached', 'rescheduled'].includes(delivery.status)) {
      return res.status(409).json({ success: false, message: `Cannot fail a ${delivery.status} delivery.` });
    }
    delivery.status = targetStatus;
    delivery.failureReason = req.body.failureReason || 'other';
    delivery.failureRemarks = req.body.failureRemarks || '';
    delivery.rescheduleDate = req.body.rescheduleDate || null;
    delivery.completionTime = targetStatus === 'failed' ? new Date() : undefined;
    await delivery.save();
    await syncDispatchTrip(delivery);
    res.json({ success: true, message: `Delivery ${delivery.status}.`, data: safeDelivery(delivery) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
