import { Router } from 'express';
import mongoose from 'mongoose';
import PurchaseOrder from '../models/PurchaseOrder.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import Supplier from '../models/Supplier.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

// ═══════════════════════════════════════
// PURCHASE ORDERS
// ═══════════════════════════════════════
router.get('/purchase-orders', requirePermission('po.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(100, parseInt(limit) || 20);
    let filter = { branch: req.branchId };
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
    const scope = { branch: req.branchId };
    const [total, draft, approved, received, cancelled] = await Promise.all([
      PurchaseOrder.countDocuments(scope), PurchaseOrder.countDocuments({ ...scope, status: 'draft' }),
      PurchaseOrder.countDocuments({ ...scope, status: 'approved' }), PurchaseOrder.countDocuments({ ...scope, status: 'received' }),
      PurchaseOrder.countDocuments({ ...scope, status: 'cancelled' }),
    ]);
    res.json({ success: true, data: { total, draft, approved, received, cancelled } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/purchase-orders/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, branch: req.branchId }).populate('supplier', 'companyName supplierCode mobile').populate('items.product', 'productCode itemName').lean();
    if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
    res.json({ success: true, data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/purchase-orders', requirePermission('po.management'), async (req, res) => {
  try {
    const { branch, poNumber, createdBy, ...input } = req.body;
    const data = { ...input, branch: req.branchId, createdBy: req.user._id };
    data.poNumber = await generateBranchNumber(req.branchId, 'purchaseOrder', data.poDate || new Date());
    if (data.receivingWarehouse) {
      await assertWarehousesInBranch([data.receivingWarehouse], req.branchId);
    }

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
    const { branch, poNumber, createdBy, ...updates } = req.body;
    if (updates.receivingWarehouse) await assertWarehousesInBranch([updates.receivingWarehouse], req.branchId);
    const po = await PurchaseOrder.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId },
      updates,
      { new: true, runValidators: true }
    );
    if (!po) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'PO updated.', data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/purchase-orders/:id/status', requirePermission('po.management'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId },
      { status: req.body.status },
      { new: true, runValidators: true }
    );
    res.json({ success: true, message: `Status updated to ${req.body.status}.`, data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/purchase-orders/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(PurchaseOrder, req.params.id, {
      user: req.user,
      module: 'purchase',
      titleField: 'supplierName',
      codeField: 'poNumber',
      scope: { branch: req.branchId },
    });
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
    let filter = { branch: req.branchId };
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
    const pos = await PurchaseOrder.find({ branch: req.branchId, status: { $in: ['approved', 'sent', 'partial_received'] } })
      .select('poNumber supplierName poDate items grandTotal status').populate('supplier', 'companyName').lean();
    res.json({ success: true, data: pos });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/grn/:id', requirePermission('grn.entry'), async (req, res) => {
  try {
    const grn = await GRN.findOne({ _id: req.params.id, branch: req.branchId }).populate('supplier', 'companyName').populate('items.product', 'productCode itemName').populate('items.warehouse', 'name').lean();
    if (!grn) return res.status(404).json({ success: false, message: 'GRN not found.' });
    res.json({ success: true, data: grn });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/grn', requirePermission('grn.entry'), async (req, res) => {
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }
  const sourceKey = `${String(req.branchId)}:${rawIdempotencyKey}`;
  const requestFingerprint = fingerprintRequest(req.body);
  try {
    const existing = await GRN.findOne({ branch: req.branchId, sourceKey });
    if (existing) {
      if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
        return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
      }
      return res.json({ success: true, message: 'GRN already created.', data: existing });
    }
    const requestedStatus = req.body.status ?? 'draft';
    if (['approved', 'posted'].includes(requestedStatus)) {
      return res.status(422).json({ success: false, message: 'Create the GRN as draft or verified, then use the approval endpoint.' });
    }
    if (!['draft', 'verified'].includes(requestedStatus)) {
      return res.status(422).json({ success: false, message: 'GRN status must be draft or verified on creation.' });
    }

    const { branch, grnNumber, createdBy, ...input } = req.body;
    const data = {
      ...input,
      branch: req.branchId,
      sourceKey,
      requestFingerprint,
      status: requestedStatus,
      createdBy: req.user._id,
    };
    data.grnNumber = await generateBranchNumber(req.branchId, 'grn', data.grnDate || new Date());

    if (!data.supplier) return res.status(422).json({ success: false, message: 'Supplier is required.' });
    const supplier = await Supplier.findById(data.supplier).lean();
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    data.supplierName = supplier.companyName;

    if (data.purchaseOrder) {
      const po = await PurchaseOrder.findOne({ _id: data.purchaseOrder, branch: req.branchId }).lean();
      if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found.' });
      if (String(po.supplier) !== String(data.supplier)) {
        return res.status(422).json({ success: false, message: 'Purchase order does not belong to the selected supplier.' });
      }
      data.poNumber = po.poNumber;
    }

    data.tallySyncStatus = 'not_synced';
    await assertWarehousesInBranch(
      (data.items || []).filter((item) => Number(item.acceptedQty || item.receivedQty) > 0).map((item) => item.warehouse),
      req.branchId
    );
    const grn = await GRN.create(data);
    res.status(201).json({ success: true, message: 'GRN created without posting effects.', data: grn });
  } catch (e) {
    if (e.code === 11000) {
      const existing = await GRN.findOne({ branch: req.branchId, sourceKey });
      if (existing) {
        if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
          return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
        }
        return res.json({ success: true, message: 'GRN already created.', data: existing });
      }
    }
    const status = e.status || (e.name === 'CastError' ? 422 : 500);
    return res.status(status).json({ success: false, message: e.name === 'CastError' ? 'Invalid identifier.' : e.message });
  }
});

