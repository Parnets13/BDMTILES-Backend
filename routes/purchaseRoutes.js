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
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, message: 'Not found.' });
    if (po.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft POs can be deleted.' });
    await PurchaseOrder.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'PO deleted.' });
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

router.get('/grn/:id', requirePermission('grn.entry'), async (req, res) => {
  try {
    const grn = await GRN.findById(req.params.id).populate('supplier', 'companyName').populate('items.product', 'productCode itemName').populate('items.warehouse', 'name').lean();
    if (!grn) return res.status(404).json({ success: false, message: 'GRN not found.' });
    res.json({ success: true, data: grn });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Get approved POs for GRN creation
router.get('/grn/available-pos', requirePermission('grn.entry'), async (req, res) => {
  try {
    const pos = await PurchaseOrder.find({ status: { $in: ['approved', 'sent', 'partial_received'] } })
      .select('poNumber supplierName poDate items grandTotal status').populate('supplier', 'companyName').lean();
    res.json({ success: true, data: pos });
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

export default router;
