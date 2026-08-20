import { Router } from 'express';
import StockTransfer from '../models/StockTransfer.js';
import Warehouse from '../models/Warehouse.js';
import Stock from '../models/Stock.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/stock-transfers — list
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, fromWarehouse, toWarehouse } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ transferNumber: regex }, { fromWarehouseName: regex }, { toWarehouseName: regex }];
    }
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

    res.json({ success: true, data: transfers, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/stock-transfers/stats
router.get('/stats', async (req, res) => {
  try {
    const [total, requested, approved, dispatched, inTransit, received, completed, rejected] = await Promise.all([
      StockTransfer.countDocuments(),
      StockTransfer.countDocuments({ status: 'requested' }),
      StockTransfer.countDocuments({ status: 'approved' }),
      StockTransfer.countDocuments({ status: 'dispatched' }),
      StockTransfer.countDocuments({ status: 'in_transit' }),
      StockTransfer.countDocuments({ status: 'received' }),
      StockTransfer.countDocuments({ status: 'completed' }),
      StockTransfer.countDocuments({ status: 'rejected' }),
    ]);
    res.json({ success: true, data: { total, requested, approved, dispatched, inTransit, received, completed, rejected } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/stock-transfers/:id
router.get('/:id', async (req, res) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id)
      .populate('fromWarehouse', 'name address')
      .populate('toWarehouse', 'name address')
      .populate('requestedBy', 'name')
      .populate('approvedBy', 'name')
      .populate('dispatchedBy', 'name')
      .populate('receivedBy', 'name')
      .populate('items.product', 'productCode itemName images')
      .lean();
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: transfer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/stock-transfers — create transfer request
router.post('/', async (req, res) => {
  try {
    const data = { ...req.body, requestedBy: req.user._id };

    // Generate number
    const count = await StockTransfer.countDocuments();
    data.transferNumber = `ST-${String(count + 1).padStart(5, '0')}`;

    // Get warehouse names
    if (data.fromWarehouse) {
      const w = await Warehouse.findById(data.fromWarehouse).select('name').lean();
      if (w) data.fromWarehouseName = w.name;
    }
    if (data.toWarehouse) {
      const w = await Warehouse.findById(data.toWarehouse).select('name').lean();
      if (w) data.toWarehouseName = w.name;
    }

    // Validate same warehouse
    if (data.fromWarehouse === data.toWarehouse) {
      return res.status(400).json({ success: false, message: 'Source and destination warehouse cannot be the same.' });
    }

    // Calculate totals
    if (data.items?.length) {
      data.totalItems = data.items.length;
      data.totalRequestedQty = data.items.reduce((s, i) => s + (i.requestedQty || 0), 0);
    }

    // Validate stock availability at source warehouse
    for (const item of (data.items || [])) {
      const stock = await Stock.findOne({ product: item.product, warehouse: data.fromWarehouse }).lean();
      const available = stock?.availableQty || 0;
      if (available < item.requestedQty) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${item.productName || 'product'}. Available: ${available}, Requested: ${item.requestedQty}`,
        });
      }
    }

    const transfer = await StockTransfer.create(data);
    res.status(201).json({ success: true, message: `Transfer ${transfer.transferNumber} created.`, data: transfer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/stock-transfers/:id/approve — approve or reject
router.patch('/:id/approve', async (req, res) => {
  try {
    const { action, remarks } = req.body; // action: 'approve' or 'reject'
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found.' });
    if (transfer.status !== 'requested') return res.status(400).json({ success: false, message: `Cannot ${action} — status is "${transfer.status}".` });

    if (action === 'approve') {
      transfer.status = 'approved';
      transfer.approvedBy = req.user._id;
      transfer.approvalDate = new Date();
      transfer.approvalRemarks = remarks || '';
    } else {
      transfer.status = 'rejected';
      transfer.approvedBy = req.user._id;
      transfer.approvalDate = new Date();
      transfer.rejectionReason = remarks || '';
    }

    await transfer.save();
    res.json({ success: true, message: `Transfer ${action}d.`, data: transfer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/stock-transfers/:id/dispatch — mark as dispatched
router.patch('/:id/dispatch', async (req, res) => {
  try {
    const { vehicleNumber, driverName, driverPhone, items } = req.body;
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found.' });
    if (transfer.status !== 'approved') return res.status(400).json({ success: false, message: 'Transfer must be approved first.' });

    transfer.status = 'in_transit';
    transfer.dispatchedBy = req.user._id;
    transfer.dispatchDate = new Date();
    transfer.vehicleNumber = vehicleNumber || '';
    transfer.driverName = driverName || '';
    transfer.driverPhone = driverPhone || '';

    // Update dispatched quantities
    if (items?.length) {
      for (const updItem of items) {
        const existingItem = transfer.items.id(updItem._id);
        if (existingItem) existingItem.dispatchedQty = updItem.dispatchedQty || existingItem.requestedQty;
      }
    } else {
      // Default: dispatch all requested
      transfer.items.forEach(item => { item.dispatchedQty = item.requestedQty; });
    }
    transfer.totalDispatchedQty = transfer.items.reduce((s, i) => s + i.dispatchedQty, 0);

    // Deduct stock from source warehouse
    for (const item of transfer.items) {
      if (item.dispatchedQty > 0) {
        await Stock.findOneAndUpdate(
          { product: item.product, warehouse: transfer.fromWarehouse },
          { $inc: { availableQty: -item.dispatchedQty, reservedQty: 0 } }
        );
      }
    }

    await transfer.save();
    res.json({ success: true, message: 'Transfer dispatched.', data: transfer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/stock-transfers/:id/receive — mark as received at destination
router.patch('/:id/receive', async (req, res) => {
  try {
    const { items, remarks } = req.body;
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found.' });
    if (transfer.status !== 'in_transit') return res.status(400).json({ success: false, message: 'Transfer must be in transit.' });

    transfer.status = 'completed';
    transfer.receivedBy = req.user._id;
    transfer.receivedDate = new Date();
    transfer.receivingRemarks = remarks || '';

    // Update received quantities
    if (items?.length) {
      for (const updItem of items) {
        const existingItem = transfer.items.id(updItem._id);
        if (existingItem) {
          existingItem.receivedQty = updItem.receivedQty ?? existingItem.dispatchedQty;
          existingItem.damagedQty = updItem.damagedQty || 0;
          existingItem.shortQty = existingItem.dispatchedQty - existingItem.receivedQty - existingItem.damagedQty;
          existingItem.remarks = updItem.remarks || '';
        }
      }
    } else {
      transfer.items.forEach(item => {
        item.receivedQty = item.dispatchedQty;
        item.shortQty = 0;
        item.damagedQty = 0;
      });
    }
    transfer.totalReceivedQty = transfer.items.reduce((s, i) => s + i.receivedQty, 0);

    // Add stock to destination warehouse
    for (const item of transfer.items) {
      if (item.receivedQty > 0) {
        await Stock.findOneAndUpdate(
          { product: item.product, warehouse: transfer.toWarehouse },
          { $inc: { availableQty: item.receivedQty, totalQty: item.receivedQty } },
          { upsert: true }
        );
      }
    }

    await transfer.save();
    res.json({ success: true, message: 'Transfer received and stock updated.', data: transfer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/stock-transfers/:id/cancel
router.patch('/:id/cancel', async (req, res) => {
  try {
    const transfer = await StockTransfer.findById(req.params.id);
    if (!transfer) return res.status(404).json({ success: false, message: 'Not found.' });
    if (['completed', 'cancelled'].includes(transfer.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel — status is "${transfer.status}".` });
    }
    transfer.status = 'cancelled';
    await transfer.save();
    res.json({ success: true, message: 'Transfer cancelled.', data: transfer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