router.patch('/grn/:id/approve', requirePermission('grn.entry'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let approved;
    let alreadyApproved = false;
    await session.withTransaction(async () => {
      const grn = await GRN.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!grn) throw Object.assign(new Error('GRN not found.'), { status: 404 });
      if (['approved', 'posted'].includes(grn.status)) {
        approved = grn;
        alreadyApproved = true;
        return;
      }
      if (!['draft', 'verified'].includes(grn.status)) {
        throw Object.assign(new Error(`Cannot approve a GRN in ${grn.status} status.`), { status: 409 });
      }

      const supplier = await Supplier.findById(grn.supplier).session(session).lean();
      if (!supplier) throw Object.assign(new Error('Supplier not found.'), { status: 404 });
      await assertWarehousesInBranch(
        grn.items.filter((item) => Number(item.acceptedQty) > 0).map((item) => item.warehouse),
        req.branchId,
        { session }
      );

      const acceptedByProduct = new Map();
      for (let index = 0; index < grn.items.length; index += 1) {
        const item = grn.items[index];
        const acceptedQty = Number(item.acceptedQty);
        const rate = Number(item.rate);
        if (!Number.isFinite(acceptedQty) || acceptedQty < 0) {
          throw Object.assign(new Error(`items[${index}].acceptedQty must be finite and nonnegative.`), { status: 422 });
        }
        if (!Number.isFinite(rate) || rate < 0) {
          throw Object.assign(new Error(`items[${index}].rate must be finite and nonnegative.`), { status: 422 });
        }
        if (acceptedQty > 0 && (!item.product || !item.warehouse)) {
          throw Object.assign(new Error(`Accepted item ${index + 1} requires product and warehouse.`), { status: 422 });
        }
        if (acceptedQty > 0) {
          const key = String(item.product);
          acceptedByProduct.set(key, (acceptedByProduct.get(key) ?? 0) + acceptedQty);
        }
      }

      let po = null;
      if (grn.purchaseOrder) {
        po = await PurchaseOrder.findOne({ _id: grn.purchaseOrder, branch: req.branchId }).session(session);
        if (!po) throw Object.assign(new Error('Purchase order not found in the active branch.'), { status: 404 });
        if (String(po.supplier) !== String(grn.supplier)) {
          throw Object.assign(new Error('GRN supplier does not match the purchase order supplier.'), { status: 422 });
        }
        for (const [productId, acceptedQty] of acceptedByProduct) {
          const pendingQty = po.items
            .filter((item) => String(item.product) === productId)
            .reduce((sum, item) => sum + Number(item.pendingQty ?? Math.max(0, item.quantity - (item.receivedQty ?? 0))), 0);
          if (!Number.isFinite(pendingQty) || acceptedQty > pendingQty) {
            throw Object.assign(new Error('Accepted quantity exceeds the matching purchase order pending quantity.'), { status: 422 });
          }
        }
      }

      await updateStockFromGRN(grn, session);
      if (po) await updatePOReceivedQty(po, grn.items, session);
      const totalGRNValue = grn.items.reduce(
        (sum, item) => sum + (Number(item.acceptedQty) * Number(item.rate)),
        0
      );
      if (totalGRNValue > 0) {
        await postSubledgerEntry({
          session,
          branch: req.branchId,
          partyType: 'supplier',
          partyId: grn.supplier,
          amount: totalGRNValue,
          side: 'credit',
          postingKey: `grn:${grn._id}:approved`,
          entryType: 'purchase',
          entryDate: grn.grnDate,
          description: `Purchase received through GRN ${grn.grnNumber}`,
          referenceNumber: grn.grnNumber,
          referenceModel: 'GRN',
          referenceId: grn._id,
          createdBy: req.user._id,
        });
      }

      grn.status = 'approved';
      await grn.save({ session });
      approved = grn;
    });
    return res.json({
      success: true,
      message: alreadyApproved ? `GRN is already ${approved.status}.` : 'GRN approved. Stock, PO, and supplier outstanding updated.',
      data: approved,
    });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

// Helper: Update stock from accepted GRN items
async function updateStockFromGRN(grn, session) {
  for (const item of grn.items) {
    const acceptedQty = Number(item.acceptedQty);
    if (acceptedQty <= 0) continue;
    await Stock.findOneAndUpdate(
      { branch: grn.branch, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '' },
      {
        $inc: { totalQty: acceptedQty, availableQty: acceptedQty },
        $set: { branch: grn.branch, zone: item.zone || '', rack: item.rack || '', bin: item.bin || '', purchaseRate: Number(item.rate), lastGRNDate: new Date() },
      },
      { upsert: true, new: true, session }
    );
  }
}

// Helper: Update PO quantities using acceptedQty only
async function updatePOReceivedQty(po, grnItems, session) {
  const acceptedByProduct = new Map();
  for (const item of grnItems) {
    const key = String(item.product);
    acceptedByProduct.set(key, (acceptedByProduct.get(key) ?? 0) + Number(item.acceptedQty));
  }

  for (const [productId, totalAccepted] of acceptedByProduct) {
    let remaining = totalAccepted;
    for (const poItem of po.items.filter((item) => String(item.product) === productId)) {
      if (remaining <= 0) break;
      const pendingQty = Number(poItem.pendingQty ?? Math.max(0, poItem.quantity - (poItem.receivedQty ?? 0)));
      const appliedQty = Math.min(remaining, pendingQty);
      poItem.receivedQty = Number(poItem.receivedQty ?? 0) + appliedQty;
      poItem.pendingQty = Math.max(0, Number(poItem.quantity) - poItem.receivedQty);
      remaining -= appliedQty;
    }
  }

  const allReceived = po.items.every((item) => item.pendingQty <= 0);
  const someReceived = po.items.some((item) => item.receivedQty > 0);
  if (allReceived) po.status = 'received';
  else if (someReceived) po.status = 'partial_received';
  await po.save({ session });
}

// ═══════════════════════════════════════
// STOCK
// ═══════════════════════════════════════
router.get('/stock', requirePermission('stock.view'), async (req, res) => {
  try {
    const { page = 1, limit = 50, product, warehouse, shade, batch, search } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(200, parseInt(limit) || 50);
    let filter = { branch: req.branchId };
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
      { $match: { branch: req.branchId } },
      { $group: { _id: null, totalQty: { $sum: '$totalQty' }, availableQty: { $sum: '$availableQty' }, reservedQty: { $sum: '$reservedQty' }, transitQty: { $sum: '$transitQty' }, damagedQty: { $sum: '$damagedQty' }, shortQty: { $sum: '$shortQty' }, totalValue: { $sum: { $multiply: ['$availableQty', '$purchaseRate'] } } } },
    ]);
    const productCount = await Stock.distinct('product', { branch: req.branchId });
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
    await assertWarehousesInBranch([warehouse], req.branchId);
    const stock = await Stock.findOneAndUpdate(
      { branch: req.branchId, product, warehouse, shade: shade || '', batch: batch || '' },
      { $inc: { totalQty: adjustmentQty, availableQty: adjustmentQty }, $set: { branch: req.branchId } },
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
    await assertWarehousesInBranch([fromWarehouse, toWarehouse], req.branchId);
    // Deduct from source
    const source = await Stock.findOneAndUpdate(
      { branch: req.branchId, product, warehouse: fromWarehouse, shade: shade || '', batch: batch || '', availableQty: { $gte: quantity } },
      { $inc: { totalQty: -quantity, availableQty: -quantity } },
      { new: true }
    );
    if (!source) return res.status(400).json({ success: false, message: 'Insufficient stock in source warehouse.' });
    // Add to destination
    await Stock.findOneAndUpdate(
      { branch: req.branchId, product, warehouse: toWarehouse, shade: shade || '', batch: batch || '' },
      { $inc: { totalQty: quantity, availableQty: quantity }, $set: { branch: req.branchId } },
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
    let filter = { branch: req.branchId, availableQty: { $lte: minQty, $gte: 0 } };
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
    await assertWarehousesInBranch([warehouse], req.branchId);

    const stocks = await Stock.find({ branch: req.branchId, warehouse, availableQty: { $gt: 0 } })
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
    await assertWarehousesInBranch([warehouse], req.branchId);

    const results = [];
    let totalDiscrepancy = 0;
    let adjustedCount = 0;

    for (const count of counts) {
      const stock = await Stock.findOne({ _id: count.stockId, branch: req.branchId, warehouse });
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
    if (warehouse) await assertWarehousesInBranch([warehouse], req.branchId);
    const stockFilter = { branch: req.branchId, ...(warehouse ? { warehouse } : {}) };
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
        const lastGRN = await GRN.findOne({ branch: req.branchId, 'items.product': prod._id, status: { $in: ['approved', 'posted'] } })
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

    const poNumber = await generateBranchNumber(req.branchId, 'purchaseOrder', new Date());

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
      branch: req.branchId,
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
