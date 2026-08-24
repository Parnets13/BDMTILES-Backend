import { Router } from 'express';
import PurchaseOrder from '../models/PurchaseOrder.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import Supplier from '../models/Supplier.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ═══════════════════════════════════════
// PURCHASE ORDERS
// ═══════════════════════════════════════
router.get('/purchase-orders', requirePermission('po.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ poNumber: r }, { supplierName: r }]; }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const [orders, total] = await Promise.all([
      PurchaseOrder.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).populate('supplier', 'companyName supplierCode').lean(),
      PurchaseOrder.countDocuments(filter),
    ]);
    res.json({ success: true, data: orders, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/purchase-orders/stats', requirePermission('po.management'), async (req, res) => {
  try {
    const [total, draft, approved, received, cancelled] = await Promise.all([
      PurchaseOrder.countDocuments(), PurchaseOrder.countDocuments({ status: 'draft' }),
      PurchaseOrder.countDocuments({ status: 'approved' }), PurchaseOrder.countDocuments({ status: 'received' }),
      PurchaseOrder.countDocuments({ status: 'cancelled' }),
    ]);
    res.json({ success: true, data: { total, draft, approved, received, cancelled } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/purchase-orders/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id).populate('supplier', 'companyName supplierCode mobile').populate('items.product', 'productCode itemName').lean();
    if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
    res.json({ success: true, data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/purchase-orders', requirePermission('po.management'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await PurchaseOrder.countDocuments();
    data.poNumber = `PO-${String(count + 1).padStart(5, '0')}`;

    // Validate purchase rate against max (basicPrice + excessPrice)
    if (data.items?.length) {
      const rateWarnings = [];
      for (const item of data.items) {
        if (item.product) {
          const prod = await Product.findById(item.product).select('basicPrice excessPrice maxPurchaseRate itemName productCode').lean();
          if (prod && prod.maxPurchaseRate > 0 && item.rate > prod.maxPurchaseRate) {
            rateWarnings.push(`${prod.productCode || prod.itemName}: Rate ₹${item.rate} exceeds max ₹${prod.maxPurchaseRate} (Basic ₹${prod.basicPrice} + Excess ₹${prod.excessPrice})`);
          }
        }
      }
      if (rateWarnings.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Purchase rate exceeds allowed maximum for some items.',
          data: { warnings: rateWarnings },
        });
      }
    }

    // Calc totals
    if (data.items?.length) {
      let subtotal = 0, totalTax = 0;
      data.items = data.items.map(item => {
        const base = item.quantity * item.rate;
        const disc = item.discount || 0;
        const taxable = base - disc;
        const gst = (taxable * (item.gstPercentage || 18)) / 100;
        subtotal += taxable; totalTax += gst;
        return { ...item, gstAmount: gst, totalAmount: taxable + gst, pendingQty: item.quantity };
      });
      data.subtotal = subtotal; data.totalTax = totalTax;
      data.grandTotal = Math.round(subtotal + totalTax + (data.freight || 0) + (data.loading || 0) + (data.insurance || 0));
    }
    if (data.supplier) {
      const sup = await Supplier.findById(data.supplier).lean();
      if (sup) data.supplierName = sup.companyName;
    }
    data.tallySyncStatus = 'not_synced';
    const po = await PurchaseOrder.create(data);
    res.status(201).json({ success: true, message: 'Purchase Order created.', data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/purchase-orders/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!po) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'PO updated.', data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/purchase-orders/:id/status', requirePermission('po.management'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    res.json({ success: true, message: `Status updated to ${req.body.status}.`, data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/purchase-orders/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(PurchaseOrder, req.params.id, { user: req.user, module: 'purchase', titleField: 'supplierName', codeField: 'poNumber' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// GRN (Goods Receipt Note)
// ═══════════════════════════════════════
router.get('/grn', requirePermission('grn.entry'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ grnNumber: r }, { supplierName: r }, { poNumber: r }]; }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const [grns, total] = await Promise.all([
      GRN.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).populate('supplier', 'companyName').lean(),
      GRN.countDocuments(filter),
    ]);
    res.json({ success: true, data: grns, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Get approved POs for GRN creation — MUST be before /grn/:id to avoid route conflict
router.get('/grn/available-pos', requirePermission('grn.entry'), async (req, res) => {
  try {
    const pos = await PurchaseOrder.find({ status: { $in: ['approved', 'sent', 'partial_received'] } })
      .select('poNumber supplierName poDate items grandTotal status').populate('supplier', 'companyName').lean();
    res.json({ success: true, data: pos });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/grn/:id', requirePermission('grn.entry'), async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id).populate('supplier', 'companyName').populate('items.product', 'productCode itemName').populate('items.warehouse', 'name').lean();
    if (!grn) return res.status(404).json({ success: false, message: 'GRN not found.' });
    res.json({ success: true, data: grn });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/grn', requirePermission('grn.entry'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await GRN.countDocuments();
    data.grnNumber = `GRN-${String(count + 1).padStart(5, '0')}`;
    if (data.supplier) {
      const sup = await Supplier.findById(data.supplier).lean();
      if (sup) data.supplierName = sup.companyName;
    }
    data.tallySyncStatus = 'not_synced';
    const grn = await GRN.create(data);

    // Auto-update stock when GRN is posted/approved
    if (data.status === 'approved' || data.status === 'posted') {
      await updateStockFromGRN(grn);
    }

    // Update PO received quantities
    if (data.purchaseOrder) {
      await updatePOReceivedQty(data.purchaseOrder, data.items);
    }

    res.status(201).json({ success: true, message: 'GRN created.', data: grn });
  } catch (e) { console.error('GRN create error:', e.message); res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/grn/:id/approve', requirePermission('grn.entry'), async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id);
    if (!grn) return res.status(404).json({ success: false, message: 'Not found.' });
    grn.status = 'approved';
    await grn.save();
    // Update stock
    await updateStockFromGRN(grn);
    // Increment supplier outstanding (they now owe us goods = we owe them money)
    if (grn.supplier) {
      const totalGRNValue = grn.items.reduce((sum, item) => sum + ((item.acceptedQty || 0) * (item.rate || 0)), 0);
      await Supplier.findByIdAndUpdate(grn.supplier, { $inc: { currentOutstanding: totalGRNValue } });
    }
    res.json({ success: true, message: 'GRN approved. Stock updated.', data: grn });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Helper: Update stock from GRN items
async function updateStockFromGRN(grn) {
  for (const item of grn.items) {
    if (item.acceptedQty <= 0) continue;
    await Stock.findOneAndUpdate(
      { product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '' },
      {
        $inc: { totalQty: item.acceptedQty, availableQty: item.acceptedQty },
        $set: { zone: item.zone || '', rack: item.rack || '', bin: item.bin || '', purchaseRate: item.rate || 0, lastGRNDate: new Date() },
      },
      { upsert: true, new: true }
    );
  }
}

// Helper: Update PO received quantities
async function updatePOReceivedQty(poId, grnItems) {
  const po = await PurchaseOrder.findById(poId);
  if (!po) return;
  for (const grnItem of grnItems) {
    const poItem = po.items.find(i => i.product?.toString() === grnItem.product?.toString());
    if (poItem) {
      poItem.receivedQty = (poItem.receivedQty || 0) + (grnItem.acceptedQty || grnItem.receivedQty || 0);
      poItem.pendingQty = Math.max(0, poItem.quantity - poItem.receivedQty);
    }
  }
  // Update PO status
  const allReceived = po.items.every(i => i.pendingQty <= 0);
  const someReceived = po.items.some(i => i.receivedQty > 0);
  if (allReceived) po.status = 'received';
  else if (someReceived) po.status = 'partial_received';
  await po.save();
}

// ═══════════════════════════════════════
// STOCK
// ═══════════════════════════════════════
router.get('/stock', requirePermission('stock.view'), async (req, res) => {
  try {
    const { page = 1, limit = 50, product, warehouse, shade, batch, search } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(200, parseInt(limit) || 50);
    let filter = {};
    if (product) filter.product = product;
    if (warehouse) filter.warehouse = warehouse;
    if (shade) filter.shade = shade;
    if (batch) filter.batch = batch;
    if (search) {
      // Search requires joining with product — use aggregate or filter after
      // For now, filter by product lookup
    }
    const [stocks, total] = await Promise.all([
      Stock.find(filter).sort({ updatedAt: -1 }).skip((p-1)*l).limit(l)
        .populate('product', 'productCode itemName tileSize finish brand')
        .populate('warehouse', 'name')
        .lean(),
      Stock.countDocuments(filter),
    ]);
    res.json({ success: true, data: stocks, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/stock/summary', requirePermission('stock.view'), async (req, res) => {
  try {
    const summary = await Stock.aggregate([
      { $group: { _id: null, totalQty: { $sum: '$totalQty' }, availableQty: { $sum: '$availableQty' }, reservedQty: { $sum: '$reservedQty' }, damagedQty: { $sum: '$damagedQty' }, totalValue: { $sum: { $multiply: ['$availableQty', '$purchaseRate'] } } } },
    ]);
    const productCount = await Stock.distinct('product');
    res.json({ success: true, data: { ...(summary[0] || {}), uniqueProducts: productCount.length } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Stock adjustment (manual — with audit reason)
router.post('/stock/adjust', requirePermission('stock.adjustment'), async (req, res) => {
  try {
    const { product, warehouse, shade, batch, adjustmentQty, reason, type } = req.body;
    if (!product || !warehouse || !adjustmentQty) {
      return res.status(400).json({ success: false, message: 'Product, warehouse, and quantity required.' });
    }
    const stock = await Stock.findOneAndUpdate(
      { product, warehouse, shade: shade || '', batch: batch || '' },
      { $inc: { totalQty: adjustmentQty, availableQty: adjustmentQty } },
      { upsert: true, new: true }
    );
    // TODO: Log this adjustment in audit trail
    res.json({ success: true, message: `Stock adjusted by ${adjustmentQty}.`, data: stock });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Stock transfer between warehouses
router.post('/stock/transfer', requirePermission('stock.transfer'), async (req, res) => {
  try {
    const { product, fromWarehouse, toWarehouse, shade, batch, quantity, reason } = req.body;
    if (!product || !fromWarehouse || !toWarehouse || !quantity) {
      return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    // Deduct from source
    const source = await Stock.findOneAndUpdate(
      { product, warehouse: fromWarehouse, shade: shade || '', batch: batch || '', availableQty: { $gte: quantity } },
      { $inc: { totalQty: -quantity, availableQty: -quantity } },
      { new: true }
    );
    if (!source) return res.status(400).json({ success: false, message: 'Insufficient stock in source warehouse.' });
    // Add to destination
    await Stock.findOneAndUpdate(
      { product, warehouse: toWarehouse, shade: shade || '', batch: batch || '' },
      { $inc: { totalQty: quantity, availableQty: quantity } },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: `${quantity} units transferred.` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// STOCK ALERTS (Low Stock)
// ═══════════════════════════════════════
router.get('/stock/alerts', requirePermission('stock.view'), async (req, res) => {
  try {
    const { threshold = 10, warehouse } = req.query;
    const minQty = parseInt(threshold) || 10;
    let filter = { availableQty: { $lte: minQty, $gte: 0 } };
    if (warehouse) filter.warehouse = warehouse;

    const lowStockItems = await Stock.find(filter)
      .sort({ availableQty: 1 })
      .limit(100)
      .populate('product', 'productCode itemName tileSize images mrp reorderLevel')
      .populate('warehouse', 'name')
      .lean();

    // Also find zero-stock items
    const zeroStock = await Stock.countDocuments({ ...filter, availableQty: 0 });
    const criticalStock = await Stock.countDocuments({ ...filter, availableQty: { $lte: 5, $gte: 1 } });

    res.json({
      success: true,
      data: {
        items: lowStockItems,
        summary: { total: lowStockItems.length, zeroStock, criticalStock, threshold: minQty },
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// PHYSICAL AUDIT (Stock Count)
// ═══════════════════════════════════════

// GET /api/v1/purchase/audit/pending — get products to audit for a warehouse
router.get('/audit/pending', requirePermission('stock.adjustment'), async (req, res) => {
  try {
    const { warehouse } = req.query;
    if (!warehouse) return res.status(400).json({ success: false, message: 'Warehouse is required.' });

    const stocks = await Stock.find({ warehouse, availableQty: { $gt: 0 } })
      .populate('product', 'productCode itemName tileSize images brand')
      .populate('warehouse', 'name')
      .sort({ 'product.itemName': 1 })
      .lean();

    res.json({ success: true, data: stocks });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/purchase/audit/submit — submit physical count and calculate discrepancy
router.post('/audit/submit', requirePermission('stock.adjustment'), async (req, res) => {
  try {
    const { warehouse, counts, auditedBy, remarks } = req.body;
    // counts: [{ stockId, physicalCount }]
    if (!warehouse || !counts?.length) {
      return res.status(400).json({ success: false, message: 'Warehouse and counts required.' });
    }

    const results = [];
    let totalDiscrepancy = 0;
    let adjustedCount = 0;

    for (const count of counts) {
      const stock = await Stock.findById(count.stockId);
      if (!stock) continue;

      const systemQty = stock.availableQty;
      const physicalQty = parseInt(count.physicalCount) || 0;
      const discrepancy = physicalQty - systemQty;

      if (discrepancy !== 0) {
        // Auto-adjust stock to match physical count
        stock.availableQty = physicalQty;
        stock.totalQty = stock.totalQty + discrepancy;
        await stock.save();
        adjustedCount++;
        totalDiscrepancy += Math.abs(discrepancy);
      }

      results.push({
        stockId: stock._id,
        product: stock.product,
        systemQty,
        physicalQty,
        discrepancy,
        adjusted: discrepancy !== 0,
      });
    }

    res.json({
      success: true,
      message: `Audit complete. ${adjustedCount} items adjusted. Total discrepancy: ${totalDiscrepancy} units.`,
      data: {
        totalItems: counts.length,
        adjustedItems: adjustedCount,
        totalDiscrepancy,
        results,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// REORDER SUGGESTIONS (Out-of-stock → PO)
// ═══════════════════════════════════════

// GET /api/v1/purchase/stock/reorder-suggestions — products below reorder level with suggested PO
router.get('/stock/reorder-suggestions', requirePermission('stock.view'), async (req, res) => {
  try {
    const { warehouse } = req.query;

    // 1. Get all products with reorderLevel > 0
    const products = await Product.find({ reorderLevel: { $gt: 0 }, status: 'active' })
      .select('productCode itemName brand category tileSize reorderLevel minStockLevel images basicPrice')
      .populate('brand', 'name')
      .lean();

    if (!products.length) return res.json({ success: true, data: [] });

    // 2. Get current stock per product (aggregated across all warehouses or specific)
    const stockFilter = warehouse ? { warehouse } : {};
    const stockAgg = await Stock.aggregate([
      { $match: stockFilter },
      { $group: { _id: '$product', currentStock: { $sum: '$availableQty' }, lastRate: { $max: '$purchaseRate' } } },
    ]);
    const stockMap = {};
    stockAgg.forEach(s => { stockMap[String(s._id)] = s; });

    // 3. Find products below reorder level
    const suggestions = [];
    for (const prod of products) {
      const stock = stockMap[String(prod._id)] || { currentStock: 0, lastRate: 0 };
      if (stock.currentStock <= prod.reorderLevel) {
        // Suggested quantity = reorderLevel × 2 - current stock (replenish to 2× reorder level)
        const suggestedQty = Math.max(prod.reorderLevel * 2 - stock.currentStock, prod.minStockLevel || 10);

        // Find last supplier from GRN
        const lastGRN = await GRN.findOne({ 'items.product': prod._id, status: { $in: ['approved', 'posted'] } })
          .sort({ createdAt: -1 }).select('supplier supplierName').lean();

        suggestions.push({
          product: prod._id,
          productCode: prod.productCode,
          productName: prod.itemName,
          productImage: prod.images?.[0] || '',
          brand: prod.brand?.name || '',
          tileSize: prod.tileSize || '',
          reorderLevel: prod.reorderLevel,
          currentStock: stock.currentStock,
          deficit: prod.reorderLevel - stock.currentStock,
          suggestedQty,
          lastPurchaseRate: stock.lastRate || prod.basicPrice || 0,
          suggestedSupplier: lastGRN?.supplier || null,
          suggestedSupplierName: lastGRN?.supplierName || 'No supplier history',
          isZeroStock: stock.currentStock <= 0,
          urgency: stock.currentStock <= 0 ? 'critical' : stock.currentStock <= prod.reorderLevel / 2 ? 'high' : 'medium',
        });
      }
    }

    // Sort by urgency (critical first)
    const urgencyOrder = { critical: 0, high: 1, medium: 2 };
    suggestions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    res.json({
      success: true,
      data: suggestions,
      summary: {
        total: suggestions.length,
        critical: suggestions.filter(s => s.urgency === 'critical').length,
        high: suggestions.filter(s => s.urgency === 'high').length,
        medium: suggestions.filter(s => s.urgency === 'medium').length,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/purchase/stock/create-po-from-suggestions — one-click PO creation from suggestions
router.post('/stock/create-po-from-suggestions', requirePermission('po.management'), async (req, res) => {
  try {
    const { supplier, items, remarks } = req.body;
    // items: [{ product, productName, productCode, quantity, rate, gstPercentage }]

    if (!supplier) return res.status(400).json({ success: false, message: 'Supplier is required.' });
    if (!items?.length) return res.status(400).json({ success: false, message: 'At least one item is required.' });

    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    const poNumber = await generateUniqueCode(PurchaseOrder, 'poNumber', 'PO-', 5);

    // Get supplier name
    const sup = await Supplier.findById(supplier).lean();
    const supplierName = sup?.companyName || '';

    // Calculate totals
    let subtotal = 0, totalTax = 0;
    const processedItems = items.map(item => {
      const base = (item.quantity || 0) * (item.rate || 0);
      const gst = (base * (item.gstPercentage || 18)) / 100;
      subtotal += base;
      totalTax += gst;
      return {
        product: item.product,
        productName: item.productName || '',
        productCode: item.productCode || '',
        quantity: item.quantity || 0,
        rate: item.rate || 0,
        gstPercentage: item.gstPercentage || 18,
        gstAmount: Math.round(gst * 100) / 100,
        totalAmount: Math.round((base + gst) * 100) / 100,
        pendingQty: item.quantity || 0,
      };
    });

    const grandTotal = Math.round(subtotal + totalTax);

    const po = await PurchaseOrder.create({
      poNumber,
      poDate: new Date(),
      supplier,
      supplierName,
      items: processedItems,
      subtotal: Math.round(subtotal * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      grandTotal,
      status: 'draft',
      remarks: remarks || 'Auto-generated from stock reorder suggestions',
      tallySyncStatus: 'not_synced',
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      message: `Purchase Order ${poNumber} created from reorder suggestions.`,
      data: po,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
