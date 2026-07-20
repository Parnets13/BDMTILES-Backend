import { Router } from 'express';
import SalesOrder from '../models/SalesOrder.js';
import Dealer from '../models/Dealer.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/sales-orders — list with filters
router.get('/', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealer, paymentStatus, dateFrom, dateTo, salesExecutive } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ orderNumber: regex }, { dealerName: regex }, { dealerCode: regex }];
    }
    if (status) filter.status = status;
    if (dealer) filter.dealer = dealer;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (salesExecutive) filter.salesExecutive = salesExecutive;
    if (dateFrom || dateTo) {
      filter.orderDate = {};
      if (dateFrom) filter.orderDate.$gte = new Date(dateFrom);
      if (dateTo) filter.orderDate.$lte = new Date(dateTo);
    }

    const [orders, total] = await Promise.all([
      SalesOrder.find(filter)
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .populate('dealer', 'businessName dealerCode mobile city')
        .populate('salesExecutive', 'name')
        .lean(),
      SalesOrder.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/sales-orders/stats
router.get('/stats', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const [total, draft, confirmed, processing, dispatched, delivered, cancelled] = await Promise.all([
      SalesOrder.countDocuments(),
      SalesOrder.countDocuments({ status: 'draft' }),
      SalesOrder.countDocuments({ status: 'confirmed' }),
      SalesOrder.countDocuments({ status: 'processing' }),
      SalesOrder.countDocuments({ status: 'dispatched' }),
      SalesOrder.countDocuments({ status: 'delivered' }),
      SalesOrder.countDocuments({ status: 'cancelled' }),
    ]);
    // Today's sales
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayOrders = await SalesOrder.aggregate([
      { $match: { orderDate: { $gte: today }, status: { $nin: ['cancelled', 'draft'] } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    ]);
    res.json({
      success: true,
      data: { total, draft, confirmed, processing, dispatched, delivered, cancelled, todaySales: todayOrders[0]?.total || 0, todayCount: todayOrders[0]?.count || 0 },
    });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// GET /api/v1/sales-orders/:id
router.get('/:id', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const order = await SalesOrder.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode mobile city creditLimit creditDays currentOutstanding gstin address')
      .populate('salesExecutive', 'name phone')
      .populate('items.product', 'productCode itemName tileSize finish unit')
      .populate('items.warehouse', 'name')
      .lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    res.json({ success: true, data: order });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// POST /api/v1/sales-orders — create new order
router.post('/', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };

    // Auto-generate order number
    const count = await SalesOrder.countDocuments();
    data.orderNumber = `SO-${String(count + 1).padStart(5, '0')}`;

    // Fetch dealer info for denormalization
    if (data.dealer) {
      const dealer = await Dealer.findById(data.dealer).lean();
      if (dealer) {
        data.dealerName = dealer.businessName;
        data.dealerCode = dealer.dealerCode;

        // Check credit limit
        const newOutstanding = (dealer.currentOutstanding || 0) + (data.grandTotal || 0);
        if (dealer.creditLimit > 0 && newOutstanding > dealer.creditLimit) {
          data.creditLimitExceeded = true;
          data.approvalStatus = 'pending';
        }
      }
    }

    // Calculate item totals
    if (data.items && data.items.length > 0) {
      let subtotal = 0, totalDiscount = 0, totalTax = 0;
      data.items = data.items.map(item => {
        const qty = item.quantity || 0;
        const rate = item.rate || 0;
        const baseAmount = qty * rate;

        // Discount
        let discountAmt = 0;
        if (item.discountType === 'percentage') {
          discountAmt = (baseAmount * (item.discount || 0)) / 100;
        } else {
          discountAmt = (item.discount || 0) * qty;
        }

        const taxableAmount = baseAmount - discountAmt - (item.schemeDiscount || 0);
        const gstPct = item.gstPercentage || 18;
        const gstAmount = (taxableAmount * gstPct) / 100;
        const totalAmount = taxableAmount + gstAmount;

        subtotal += taxableAmount;
        totalDiscount += discountAmt;
        totalTax += gstAmount;

        return {
          ...item,
          taxableAmount: Math.round(taxableAmount * 100) / 100,
          gstAmount: Math.round(gstAmount * 100) / 100,
          cgst: Math.round((gstAmount / 2) * 100) / 100,
          sgst: Math.round((gstAmount / 2) * 100) / 100,
          totalAmount: Math.round(totalAmount * 100) / 100,
        };
      });

      data.subtotal = Math.round(subtotal * 100) / 100;
      data.totalDiscount = Math.round(totalDiscount * 100) / 100;
      data.totalTax = Math.round(totalTax * 100) / 100;
      const total = subtotal + totalTax + (data.freightCharges || 0) + (data.loadingCharges || 0) + (data.otherCharges || 0);
      data.grandTotal = Math.round(total);
      data.roundOff = data.grandTotal - total;
      data.balanceAmount = data.grandTotal - (data.advanceAmount || 0);
    }

    // Tally: mark as not_synced (will be synced when Tally module is built)
    data.tallySyncStatus = 'not_synced';

    const order = await SalesOrder.create(data);
    res.status(201).json({ success: true, message: 'Sales Order created.', data: order });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Order number exists.' });
    console.error('Create SO error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/v1/sales-orders/:id — update order
router.put('/:id', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const order = await SalesOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    // Only allow edit on draft/confirmed orders
    if (!['draft', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot edit order in "${order.status}" status.` });
    }

    // Log modification
    const changes = [];
    for (const key of Object.keys(req.body)) {
      if (JSON.stringify(order[key]) !== JSON.stringify(req.body[key])) {
        changes.push({ field: key, oldValue: order[key], newValue: req.body[key], changedBy: req.user._id, changedAt: new Date() });
      }
    }

    Object.assign(order, req.body);
    if (changes.length) order.modificationLogs.push(...changes);

    // Re-mark for Tally sync if already synced
    if (order.tallySyncStatus === 'synced') {
      order.tallySyncStatus = 'pending';
    }

    await order.save();
    res.json({ success: true, message: 'Order updated.', data: order });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// PATCH /api/v1/sales-orders/:id/status — update status only
router.patch('/:id/status', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const { status, cancellationReason } = req.body;
    const order = await SalesOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    // No hard delete on approved orders — only cancel
    if (status === 'cancelled') {
      order.status = 'cancelled';
      order.cancellationReason = cancellationReason || '';
      order.modificationLogs.push({ field: 'status', oldValue: order.status, newValue: 'cancelled', changedBy: req.user._id, reason: cancellationReason });
    } else {
      order.modificationLogs.push({ field: 'status', oldValue: order.status, newValue: status, changedBy: req.user._id });
      order.status = status;
    }

    // Tally re-sync needed on status change
    if (order.tallySyncStatus === 'synced') {
      order.tallySyncStatus = 'pending';
    }

    await order.save();
    res.json({ success: true, message: `Order status updated to "${status}".`, data: order });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// DELETE /api/v1/sales-orders/:id — only draft orders
router.delete('/:id', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const order = await SalesOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only draft orders can be deleted. Cancel approved orders instead.' });
    }
    await SalesOrder.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Draft order deleted.' });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// GET /api/v1/sales-orders/search-dealers — autocomplete for dealer selection
router.get('/search-dealers', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ success: true, data: [] });
    const regex = new RegExp(q, 'i');
    const dealers = await Dealer.find({
      status: 'active',
      $or: [{ businessName: regex }, { dealerCode: regex }, { mobile: regex }, { ownerName: regex }],
    }).limit(15).select('businessName dealerCode ownerName mobile city creditLimit creditDays currentOutstanding priceTier').lean();
    res.json({ success: true, data: dealers });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// GET /api/v1/sales-orders/search-products — autocomplete for product selection
router.get('/search-products', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { q, brand, category } = req.query;
    if (!q || q.length < 2) return res.json({ success: true, data: [] });
    const regex = new RegExp(q, 'i');
    let filter = {
      status: 'active',
      $or: [{ itemName: regex }, { productCode: regex }, { aliasName: regex }, { barcode: regex }],
    };
    if (brand) filter.brand = brand;
    if (category) filter.category = category;

    const products = await Product.find(filter)
      .limit(20)
      .select('productCode itemName tileSize finish colour unit mrp dealerRate wholesaleRate retailRate minimumSellingRate gst piecesPerBox sqftPerBox')
      .populate('brand', 'name')
      .lean();
    res.json({ success: true, data: products });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

export default router;
