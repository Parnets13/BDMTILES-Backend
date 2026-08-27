import { Router } from 'express';
import mongoose from 'mongoose';
import DispatchTrip from '../models/DispatchTrip.js';
import Delivery from '../models/Delivery.js';
import SalesOrder from '../models/SalesOrder.js';
import PickList from '../models/PickList.js';
import Stock from '../models/Stock.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);
router.use(requirePermission('dispatch.management'));

const terminalDeliveryStatuses = ['delivered', 'partially_delivered', 'failed'];

const stateConflict = (res, trip, expected, action) => res.status(409).json({
  success: false,
  message: `Cannot ${action} while trip is "${trip.status}". Expected "${expected}".`,
});

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ tripNumber: regex }, { vehicleNumber: regex }, { driverName: regex }, { routeName: regex }];
    }
    if (status) {
      const statuses = String(status).split(',').map(value => value.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

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

router.get('/stats', async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, planning, loading, loaded, dispatched, inTransit, completed, cancelled] = await Promise.all([
      DispatchTrip.countDocuments(scope),
      DispatchTrip.countDocuments({ ...scope, status: 'planning' }),
      DispatchTrip.countDocuments({ ...scope, status: 'loading' }),
      DispatchTrip.countDocuments({ ...scope, status: 'loaded' }),
      DispatchTrip.countDocuments({ ...scope, status: 'dispatched' }),
      DispatchTrip.countDocuments({ ...scope, status: 'in_transit' }),
      DispatchTrip.countDocuments({ ...scope, status: 'completed' }),
      DispatchTrip.countDocuments({ ...scope, status: 'cancelled' }),
    ]);
    res.json({ success: true, data: { total, planning, loading, loaded, dispatched, inTransit, completed, cancelled } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/ready-orders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const claimedSalesOrders = await DispatchTrip.distinct('orders.salesOrder', { branch: req.branchId, status: { $ne: 'cancelled' } });
    const filter = {
      branch: req.branchId,
      status: 'ready_for_dispatch',
      stockConsumedAt: null,
      dispatchTrip: null,
      cancellationProcessing: { $ne: true },
      salesOrder: { $nin: claimedSalesOrders.filter(Boolean) },
    };
    if (req.query.search) {
      const regex = new RegExp(String(req.query.search), 'i');
      filter.$or = [{ pickListNumber: regex }, { orderNumber: regex }, { dealerName: regex }, { deliveryRoute: regex }];
    }

    const [readyPickLists, total] = await Promise.all([
      PickList.find(filter)
        .sort({ priority: -1, createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('salesOrder', 'orderNumber dealerName dealerCode deliveryAddress grandTotal customerPhone')
        .select('pickListNumber orderNumber dealerName dealerCode deliveryAddress deliveryRoute totalPickedQty totalBoxes totalWeight salesOrder')
        .lean(),
      PickList.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: readyPickLists,
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, pageSize: limit },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', async (req, res) => {
  const claimedPickListIds = [];
  let tripId = null;
  try {
    const requestedPickListIds = Array.isArray(req.body.pickListIds) ? [...new Set(req.body.pickListIds.map(String))] : [];
    const requestedPickListNumbers = Array.isArray(req.body.orders)
      ? [...new Set(req.body.orders.map(order => order.pickListNumber).filter(Boolean))]
      : [];
    if (!requestedPickListIds.length && !requestedPickListNumbers.length) {
      return res.status(400).json({ success: false, message: 'Select at least one ready pick list.' });
    }
    if (!String(req.body.vehicleNumber || '').trim()) return res.status(400).json({ success: false, message: 'Vehicle number is required.' });

    const pickListSelector = requestedPickListIds.length
      ? { _id: { $in: requestedPickListIds } }
      : { pickListNumber: { $in: requestedPickListNumbers } };
    const expectedPickListCount = requestedPickListIds.length || requestedPickListNumbers.length;
    const pickLists = await PickList.find({ branch: req.branchId, ...pickListSelector, status: 'ready_for_dispatch', stockConsumedAt: null, dispatchTrip: null, cancellationProcessing: { $ne: true } })
      .populate('salesOrder', 'orderNumber dealer dealerName dealerCode customerName customerPhone deliveryAddress status')
      .lean();
    if (pickLists.length !== expectedPickListCount || pickLists.some(item => !item.salesOrder)) {
      return res.status(409).json({ success: false, message: 'Every selected pick list must still be unclaimed, ready, and linked to a sales order.' });
    }

    const orders = pickLists.map((pickList, index) => ({
      pickList: pickList._id,
      salesOrder: pickList.salesOrder._id,
      orderNumber: pickList.orderNumber || pickList.salesOrder.orderNumber,
      dealerName: pickList.dealerName || pickList.salesOrder.dealerName || pickList.salesOrder.customerName || '',
      dealerCode: pickList.dealerCode || pickList.salesOrder.dealerCode || '',
      deliveryAddress: pickList.deliveryAddress || pickList.salesOrder.deliveryAddress || '',
      contactPhone: pickList.salesOrder.customerPhone || '',
      totalBoxes: pickList.totalBoxes,
      totalWeight: pickList.totalWeight || 0,
      pickListNumber: pickList.pickListNumber,
      sequence: index + 1,
    }));

    tripId = new mongoose.Types.ObjectId();
    const tripNumber = await generateBranchNumber(req.branchId, 'dispatchTrip', new Date());
    for (const pickList of pickLists) {
      const claim = await PickList.updateOne(
        { _id: pickList._id, branch: req.branchId, status: 'ready_for_dispatch', stockConsumedAt: null, dispatchTrip: null, cancellationProcessing: { $ne: true } },
        { $set: { dispatchTrip: tripId, dispatchTripNumber: tripNumber, tripClaimedAt: new Date() } }
      );
      if (claim.modifiedCount !== 1) {
        const error = new Error(`${pickList.pickListNumber} was claimed by another planner. Refresh and retry.`);
        error.status = 409;
        throw error;
      }
      claimedPickListIds.push(pickList._id);
    }

    const trip = await DispatchTrip.create({
      _id: tripId,
      tripNumber,
      branch: req.branchId,
      vehicle: req.body.vehicle || undefined,
      vehicleNumber: String(req.body.vehicleNumber).trim(),
      vehicleType: req.body.vehicleType || '',
      vehicleCapacity: req.body.vehicleCapacity || '',
      driverName: req.body.driverName || '',
      driverPhone: req.body.driverPhone || '',
      deliveryExecutive: req.body.deliveryExecutive || undefined,
      deliveryExecutiveName: req.body.deliveryExecutiveName || '',
      routeName: req.body.routeName || '',
      estimatedDistance: Number(req.body.estimatedDistance || 0),
      estimatedTime: req.body.estimatedTime || '',
      remarks: req.body.remarks || '',
      orders,
      totalOrders: orders.length,
      totalBoxes: orders.reduce((sum, order) => sum + order.totalBoxes, 0),
      totalWeight: orders.reduce((sum, order) => sum + order.totalWeight, 0),
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: `Trip ${trip.tripNumber} created from ${orders.length} exclusively claimed pick list(s).`, data: trip });
  } catch (e) {
    if (tripId && claimedPickListIds.length) {
      await PickList.updateMany(
        { _id: { $in: claimedPickListIds }, dispatchTrip: tripId, stockConsumedAt: null },
        { $unset: { dispatchTrip: 1, tripClaimedAt: 1 }, $set: { dispatchTripNumber: '' } }
      );
    }
    const status = e.status || (e.name === 'CastError' || e.name === 'ValidationError' ? 400 : e.code === 11000 ? 409 : 500);
    res.status(status).json({ success: false, message: e.code === 11000 ? 'Trip creation conflicted with another request. Refresh and retry.' : e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const trip = await DispatchTrip.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('vehicle', 'vehicleNumber vehicleType capacity')
      .populate('deliveryExecutive', 'name phone')
      .populate('loadingSupervisor', 'name')
      .populate('orders.pickList', 'pickListNumber status totalBoxes')
      .populate('orders.salesOrder', 'orderNumber dealerName grandTotal items')
      .lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    res.json({ success: true, data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/start-loading', async (req, res) => {
  try {
    const current = await DispatchTrip.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (current.status === 'loading') return res.json({ success: true, message: 'Loading already started.', data: current });
    if (current.status !== 'planning') return stateConflict(res, current, 'planning', 'start loading');

    const trip = await DispatchTrip.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, status: 'planning' },
      { $set: { status: 'loading', loadingStartTime: new Date() } },
      { new: true, runValidators: true }
    );
    if (!trip) return res.status(409).json({ success: false, message: 'Trip changed while loading was being started. Refresh and retry.' });
    res.json({ success: true, message: 'Loading started. Verify every order before dispatch.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/verify-loading', async (req, res) => {
  try {
    const trip = await DispatchTrip.findOne({ _id: req.params.id, branch: req.branchId });
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'loaded') return res.json({ success: true, message: 'Loading already verified.', data: trip });
    if (trip.status !== 'loading') return stateConflict(res, trip, 'loading', 'verify loading');

    const submitted = req.body.orders;
    if (!Array.isArray(submitted) || submitted.length !== trip.orders.length) {
      return res.status(400).json({ success: false, message: 'Submit explicit loading verification for every trip order.' });
    }
    const submittedById = new Map(submitted.map(order => [String(order._id), order]));
    if (submittedById.size !== trip.orders.length) {
      return res.status(400).json({ success: false, message: 'Every trip order must appear exactly once.' });
    }

    for (const order of trip.orders) {
      const update = submittedById.get(String(order._id));
      const loadedBoxes = Number(update?.loadedBoxes);
      if (!update || update.loadingVerified !== true || !Number.isFinite(loadedBoxes) || loadedBoxes !== order.totalBoxes) {
        return res.status(400).json({ success: false, message: `${order.orderNumber}: confirm all ${order.totalBoxes} boxes as loaded.` });
      }
      order.loadingVerified = true;
      order.loadedBoxes = loadedBoxes;
      order.loadingRemarks = update.loadingRemarks || '';
    }

    trip.loadedBoxes = trip.orders.reduce((sum, order) => sum + order.loadedBoxes, 0);
    trip.loadingVerified = true;
    trip.loadingEndTime = new Date();
    trip.loadingSupervisor = req.user._id;
    trip.status = 'loaded';
    await trip.save();
    res.json({ success: true, message: 'Loading verified for every order. Trip is ready to dispatch.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/dispatch', async (req, res) => {
  const session = await mongoose.startSession();
  let response;
  try {
    await session.withTransaction(async () => {
      response = null;
      const current = await DispatchTrip.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) {
        response = { status: 404, body: { success: false, message: 'Trip not found.' } };
        return;
      }
      if (['dispatched', 'in_transit', 'completed'].includes(current.status) && current.stockDeductedAt) {
        response = { status: 200, body: { success: true, message: 'Trip was already dispatched; no stock was deducted again.', data: current } };
        return;
      }
      if (current.status !== 'loaded' || !current.loadingVerified || current.orders.some(order => !order.loadingVerified || order.loadedBoxes !== order.totalBoxes)) {
        response = { status: 409, body: { success: false, message: 'Dispatch requires a loaded trip with every order and box explicitly verified.' } };
        return;
      }

      const lockedTrip = await DispatchTrip.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'loaded', loadingVerified: true, dispatchProcessing: { $ne: true }, stockDeductedAt: null },
        { $set: { dispatchProcessing: true } },
        { new: true, session }
      );
      if (!lockedTrip) {
        response = { status: 409, body: { success: false, message: 'Dispatch is already being processed. Refresh before retrying.' } };
        return;
      }

      // Controlled compatibility path for trips created before PickList references were persisted.
      for (const order of lockedTrip.orders) {
        if (order.pickList) continue;
        const legacyPickList = await PickList.findOne({
          branch: req.branchId,
          status: 'ready_for_dispatch',
          stockConsumedAt: null,
          $and: [
            { $or: [{ pickListNumber: order.pickListNumber }, { salesOrder: order.salesOrder }] },
            { $or: [{ dispatchTrip: null }, { dispatchTrip: lockedTrip._id }] },
          ],
        }).session(session).lean();
        if (!legacyPickList) throw new Error(`No ready authoritative pick list could be resolved for ${order.orderNumber}. Cancel and replan this trip.`);
        order.pickList = legacyPickList._id;
      }

      const pickListIds = lockedTrip.orders.map(order => order.pickList).filter(Boolean);
      const pickLists = await PickList.find({ _id: { $in: pickListIds }, branch: req.branchId })
        .session(session)
        .populate('salesOrder', 'orderNumber dealer dealerName dealerCode customerName customerPhone deliveryAddress status')
        .lean();
      if (pickLists.length !== lockedTrip.orders.length) throw new Error('Every trip order must reference an authoritative pick list. Recreate this trip.');
      const pickListById = new Map(pickLists.map(pickList => [String(pickList._id), pickList]));

      // Claim every PickList for this dispatch before moving any stock.
      for (const pickList of pickLists) {
        const claim = await PickList.updateOne(
          {
            _id: pickList._id,
            branch: req.branchId,
            status: 'ready_for_dispatch',
            stockConsumedAt: null,
            stockConsumptionProcessing: { $ne: true },
            $or: [{ dispatchTrip: lockedTrip._id }, { dispatchTrip: null }],
          },
          {
            $set: {
              dispatchTrip: lockedTrip._id,
              dispatchTripNumber: lockedTrip.tripNumber,
              tripClaimedAt: pickList.tripClaimedAt || new Date(),
              stockConsumptionProcessing: true,
              reservationState: pickList.stockReserved ? 'consuming' : pickList.reservationState,
            },
          },
          { session }
        );
        if (claim.modifiedCount !== 1) throw new Error(`${pickList.pickListNumber} is already claimed or being consumed by another dispatch.`);
      }

      const requirements = new Map();
      for (const order of lockedTrip.orders) {
        const pickList = pickListById.get(String(order.pickList));
        if (!pickList || pickList.status !== 'ready_for_dispatch' || pickList.stockConsumedAt) {
          throw new Error(`${order.pickListNumber || order.orderNumber} is no longer ready for dispatch.`);
        }
        for (const item of pickList.items) {
          const quantity = Number(item.pickedQty);
          if (!(quantity > 0)) continue;
          if (!item.product || !item.warehouse) throw new Error(`Missing warehouse allocation for ${item.productName}.`);
          const mode = pickList.stockReserved ? 'reserved' : 'available';
          const key = [item.product, item.warehouse, item.shade || '', item.batch || '', mode].map(String).join('|');
          const existing = requirements.get(key);
          if (existing) existing.quantity += quantity;
          else requirements.set(key, {
            branch: req.branchId,
            product: item.product,
            warehouse: item.warehouse,
            shade: item.shade || '',
            batch: item.batch || '',
            productName: item.productName || item.productCode || 'item',
            quantity,
            mode,
          });
        }
      }

      for (const requirement of requirements.values()) {
        const quantityField = requirement.mode === 'reserved' ? 'reservedQty' : 'availableQty';
        const stock = await Stock.findOneAndUpdate(
          {
            branch: requirement.branch,
            product: requirement.product,
            warehouse: requirement.warehouse,
            shade: requirement.shade,
            batch: requirement.batch,
            [quantityField]: { $gte: requirement.quantity },
            totalQty: { $gte: requirement.quantity },
          },
          { $inc: { [quantityField]: -requirement.quantity, totalQty: -requirement.quantity }, $set: { lastSaleDate: new Date() } },
          { new: true, session }
        );
        if (!stock) throw new Error(`Insufficient ${requirement.mode} stock for ${requirement.productName} (shade ${requirement.shade || 'default'}, batch ${requirement.batch || 'default'}).`);
      }

      const dispatchedAt = new Date();
      for (const order of lockedTrip.orders) {
        const pickList = pickListById.get(String(order.pickList));
        const salesOrder = pickList.salesOrder;
        const unfulfilledQty = pickList.items.reduce((sum, item) => sum + Number(item.shortQty || 0) + Number(item.damagedQty || 0), 0);
        await SalesOrder.updateOne(
          { _id: salesOrder._id, branch: req.branchId },
          { $set: { status: unfulfilledQty > 0 ? 'partial_dispatch' : 'dispatched' } },
          { session }
        );
        const consumed = await PickList.updateOne(
          { _id: pickList._id, branch: req.branchId, dispatchTrip: lockedTrip._id, stockConsumedAt: null, stockConsumptionProcessing: true },
          { $set: { stockConsumedAt: dispatchedAt, stockReserved: false, stockConsumptionProcessing: false, reservationState: 'consumed' } },
          { session }
        );
        if (consumed.modifiedCount !== 1) throw new Error(`${pickList.pickListNumber} stock-consumption claim was lost.`);

        let delivery = await Delivery.findOne({ branch: req.branchId, dispatchTrip: lockedTrip._id, salesOrder: salesOrder._id }).session(session);
        if (!delivery) {
          const deliveryNumber = await generateBranchNumber(req.branchId, 'delivery', new Date());
          [delivery] = await Delivery.create([{
            deliveryNumber,
            branch: req.branchId,
            salesOrder: salesOrder._id,
            orderNumber: order.orderNumber,
            dispatchTrip: lockedTrip._id,
            tripNumber: lockedTrip.tripNumber,
            dealer: salesOrder.dealer || undefined,
            dealerName: order.dealerName,
            dealerCode: order.dealerCode,
            contactPhone: order.contactPhone || salesOrder.customerPhone || '',
            deliveryAddress: order.deliveryAddress,
            deliveryExecutive: lockedTrip.deliveryExecutive || undefined,
            deliveryExecutiveName: lockedTrip.deliveryExecutiveName || '',
            totalBoxes: order.totalBoxes,
            unfulfilledQty,
            hasFulfillmentShortage: unfulfilledQty > 0,
            otp: String(Math.floor(100000 + Math.random() * 900000)),
            status: 'in_transit',
            startTime: dispatchedAt,
            createdBy: req.user._id,
          }], { session });
        }
        order.deliveryStatus = delivery.status === 'assigned' ? 'in_transit' : delivery.status;
      }

      lockedTrip.status = 'dispatched';
      lockedTrip.dispatchTime = dispatchedAt;
      lockedTrip.stockDeductedAt = dispatchedAt;
      lockedTrip.dispatchProcessing = false;
      await lockedTrip.save({ session });
      response = {
        status: 200,
        body: { success: true, message: `Trip dispatched. Stock consumed and ${lockedTrip.orders.length} delivery record(s) linked.`, data: lockedTrip },
      };
    });

    res.status(response.status).json(response.body);
  } catch (e) {
    const status = e.message.startsWith('Insufficient') || e.message.includes('ready for dispatch') || e.message.includes('authoritative') ? 409 : 500;
    res.status(status).json({ success: false, message: e.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/complete', async (req, res) => {
  try {
    const trip = await DispatchTrip.findOne({ _id: req.params.id, branch: req.branchId });
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    if (trip.status === 'completed') return res.json({ success: true, message: 'Trip already completed.', data: trip });
    if (!['dispatched', 'in_transit'].includes(trip.status)) return stateConflict(res, trip, 'dispatched/in_transit', 'complete trip');
    if (!trip.orders.every(order => terminalDeliveryStatuses.includes(order.deliveryStatus))) {
      return res.status(409).json({ success: false, message: 'Complete or fail every linked delivery before completing the trip.' });
    }
    trip.status = 'completed';
    trip.completionTime = new Date();
    await trip.save();
    res.json({ success: true, message: 'Trip completed.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/cancel', async (req, res) => {
  try {
    const trip = await DispatchTrip.findOne({ _id: req.params.id, branch: req.branchId });
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
    const releaseTripClaims = async () => {
      const pickListIds = trip.orders.map(order => order.pickList).filter(Boolean);
      if (pickListIds.length) {
        await PickList.updateMany(
          { _id: { $in: pickListIds }, dispatchTrip: trip._id, stockConsumedAt: null },
          { $unset: { dispatchTrip: 1, tripClaimedAt: 1 }, $set: { dispatchTripNumber: '', stockConsumptionProcessing: false } }
        );
      }
    };
    if (trip.status === 'cancelled') {
      await releaseTripClaims();
      return res.json({ success: true, message: 'Trip already cancelled; pick-list claims are released.', data: trip });
    }
    if (!['planning', 'loading', 'loaded'].includes(trip.status) || trip.stockDeductedAt) {
      return res.status(409).json({ success: false, message: 'A dispatched trip cannot be cancelled because stock and deliveries have already been applied.' });
    }
    trip.status = 'cancelled';
    trip.dispatchProcessing = false;
    await trip.save();
    await releaseTripClaims();
    res.json({ success: true, message: 'Trip cancelled; its pick lists are available for replanning.', data: trip });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
