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

// GET /api/v1/sales-orders/search-dealers — autocomplete for dealer selection (paginated)
router.get('/search-dealers', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { q, page = 1, limit = 20, pricingTier } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(50, parseInt(limit) || 20);

    let filter = { status: 'active' };
    if (q && q.length >= 2) {
      const regex = new RegExp(q, 'i');
      filter.$or = [{ businessName: regex }, { dealerCode: regex }, { mobile: regex }, { ownerName: regex }];
    }

    // Filter by pricingTier (dealer type's rate tier)
    if (pricingTier) {
      const DealerType = (await import('../models/DealerType.js')).default;
      const matchingTypes = await DealerType.find({ pricingTier, status: 'active' }).select('_id').lean();
      const typeIds = matchingTypes.map(t => t._id);
      if (typeIds.length > 0) {
        filter.dealerType = { $in: typeIds };
      } else {
        return res.json({ success: true, data: [] });
      }
    }

    const dealers = await Dealer.find(filter)
      .sort({ businessName: 1 })
      .skip((p - 1) * l)
      .limit(l)
      .select('businessName dealerCode ownerName mobile city creditLimit creditDays currentOutstanding priceTier dealerType')
      .populate('dealerType', 'name pricingTier')
      .lean();
    res.json({ success: true, data: dealers });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// GET /api/v1/sales-orders/search-products — autocomplete for product selection (paginated)
router.get('/search-products', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { q, brand, category, page = 1, limit = 20, dealerType = 'dealer' } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(50, parseInt(limit) || 20);
    
    let filter = { status: 'active' };
    if (q && q.length >= 2) {
      const regex = new RegExp(q, 'i');
      filter.$or = [{ itemName: regex }, { productCode: regex }, { aliasName: regex }, { barcode: regex }];
    }
    if (brand) filter.brand = brand;
    if (category) filter.category = category;

    const products = await Product.find(filter)
      .sort({ itemName: 1 })
      .skip((p - 1) * l)
      .limit(l)
      .select('productCode itemName tileSize finish colour unit mrp dealerRate wholesaleRate retailRate distributorRate builderRate projectRate minimumSellingRate gst piecesPerBox sqftPerBox basicPrice excessPrice images brand category subcategory')
      .populate('brand', 'name')
      .lean();

    // Attach live stock qty
    const Stock = (await import('../models/Stock.js')).default;
    const productIds = products.map(pr => pr._id);
    const stockData = await Stock.aggregate([
      { $match: { product: { $in: productIds } } },
      { $group: { _id: '$product', availableQty: { $sum: '$availableQty' } } },
    ]);
    const stockMap = {};
    stockData.forEach(s => { stockMap[String(s._id)] = s; });

    // Resolve applicable discounts for all products in batch
    const DiscountMapping = (await import('../models/DiscountMapping.js')).default;
    const discountMap = await DiscountMapping.bulkResolveDiscounts(products, dealerType);

    // Rate key based on dealer type
    const RATE_KEY = {
      dealer: 'dealerRate', wholesaler: 'wholesaleRate', retail: 'retailRate',
      distributor: 'distributorRate', builder: 'builderRate',
    };
    const rateField = RATE_KEY[dealerType] || 'dealerRate';

    const enriched = products.map(pr => {
      const baseRate = pr[rateField] || pr.dealerRate || pr.mrp || 0;
      const rule = discountMap[String(pr._id)];
      let discountInfo = null;

      if (rule) {
        let discountAmt = 0;
        if (rule.discountType === 'slab') {
          // For search results, show the first slab's discount as preview (qty=1)
          const firstSlab = (rule.slabs || []).find(s => 1 >= s.minQty && (s.maxQty === 0 || 1 <= s.maxQty));
          if (firstSlab) {
            if (firstSlab.discountPercentage > 0) discountAmt += (baseRate * firstSlab.discountPercentage) / 100;
            if (firstSlab.discountFlat > 0) discountAmt += firstSlab.discountFlat;
          }
        } else {
          if (rule.discountType === 'percentage' || rule.discountType === 'both') {
            discountAmt += (baseRate * rule.discountPercentage) / 100;
          }
          if (rule.discountType === 'flat' || rule.discountType === 'both') {
            discountAmt += rule.discountFlat;
          }
        }
        const maxAmt = (baseRate * rule.maxDiscountPercentage) / 100;
        discountAmt = Math.min(discountAmt, maxAmt);

        discountInfo = {
          ruleId: rule._id,
          ruleName: rule.ruleName,
          targetType: rule.targetType,
          targetName: rule.targetName,
          discountType: rule.discountType,
          discountPercentage: rule.discountPercentage,
          discountFlat: rule.discountFlat,
          slabs: rule.slabs || [],
          discountAmount: Math.round(discountAmt * 100) / 100,
          effectiveRate: Math.round(Math.max(0, baseRate - discountAmt) * 100) / 100,
        };
      }

      return {
        ...pr,
        stockAvailable: stockMap[String(pr._id)]?.availableQty || 0,
        discount: discountInfo,
      };
    });

    res.json({ success: true, data: enriched });
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

    // Auto-generate order number (checks recycle bin too)
    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    data.orderNumber = await generateUniqueCode(SalesOrder, 'orderNumber', 'SO-', 5);

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
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(SalesOrder, req.params.id, {
      user: req.user,
      module: 'sales_order',
      titleField: 'dealerName',
      codeField: 'orderNumber',
    });
    res.status(result.status || 200).json(result);
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

export default router;
