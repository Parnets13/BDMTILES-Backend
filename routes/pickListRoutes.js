import { Router } from 'express';
import PickList from '../models/PickList.js';
import SalesOrder from '../models/SalesOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/pick-lists — list
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, assignedTo, priority } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ pickListNumber: regex }, { orderNumber: regex }, { dealerName: regex }];
    }
    if (status) filter.status = status;
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

// GET /api/v1/pick-lists/stats
router.get('/stats', async (req, res) => {
  try {
    const [total, generated, assigned, inProgress, picked, verified, sorted, packed, ready] = await Promise.all([
      PickList.countDocuments(),
      PickList.countDocuments({ status: 'generated' }),
      PickList.countDocuments({ status: 'assigned' }),
      PickList.countDocuments({ status: 'in_progress' }),
      PickList.countDocuments({ status: 'picked' }),
      PickList.countDocuments({ status: 'verified' }),
      PickList.countDocuments({ status: 'sorted' }),
      PickList.countDocuments({ status: 'packed' }),
      PickList.countDocuments({ status: 'ready_for_dispatch' }),
    ]);
    res.json({ success: true, data: { total, generated, assigned, inProgress, picked, verified, sorted, packed, ready } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/pick-lists/generate/:soId — generate pick list from Sales Order
router.post('/generate/:soId', async (req, res) => {
  try {
    const so = await SalesOrder.findById(req.params.soId)
      .populate('items.product', 'productCode itemName images hsnCode')
      .populate('items.warehouse', 'name')
      .lean();
    if (!so) return res.status(404).json({ success: false, message: 'Sales Order not found.' });
    if (!['confirmed', 'processing'].includes(so.status)) {
      return res.status(400).json({ success: false, message: `Cannot generate pick list for "${so.status}" order.` });
    }

    // Check if pick list already exists
    const existing = await PickList.findOne({ salesOrder: so._id }).lean();
    if (existing) return res.status(400).json({ success: false, message: `Pick list ${existing.pickListNumber} already exists for this order.` });

    const count = await PickList.countDocuments();
    const pickListNumber = `PL-${String(count + 1).padStart(5, '0')}`;

    const items = so.items.map(item => {
      const prod = item.product || {};
      return {
        product: prod._id || item.product,
        productCode: item.productCode || prod.productCode || '',
        productName: item.productName || prod.itemName || '',
        productImage: item.productImage || prod.images?.[0] || '',
        hsnCode: prod.hsnCode || '',
        shade: item.shade || '',
        batch: item.batch || '',
        requestedQty: item.quantity || 0,
        unit: item.unit || 'Box',
        warehouse: item.warehouse?._id || item.warehouse,
        warehouseName: item.warehouse?.name || '',
        rackLocation: '',
        status: 'pending',
      };
    });

    const pickList = await PickList.create({
      pickListNumber,
      salesOrder: so._id,
      orderNumber: so.orderNumber,
      dealerName: so.dealerName || so.customerName || '',
      dealerCode: so.dealerCode || '',
      items,
      priority: so.deliveryPriority || 'normal',
      deliveryAddress: so.deliveryAddress || '',
      totalItems: items.length,
      totalRequestedQty: items.reduce((s, i) => s + i.requestedQty, 0),
      createdBy: req.user._id,
    });

    // Update SO status to processing
    await SalesOrder.findByIdAndUpdate(so._id, { status: 'processing' });

    res.status(201).json({ success: true, message: `Pick list ${pickListNumber} generated.`, data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/pick-lists/:id
router.get('/:id', async (req, res) => {
  try {
    const pickList = await PickList.findById(req.params.id)
      .populate('assignedTo', 'name phone')
      .populate('sortedBy', 'name')
      .populate('packedBy', 'name')
      .populate('verifiedBy', 'name')
      .populate('salesOrder', 'orderNumber dealerName dealerCode orderDate')
      .populate('items.product', 'productCode itemName images')
      .lean();
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/pick-lists/:id/assign — assign picker
router.patch('/:id/assign', async (req, res) => {
  try {
    const { assignedTo, assignedToName } = req.body;
    const pickList = await PickList.findById(req.params.id);
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });

    pickList.assignedTo = assignedTo;
    pickList.assignedToName = assignedToName || '';
    pickList.assignedAt = new Date();
    pickList.status = 'assigned';
    await pickList.save();

    res.json({ success: true, message: 'Picker assigned.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/pick-lists/:id/start — start picking
router.patch('/:id/start', async (req, res) => {
  try {
    const pickList = await PickList.findById(req.params.id);
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });
    pickList.status = 'in_progress';
    pickList.pickingStartTime = new Date();
    await pickList.save();
    res.json({ success: true, message: 'Picking started.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/pick-lists/:id/complete-picking — mark all items picked
router.patch('/:id/complete-picking', async (req, res) => {
  try {
    const { items } = req.body;
    const pickList = await PickList.findById(req.params.id);
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });

    // Update picked quantities
    if (items?.length) {
      for (const updItem of items) {
        const existing = pickList.items.id(updItem._id);
        if (existing) {
          existing.pickedQty = updItem.pickedQty ?? existing.requestedQty;
          existing.shortQty = updItem.shortQty || 0;
          existing.damagedQty = updItem.damagedQty || 0;
          existing.barcodeVerified = updItem.barcodeVerified ?? true;
          existing.shadeConfirmed = updItem.shadeConfirmed ?? true;
          existing.batchConfirmed = updItem.batchConfirmed ?? true;
          existing.status = existing.pickedQty >= existing.requestedQty ? 'picked' : existing.shortQty > 0 ? 'short' : 'damaged';
          existing.remarks = updItem.remarks || '';
        }
      }
    } else {
      // Default: all picked in full
      pickList.items.forEach(item => {
        item.pickedQty = item.requestedQty;
        item.status = 'picked';
        item.barcodeVerified = true;
        item.shadeConfirmed = true;
        item.batchConfirmed = true;
      });
    }

    pickList.status = 'picked';
    pickList.pickingEndTime = new Date();
    pickList.totalPickedQty = pickList.items.reduce((s, i) => s + i.pickedQty, 0);
    pickList.totalShortQty = pickList.items.reduce((s, i) => s + i.shortQty, 0);
    await pickList.save();

    res.json({ success: true, message: 'Picking completed.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/pick-lists/:id/verify — supervisor verification
router.patch('/:id/verify', async (req, res) => {
  try {
    const pickList = await PickList.findById(req.params.id);
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });
    pickList.status = 'verified';
    pickList.verifiedBy = req.user._id;
    pickList.supervisorRemarks = req.body.remarks || '';
    await pickList.save();
    res.json({ success: true, message: 'Pick list verified.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/pick-lists/:id/sort — mark as sorted
router.patch('/:id/sort', async (req, res) => {
  try {
    const pickList = await PickList.findById(req.params.id);
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });
    pickList.status = 'sorted';
    pickList.sortedBy = req.user._id;
    pickList.sortingStartTime = pickList.sortingStartTime || new Date();
    pickList.sortingEndTime = new Date();
    await pickList.save();
    res.json({ success: true, message: 'Sorting completed.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/pick-lists/:id/pack — mark as packed
router.patch('/:id/pack', async (req, res) => {
  try {
    const { totalBoxes, totalWeight } = req.body;
    const pickList = await PickList.findById(req.params.id);
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });
    pickList.status = 'packed';
    pickList.packedBy = req.user._id;
    pickList.packingEndTime = new Date();
    pickList.totalBoxes = totalBoxes || 0;
    pickList.totalWeight = totalWeight || 0;
    await pickList.save();
    res.json({ success: true, message: 'Packing completed.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/pick-lists/:id/ready — mark ready for dispatch
router.patch('/:id/ready', async (req, res) => {
  try {
    const pickList = await PickList.findById(req.params.id);
    if (!pickList) return res.status(404).json({ success: false, message: 'Not found.' });
    pickList.status = 'ready_for_dispatch';
    await pickList.save();
    res.json({ success: true, message: 'Ready for dispatch.', data: pickList });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
