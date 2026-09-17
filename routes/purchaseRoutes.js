import { Router } from 'express';
import mongoose from 'mongoose';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Product from '../models/Product.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import StockMovement from '../models/StockMovement.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission, requireAnyPermission, userHasPermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import {
  applyStockMovement,
  deterministicSourceId,
  getStockSummary,
  listStocks,
  stockOperationKey,
} from '../services/stockMovementService.js';
import { resolveStockUom } from '../services/stockUomService.js';
import {
  createSubmittedLegacyAdjustment,
  createSubmittedLegacyAudit,
} from '../services/stockWorkflowService.js';
import {
  actionPurchaseOrderApproval,
  amendmentDiff,
  assertPurchaseOrderSourceIntegrity,
  calculatePurchaseOrder,
  purchaseOrderSnapshot,
  submitPurchaseOrder,
} from '../services/purchaseOrderService.js';
import { getCanonicalStockAlerts } from '../services/stockAlertService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const requireAllPermissions = (...permissions) => (req, res, next) => {
  if (!permissions.every((permission) => userHasPermission(req.user, permission))) {
    return res.status(403).json({ success: false, message: `Access denied: requires ${permissions.join(' and ')}` });
  }
  return next();
};
const requireLegacyAdjustmentOrAll = (...permissions) => (req, res, next) => {
  if (!userHasPermission(req.user, 'stock.adjustment') && !permissions.every((permission) => userHasPermission(req.user, permission))) {
    return res.status(403).json({ success: false, message: `Access denied: requires legacy stock.adjustment or ${permissions.join(' and ')}` });
  }
  return next();
};

// ═══════════════════════════════════════
// PURCHASE ORDERS
// ═══════════════════════════════════════
router.get('/purchase-orders', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(100, parseInt(limit) || 20);
    let filter = { branch: req.branchId };
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const r = new RegExp(escaped, 'i');
      filter.$or = [{ poNumber: r }, { supplierName: r }];
    }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const [orders, total] = await Promise.all([
      PurchaseOrder.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).populate('supplier', 'companyName supplierCode').lean(),
      PurchaseOrder.countDocuments(filter),
    ]);
    res.json({ success: true, data: orders, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/purchase-orders/stats', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, draft, pendingApproval, approved, rejected, partialReceived, received, cancelled] = await Promise.all([
      PurchaseOrder.countDocuments(scope),
      PurchaseOrder.countDocuments({ ...scope, status: 'draft' }),
      PurchaseOrder.countDocuments({ ...scope, status: { $in: ['submitted', 'pending_approval'] } }),
      PurchaseOrder.countDocuments({ ...scope, status: 'approved' }),
      PurchaseOrder.countDocuments({ ...scope, status: 'rejected' }),
      PurchaseOrder.countDocuments({ ...scope, status: 'partial_received' }),
      PurchaseOrder.countDocuments({ ...scope, status: 'received' }),
      PurchaseOrder.countDocuments({ ...scope, status: 'cancelled' }),
    ]);
    res.json({ success: true, data: { total, draft, pendingApproval, approved, rejected, partialReceived, received, cancelled } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/purchase-orders/:id', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, branch: req.branchId }).populate('supplier', 'companyName supplierCode mobile').populate('items.product', 'productCode itemName images').lean();
    if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
    res.json({ success: true, data: po });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/purchase-orders/:id/print', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('supplier', 'companyName supplierCode contactPerson mobile email gstin address city state pinCode')
      .populate('receivingWarehouse', 'warehouseCode name address city state pinCode')
      .populate('createdBy approvedBy', 'name email').lean();
    if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
    return res.json({
      success: true,
      data: {
        documentType: 'PURCHASE_ORDER',
        documentNumber: po.poNumber,
        documentDate: po.poDate,
        status: po.status,
        branch: req.branch,
        supplier: po.supplier,
        receivingWarehouse: po.receivingWarehouse,
        items: po.items,
        commercialTerms: {
          paymentTerms: po.paymentTerms,
          creditDays: po.creditDays,
          expectedDeliveryDate: po.expectedDeliveryDate,
          deliveryAddress: po.deliveryAddress,
          remarks: po.remarks,
        },
        totals: {
          subtotal: po.subtotal, totalDiscount: po.totalDiscount, totalTax: po.totalTax,
          freight: po.freight, loading: po.loading, insurance: po.insurance, grandTotal: po.grandTotal,
        },
        audit: { createdAt: po.createdAt, createdBy: po.createdBy, approvedAt: po.approvedAt, approvedBy: po.approvedBy },
      },
    });
  } catch (error) {
    return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.post('/purchase-orders', requirePermission('po.management'), (_req, res) => res.status(405).json({
  success: false,
  code: 'PR_SUPPLIER_QUOTATION_REQUIRED',
  message: 'Create a purchase requisition, compare supplier quotations, and convert the selected quotation to a purchase order.',
}));

router.put('/purchase-orders/:id', requirePermission('po.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let updated;
    await session.withTransaction(async () => {
      const po = await PurchaseOrder.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!po) throw Object.assign(new Error('Purchase order not found.'), { status: 404 });
      if (po.status !== 'draft') throw Object.assign(new Error('Only a draft purchase order can be amended.'), { status: 409 });
      const reason = String(req.body.amendmentReason || '').trim();
      if (!reason) throw Object.assign(new Error('amendmentReason is required.'), { status: 422 });
      const before = purchaseOrderSnapshot(po);
      const calculated = await calculatePurchaseOrder({ branchId: req.branchId, input: req.body, session });
      await assertPurchaseOrderSourceIntegrity({ branchId: req.branchId, po, calculated, session });
      Object.assign(po, calculated);
      const after = purchaseOrderSnapshot(po);
      const diff = amendmentDiff(before, after);
      if (!diff.length) throw Object.assign(new Error('No purchase order changes were supplied.'), { status: 422 });
      po.amendmentHistory.push({ snapshot: before, diff, reason, amendedBy: req.user._id, amendedAt: new Date() });
      updated = await po.save({ session });
    });
    return res.json({ success: true, message: 'PO amended.', data: updated });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

router.patch('/purchase-orders/:id/submit', requirePermission('po.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await submitPurchaseOrder({ branchId: req.branchId, poId: req.params.id, actor: req.user, remarks: String(req.body.remarks || ''), session });
    });
    return res.json({ success: true, message: result.replayed ? 'Purchase order is already submitted.' : 'Purchase order submitted for approval.', data: result });
  } catch (error) {
    return res.status(error.status || (error.name === 'CastError' ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

const directPurchaseOrderAction = async (req, res, nextStatus) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await actionPurchaseOrderApproval({
        branchId: req.branchId, poId: req.params.id, actorId: req.user._id,
        nextStatus, remarks: String(req.body.remarks || ''), session,
      });
    });
    return res.json({ success: true, message: result.replayed ? `Purchase order is already ${nextStatus}.` : `Purchase order ${nextStatus}.`, data: result.po });
  } catch (error) {
    return res.status(error.status || (error.name === 'CastError' ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
};

router.patch('/purchase-orders/:id/approve', requirePermission('po.approve'), (req, res) => directPurchaseOrderAction(req, res, 'approved'));
router.patch('/purchase-orders/:id/reject', requirePermission('po.approve'), (req, res) => directPurchaseOrderAction(req, res, 'rejected'));

router.patch('/purchase-orders/:id/status', requirePermission('po.management'), async (req, res) => {
  const requested = req.body.status;
  if (requested === 'pending_approval' || requested === 'submitted') {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await submitPurchaseOrder({ branchId: req.branchId, poId: req.params.id, actor: req.user, remarks: String(req.body.remarks || ''), session });
      });
      return res.json({ success: true, message: 'Purchase order submitted for approval.', data: result.po });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, message: error.message });
    } finally { await session.endSession(); }
  }
  if (requested === 'approved' || requested === 'rejected') {
    return res.status(422).json({ success: false, message: `Use the explicit /${requested === 'approved' ? 'approve' : 'reject'} endpoint.` });
  }
  return res.status(422).json({ success: false, message: 'Unsupported status transition. Use an explicit purchase order action endpoint.' });
});

router.delete('/purchase-orders/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findOne({ _id: req.params.id, branch: req.branchId }).select('status').lean();
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found.' });
    if (po.status !== 'draft') return res.status(409).json({ success: false, message: 'Only a draft purchase order can be deleted.' });
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(PurchaseOrder, req.params.id, {
      user: req.user, module: 'purchase', titleField: 'supplierName', codeField: 'poNumber', scope: { branch: req.branchId },
    });
    return res.status(result.status || 200).json(result);
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

// ═══════════════════════════════════════
// GRN (Goods Receipt Note)
// ═══════════════════════════════════════
const grnError = (status, message) => Object.assign(new Error(message), { status });
const receiptQuantity = (value, field) => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw grnError(422, `${field} must be a finite nonnegative number.`);
  return parsed;
};
const receiptId = value => String(value?._id || value || '');
const receiptRound = value => Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;

function normalizeGRNItems({ items, po, branchId, grnNumber }) {
  if (!Array.isArray(items) || !items.length) throw grnError(422, 'At least one GRN item is required.');
  const usedPOLines = new Set();
  let totalReceived = 0;

  const normalized = items.map((item, index) => {
    let poItem = item.purchaseOrderItem ? po.items.id(item.purchaseOrderItem) : null;
    if (!poItem) {
      const matches = po.items.filter(line => receiptId(line.product) === receiptId(item.product));
      if (matches.length === 1) poItem = matches[0];
    }
    if (!poItem) throw grnError(422, `items[${index}] must identify one exact purchase order line.`);
    const poLineId = receiptId(poItem._id);
    if (usedPOLines.has(poLineId)) throw grnError(422, `Purchase order line ${index + 1} appears more than once in the GRN.`);
    usedPOLines.add(poLineId);

    const receivedQty = receiptQuantity(item.receivedQty, `items[${index}].receivedQty`);
    const rejectedQty = receiptQuantity(item.rejectedQty, `items[${index}].rejectedQty`);
    const damagedQty = receiptQuantity(item.damagedQty, `items[${index}].damagedQty`);
    let heldQty = item.heldQty === undefined
      ? 0
      : receiptQuantity(item.heldQty, `items[${index}].heldQty`);
    if (item.heldQty === undefined && item.acceptedQty !== undefined) {
      const suppliedAccepted = receiptQuantity(item.acceptedQty, `items[${index}].acceptedQty`);
      heldQty = receiptRound(receivedQty - suppliedAccepted - rejectedQty - damagedQty);
      if (heldQty < 0) throw grnError(422, `items[${index}] disposition quantities exceed received quantity.`);
    }
    const acceptedQty = receiptRound(receivedQty - rejectedQty - damagedQty - heldQty);
    if (acceptedQty < 0) throw grnError(422, `items[${index}] received quantity must equal accepted, rejected, damaged, and held quantities.`);
    if (item.acceptedQty !== undefined && Math.abs(Number(item.acceptedQty) - acceptedQty) > 0.000001) {
      throw grnError(422, `items[${index}].acceptedQty does not match the receipt disposition quantities.`);
    }

    const pendingQty = Number(poItem.pendingQty ?? Math.max(0, Number(poItem.quantity) - Number(poItem.receivedQty || 0)));
    if (!Number.isFinite(pendingQty) || receivedQty > pendingQty + 0.000001) {
      throw grnError(422, `items[${index}].receivedQty exceeds the purchase order line pending quantity.`);
    }
    if (receivedQty > 0 && !item.warehouse) throw grnError(422, `items[${index}].warehouse is required.`);
    totalReceived = receiptRound(totalReceived + receivedQty);

    return {
      purchaseOrderItem: poItem._id,
      product: poItem.product,
      productCode: poItem.productCode,
      productName: poItem.productName,
      unit: poItem.unit || 'Box',
      orderedQty: Number(poItem.quantity),
      receivedQty,
      acceptedQty,
      shortQty: receiptRound(Math.max(0, pendingQty - receivedQty)),
      excessQty: 0,
      damagedQty,
      rejectedQty,
      heldQty,
      shade: String(item.shade || ''),
      batch: String(item.batch || ''),
      qualityStatus: heldQty > 0 ? 'hold' : acceptedQty > 0 ? 'accepted' : 'rejected',
      warehouse: item.warehouse || po.receivingWarehouse,
      zone: String(item.zone || ''),
      rack: String(item.rack || ''),
      bin: String(item.bin || ''),
      rate: Number(poItem.rate),
      discount: Number(poItem.discount || 0),
      schemeDiscount: Number(poItem.schemeDiscount || 0),
      gstPercentage: Number(poItem.gstPercentage || 0),
      receiptCode: `${receiptId(branchId)}:${grnNumber}:${poLineId}`,
      remarks: String(item.remarks || ''),
    };
  });

  if (totalReceived <= 0) throw grnError(422, 'At least one GRN line must have a positive received quantity.');
  return normalized;
}

router.get('/grn', requirePermission('grn.entry'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, parseInt(page)); const l = Math.min(100, parseInt(limit) || 20);
    let filter = { branch: req.branchId };
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const r = new RegExp(escaped, 'i');
      filter.$or = [{ grnNumber: r }, { supplierName: r }, { poNumber: r }];
    }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const scope = { branch: req.branchId };
    const [grns, total, draft, verified, approved, posted] = await Promise.all([
      GRN.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).populate('supplier', 'companyName').lean(),
      GRN.countDocuments(filter),
      GRN.countDocuments({ ...scope, status: 'draft' }),
      GRN.countDocuments({ ...scope, status: 'verified' }),
      GRN.countDocuments({ ...scope, status: 'approved' }),
      GRN.countDocuments({ ...scope, status: 'posted' }),
    ]);
    res.json({
      success: true,
      data: grns,
      stats: { total: await GRN.countDocuments(scope), draft, verified, approved: approved + posted, posted },
      pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total, itemsPerPage: l },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Get approved POs for GRN creation — MUST be before /grn/:id to avoid route conflict
router.get('/grn/available-pos', requirePermission('grn.entry'), async (req, res) => {
  try {
    const pos = await PurchaseOrder.find({
      branch: req.branchId,
      status: { $in: ['approved', 'sent', 'partial_received'] },
      items: { $elemMatch: { pendingQty: { $gt: 0 } } },
    })
      .select('poNumber supplierName poDate items grandTotal status')
      .populate('supplier', 'companyName')
      .populate('items.product', 'productCode itemName images')
      .lean();
    res.json({ success: true, data: pos });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/grn/:id', requirePermission('grn.entry'), async (req, res) => {
  try {
    const grn = await GRN.findOne({ _id: req.params.id, branch: req.branchId }).populate('supplier', 'companyName').populate('items.product', 'productCode itemName images').populate('items.warehouse', 'name').lean();
    if (!grn) return res.status(404).json({ success: false, message: 'GRN not found.' });
    res.json({ success: true, data: grn });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/grn', requirePermission('grn.entry'), async (req, res) => {
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }
  const sourceKey = `${String(req.branchId)}:grn:${rawIdempotencyKey}`;
  const requestFingerprint = fingerprintRequest(req.body);
  const session = await mongoose.startSession();
  try {
    let result;
    let replayed = false;
    await session.withTransaction(async () => {
      const existing = await GRN.findOne({ branch: req.branchId, sourceKey }).session(session);
      if (existing) {
        if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
          throw grnError(409, 'This Idempotency-Key was already used with a different request payload.');
        }
        result = existing;
        replayed = true;
        return;
      }

      const requestedStatus = req.body.status ?? 'draft';
      if (requestedStatus !== 'draft') {
        throw grnError(422, 'Create the GRN as draft, then use the verification endpoint.');
      }
      if (!req.body.purchaseOrder) throw grnError(422, 'An approved purchase order is required for a GRN.');

      const po = await PurchaseOrder.findOne({ _id: req.body.purchaseOrder, branch: req.branchId }).session(session);
      if (!po) throw grnError(404, 'Purchase order not found.');
      if (!['approved', 'sent', 'partial_received'].includes(po.status)) {
        throw grnError(409, 'Only an approved purchase order with pending quantities can be used for a GRN.');
      }
      if (!po.items.some(item => Number(item.pendingQty) > 0)) throw grnError(409, 'Purchase order has no pending quantity.');
      if (req.body.supplier && receiptId(req.body.supplier) !== receiptId(po.supplier)) {
        throw grnError(422, 'Purchase order does not belong to the selected supplier.');
      }

      const supplier = await Supplier.findOne({ _id: po.supplier, status: 'active' }).session(session).lean();
      if (!supplier) throw grnError(404, 'Active supplier not found.');
      const grnDate = req.body.grnDate || new Date();
      const grnNumber = await generateBranchNumber(req.branchId, 'grn', grnDate, { session });
      const items = normalizeGRNItems({
        items: req.body.items,
        po,
        branchId: req.branchId,
        grnNumber,
      });
      await assertWarehousesInBranch(
        items.filter(item => item.receivedQty > 0).map(item => item.warehouse),
        req.branchId,
        { session }
      );

      [result] = await GRN.create([{
        grnNumber,
        branch: req.branchId,
        grnDate,
        sourceKey,
        requestFingerprint,
        purchaseOrder: po._id,
        poNumber: po.poNumber,
        supplier: po.supplier,
        supplierName: supplier.companyName,
        supplierInvoiceNo: String(req.body.supplierInvoiceNo || ''),
        vehicleNo: String(req.body.vehicleNo || ''),
        driverName: String(req.body.driverName || ''),
        driverMobile: String(req.body.driverMobile || ''),
        lrNumber: String(req.body.lrNumber || ''),
        qcPhotos: Array.isArray(req.body.qcPhotos) ? req.body.qcPhotos.map(String) : [],
        items,
        status: requestedStatus,
        qcRemarks: String(req.body.qcRemarks || req.body.remarks || ''),
        tallySyncStatus: 'not_synced',
        createdBy: req.user._id,
      }], { session });
    });
    return res.status(replayed ? 200 : 201).json({
      success: true,
      message: replayed ? 'GRN already created.' : 'GRN created without posting effects.',
      data: result,
    });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await GRN.findOne({ branch: req.branchId, sourceKey });
      if (existing) {
        if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
          return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
        }
        return res.json({ success: true, message: 'GRN already created.', data: existing });
      }
    }
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

// Edit a draft GRN: adjust received/accepted/rejected/damaged/held quantities,
// warehouse, header fields, and item line-up (against its PO). Draft-only; once
// verified/posted the receipt is part of the stock/payable record and is locked.
router.patch('/grn/:id', requirePermission('grn.entry'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let updated;
    await session.withTransaction(async () => {
      const grn = await GRN.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!grn) throw grnError(404, 'GRN not found.');
      if (grn.status !== 'draft') throw grnError(409, `Only a draft GRN can be edited. Current status: ${grn.status}.`);

      const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrder, branch: req.branchId }).session(session);
      if (!po) throw grnError(404, 'Purchase order not found in the active branch.');
      if (!['approved', 'sent', 'partial_received'].includes(po.status)) {
        throw grnError(409, 'Only an approved purchase order with pending quantities can be received.');
      }

      if (req.body.items !== undefined) {
        const items = normalizeGRNItems({ items: req.body.items, po, branchId: req.branchId, grnNumber: grn.grnNumber });
        await assertWarehousesInBranch(
          items.filter(item => item.receivedQty > 0).map(item => item.warehouse),
          req.branchId,
          { session }
        );
        grn.items = items;
      }
      if (req.body.grnDate !== undefined) grn.grnDate = req.body.grnDate || grn.grnDate;
      if (req.body.supplierInvoiceNo !== undefined) grn.supplierInvoiceNo = String(req.body.supplierInvoiceNo || '');
      if (req.body.vehicleNo !== undefined) grn.vehicleNo = String(req.body.vehicleNo || '');
      if (req.body.driverName !== undefined) grn.driverName = String(req.body.driverName || '');
      if (req.body.driverMobile !== undefined) grn.driverMobile = String(req.body.driverMobile || '');
      if (req.body.lrNumber !== undefined) grn.lrNumber = String(req.body.lrNumber || '');
      if (Array.isArray(req.body.qcPhotos)) grn.qcPhotos = req.body.qcPhotos.map(String);
      if (req.body.qcRemarks !== undefined || req.body.remarks !== undefined) {
        grn.qcRemarks = String(req.body.qcRemarks ?? req.body.remarks ?? grn.qcRemarks ?? '');
      }
      await grn.save({ session });
      updated = grn;
    });
    return res.json({ success: true, message: `GRN ${updated.grnNumber} updated.`, data: updated });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

// Cancel/delete a draft GRN (recycle-bin soft delete). Draft-only; no stock effects
// have been posted yet, so removal is safe.
router.delete('/grn/:id', requirePermission('grn.entry'), async (req, res) => {
  try {
    const grn = await GRN.findOne({ _id: req.params.id, branch: req.branchId }).select('status grnNumber').lean();
    if (!grn) throw grnError(404, 'GRN not found.');
    if (grn.status !== 'draft') throw grnError(409, `Only a draft GRN can be deleted. Current status: ${grn.status}.`);
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(GRN, req.params.id, {
      user: req.user, module: 'grn', titleField: 'grnNumber', codeField: 'grnNumber',
    });
    return res.status(result.status || 200).json(result);
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.patch('/grn/:id/verify', requirePermission('grn.entry'), async (req, res) => {
  try {
    const grn = await GRN.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'draft' },
      { $set: { status: 'verified', verifiedBy: req.user._id, verifiedAt: new Date() } },
      { new: true, runValidators: true }
    );
    if (!grn) throw grnError(409, 'Only a draft GRN can be verified.');
    return res.json({ success: true, message: 'GRN verified and ready for posting approval.', data: grn });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.patch('/grn/:id/approve', requirePermission('grn.approve'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let posted;
    let replayed = false;
    await session.withTransaction(async () => {
      const grn = await GRN.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!grn) throw grnError(404, 'GRN not found.');
      if (grn.status === 'posted') {
        posted = grn;
        replayed = true;
        return;
      }
      if (!['verified', 'approved'].includes(grn.status)) {
        throw grnError(409, `Verify the GRN before posting it from ${grn.status} status.`);
      }
      if (!grn.purchaseOrder) throw grnError(409, 'A purchase order is required before a GRN can be posted.');

      const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrder, branch: req.branchId }).session(session);
      if (!po) throw grnError(404, 'Purchase order not found in the active branch.');
      if (!['approved', 'sent', 'partial_received'].includes(po.status)) {
        throw grnError(409, 'Only an approved purchase order can be received.');
      }
      if (receiptId(po.supplier) !== receiptId(grn.supplier)) {
        throw grnError(422, 'GRN supplier does not match the purchase order supplier.');
      }
      const supplier = await Supplier.findOne({ _id: grn.supplier, status: 'active' }).session(session).lean();
      if (!supplier) throw grnError(404, 'Active supplier not found.');

      const normalizedItems = normalizeGRNItems({
        items: grn.items,
        po,
        branchId: req.branchId,
        grnNumber: grn.grnNumber,
      });
      await assertWarehousesInBranch(
        normalizedItems.filter(item => item.receivedQty > 0).map(item => item.warehouse),
        req.branchId,
        { session }
      );
      grn.items = normalizedItems;

      await updateStockFromGRN(grn, session, req.user._id);
      await updatePOReceivedQty(po, grn.items, session);
      grn.status = 'posted';
      grn.postedBy = req.user._id;
      grn.postedAt = new Date();
      grn.payableRecognition = 'none';
      await grn.save({ session });
      posted = grn;
    });
    return res.json({
      success: true,
      message: replayed
        ? 'GRN is already posted.'
        : 'GRN posted. Stock and PO quantities updated; supplier payable will be recognized after invoice verification.',
      data: posted,
    });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

// Helper: Update stock from accepted GRN items and append exact source-line movements.
async function updateStockFromGRN(grn, session, actor) {
  const occurredAt = new Date();
  for (const item of grn.items) {
    const acceptedQty = Number(item.acceptedQty);
    if (acceptedQty <= 0) continue;
    await applyStockMovement({
      operationKey: stockOperationKey('grn', grn._id, item._id, 'accepted'),
      correlationKey: stockOperationKey('grn', grn._id),
      movementType: 'grn_receipt',
      phase: 'posted',
      branch: grn.branch,
      product: item.product,
      warehouse: item.warehouse,
      shade: item.shade || '',
      batch: item.batch || '',
      deltas: { totalQty: acceptedQty, availableQty: acceptedQty },
      upsert: true,
      stockSet: {
        zone: item.zone || '', rack: item.rack || '', bin: item.bin || '',
        purchaseRate: Number(item.rate), lastGRNDate: occurredAt,
      },
      enteredQuantity: acceptedQty,
      enteredUnit: item.unit || 'Box',
      baseUnit: item.unit || 'Box',
      conversionFactor: 1,
      sourceType: 'GRN',
      sourceModel: 'GRN',
      sourceId: grn._id,
      sourceLineId: item._id,
      sourceNumber: grn.grnNumber,
      actor,
      occurredAt,
      reason: 'Accepted goods receipt',
      remarks: item.remarks || grn.qcRemarks || '',
      metadata: { purchaseOrder: grn.purchaseOrder, purchaseOrderItem: item.purchaseOrderItem, receiptCode: item.receiptCode },
    }, { session });
  }
}

// Helper: Update PO quantities using acceptedQty only
async function updatePOReceivedQty(po, grnItems, session) {
  for (const [index, item] of grnItems.entries()) {
    const acceptedQty = Number(item.acceptedQty || 0);
    if (acceptedQty <= 0) continue;
    const poItem = po.items.id(item.purchaseOrderItem);
    if (!poItem || receiptId(poItem.product) !== receiptId(item.product)) {
      throw grnError(422, `GRN item ${index + 1} does not match its purchase order line.`);
    }
    const pendingQty = Number(poItem.pendingQty ?? Math.max(0, Number(poItem.quantity) - Number(poItem.receivedQty || 0)));
    if (acceptedQty > pendingQty + 0.000001) {
      throw grnError(422, `GRN item ${index + 1} accepted quantity exceeds its purchase order line pending quantity.`);
    }
    poItem.receivedQty = receiptRound(Number(poItem.receivedQty || 0) + acceptedQty);
    poItem.pendingQty = receiptRound(Math.max(0, Number(poItem.quantity) - poItem.receivedQty));
  }

  const allReceived = po.items.every(item => Number(item.pendingQty) <= 0.000001);
  const someReceived = po.items.some(item => Number(item.receivedQty) > 0);
  if (allReceived) po.status = 'received';
  else if (someReceived) po.status = 'partial_received';
  await po.save({ session });
}

// ═══════════════════════════════════════
// STOCK
// ═══════════════════════════════════════
router.get('/stock', requirePermission('stock.view'), async (req, res) => {
  try {
    const result = await listStocks(req.branchId, req.query);
    const branchTotals = await getStockSummary(req.branchId);
    return res.json({ success: true, data: result.data, pagination: result.pagination, totals: result.totals, branchTotals });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/stock/summary', requirePermission('stock.view'), async (req, res) => {
  try {
    const summary = await getStockSummary(req.branchId);
    return res.json({ success: true, data: { ...summary, inventoryValue: summary.totalValue, totalValue: summary.availableValue } });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// Stock adjustment (manual — transactionally journaled and idempotent)
router.post('/stock/adjust', requireLegacyAdjustmentOrAll('stock.adjustment.create', 'stock.adjustment.submit'), async (req, res) => {
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!idempotencyKey || idempotencyKey.length > 200) return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  if (!reason) return res.status(422).json({ success: false, message: 'reason is required.' });
  try {
    const durable = await createSubmittedLegacyAdjustment({ branchId: req.branchId, actorId: req.user._id, body: req.body, idempotencyKey });
    return res.json({
      success: true,
      message: durable.replayed
        ? 'Stock adjustment request already exists and remains subject to approval.'
        : 'Stock adjustment submitted for independent approval. No stock has been posted.',
      status: durable.document.status,
      data: durable.document,
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message, ...(error.details ? { details: error.details } : {}) });
  }

  /* Retained below only as unreachable historical context; durable workflow above always returns. */
  const { product, warehouse, shade = '', batch = '' } = req.body;
  let signedQuantity;
  if (req.body.adjustmentQty !== undefined) {
    signedQuantity = Number(req.body.adjustmentQty);
  } else {
    const quantity = Number(req.body.quantity);
    const adjustmentType = String(req.body.adjustmentType || req.body.type || '').toLowerCase();
    if (!Number.isFinite(quantity) || quantity <= 0) return res.status(422).json({ success: false, message: 'quantity must be a positive finite number.' });
    if (['increase', 'add', 'in', 'positive'].includes(adjustmentType)) signedQuantity = quantity;
    else if (['decrease', 'subtract', 'remove', 'out', 'negative'].includes(adjustmentType)) signedQuantity = -quantity;
    else return res.status(422).json({ success: false, message: 'adjustmentType must identify an increase or decrease.' });
  }
  if (!product || !warehouse || !Number.isFinite(signedQuantity) || signedQuantity === 0) {
    return res.status(422).json({ success: false, message: 'product, warehouse, and a non-zero finite adjustment quantity are required.' });
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      await assertWarehousesInBranch([warehouse], req.branchId, { session });
      const productRecord = await Product.findById(product).session(session).lean();
      const uom = await resolveStockUom({ product: productRecord || product, enteredQuantity: Math.abs(signedQuantity), enteredUnit: req.body.unit || productRecord?.unit, session });
      const signedBaseQuantity = signedQuantity < 0 ? -uom.baseQuantity : uom.baseQuantity;
      const operationKey = stockOperationKey(req.branchId, 'manual-adjustment', idempotencyKey);
      result = await applyStockMovement({
        operationKey,
        correlationKey: operationKey,
        movementType: 'manual_adjustment',
        phase: 'posted',
        branch: req.branchId, product, warehouse, shade, batch,
        deltas: { totalQty: signedBaseQuantity, availableQty: signedBaseQuantity },
        upsert: signedBaseQuantity > 0,
        ...uom,
        sourceType: 'ManualStockAdjustment', sourceModel: 'Stock',
        sourceId: deterministicSourceId(operationKey), sourceLineId: 'manual', sourceNumber: idempotencyKey,
        actor: req.user._id, occurredAt: new Date(), reason, remarks: req.body.remarks || '',
        metadata: { adjustmentType: signedBaseQuantity > 0 ? 'increase' : 'decrease', enteredSignedQuantity: signedQuantity, baseSignedQuantity: signedBaseQuantity },
        guardMessage: 'Stock is missing or insufficient for this adjustment.',
      }, { session });
    });
    return res.json({ success: true, message: result.replayed ? 'Stock adjustment already applied.' : `Stock adjusted by ${signedQuantity}.`, data: result.stock });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

// Legacy instant transfer — retained for compatibility, now paired and journaled atomically.
router.post('/stock/transfer', requirePermission('stock.transfer'), async (req, res) => {
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  const reason = String(req.body.reason || '').trim();
  const { product, fromWarehouse, toWarehouse, shade = '', batch = '' } = req.body;
  const quantity = Number(req.body.quantity);
  if (!idempotencyKey || idempotencyKey.length > 200) return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  if (!reason) return res.status(422).json({ success: false, message: 'reason is required.' });
  if (!product || !fromWarehouse || !toWarehouse || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(422).json({ success: false, message: 'product, source, destination, and a positive finite quantity are required.' });
  }
  if (String(fromWarehouse) === String(toWarehouse)) return res.status(422).json({ success: false, message: 'Source and destination warehouses must differ.' });
  const session = await mongoose.startSession();
  try {
    let sourceResult;
    let destinationResult;
    await session.withTransaction(async () => {
      await assertWarehousesInBranch([fromWarehouse, toWarehouse], req.branchId, { session });
      const productRecord = await Product.findById(product).session(session).lean();
      const uom = await resolveStockUom({ product: productRecord || product, enteredQuantity: quantity, enteredUnit: req.body.unit || productRecord?.unit, session });
      const baseQuantity = uom.baseQuantity;
      const correlationKey = stockOperationKey(req.branchId, 'legacy-transfer', idempotencyKey);
      const sourceId = deterministicSourceId(correlationKey);
      const common = {
        correlationKey, movementType: 'legacy_transfer', phase: 'posted', branch: req.branchId,
        product, shade, batch, ...uom,
        sourceType: 'LegacyStockTransfer', sourceModel: 'Stock', sourceId, sourceNumber: idempotencyKey,
        actor: req.user._id, occurredAt: new Date(), reason, remarks: req.body.remarks || '',
      };
      sourceResult = await applyStockMovement({
        ...common, operationKey: `${correlationKey}:source`, sourceLineId: 'source', warehouse: fromWarehouse,
        relatedBranch: req.branchId, relatedWarehouse: toWarehouse,
        deltas: { totalQty: -baseQuantity, availableQty: -baseQuantity },
        guardMessage: 'Insufficient stock in source warehouse.',
        metadata: { leg: 'source' },
      }, { session });
      destinationResult = await applyStockMovement({
        ...common, operationKey: `${correlationKey}:destination`, sourceLineId: 'destination', warehouse: toWarehouse,
        relatedBranch: req.branchId, relatedWarehouse: fromWarehouse,
        deltas: { totalQty: baseQuantity, availableQty: baseQuantity }, upsert: true,
        metadata: { leg: 'destination' },
      }, { session });
    });
    return res.json({
      success: true,
      message: sourceResult.replayed && destinationResult.replayed ? 'Transfer already applied.' : `${quantity} units transferred.`,
      data: { source: sourceResult.stock, destination: destinationResult.stock, correlationKey: sourceResult.movement.correlationKey },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

// ═══════════════════════════════════════
// STOCK ALERTS (Low Stock)
// ═══════════════════════════════════════
router.get('/stock/alerts', requirePermission('stock.view'), async (req, res) => {
  try {
    const result = await getCanonicalStockAlerts(req.branchId, {
      warehouse: req.query.warehouse,
      includeAdequate: false,
      sortBy: 'available',
      sortOrder: 'asc',
    }, { internalAll: true });
    const items = result.data.map(row => ({
      _id: row.stockIds[0] || row.product,
      product: {
        _id: row.product,
        productCode: row.productCode,
        itemName: row.productName,
        images: row.productImage ? [row.productImage] : [],
        tileSize: row.tileSize,
        reorderLevel: row.thresholds.configuredReorderLevel,
      },
      warehouse: row.warehouse,
      shade: row.buckets.length === 1 ? row.buckets[0].shade : '',
      batch: row.buckets.length === 1 ? row.buckets[0].batch : '',
      ...row.quantities,
      purchaseRate: row.valuation.effectiveRate,
      landingCost: 0,
      alertLevel: row.severity,
      stockIds: row.stockIds,
      bucketBreakdown: row.buckets,
      thresholds: row.thresholds,
      configurationWarnings: row.configurationWarnings,
    }));
    return res.json({
      success: true,
      data: {
        items,
        summary: {
          total: items.length,
          zeroStock: result.summary.outOfStock,
          criticalStock: result.summary.critical,
          threshold: result.scope.fallbackReorderLevel,
        },
      },
    });
  } catch (error) {
    return res.status(error.status || (error.name === 'CastError' ? 422 : 500)).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════
// PHYSICAL AUDIT (Stock Count)
// ═══════════════════════════════════════

// GET /api/v1/purchase/audit/pending — get products to audit for a warehouse
router.get('/audit/pending', requireAnyPermission('stock.audit.create', 'stock.audit.count', 'stock.adjustment'), async (req, res) => {
  try {
    const { warehouse } = req.query;
    if (!warehouse) return res.status(400).json({ success: false, message: 'Warehouse is required.' });
    await assertWarehousesInBranch([warehouse], req.branchId);

    const stocks = await Stock.find({ branch: req.branchId, warehouse })
      .populate('product', 'productCode itemName tileSize images brand')
      .populate('warehouse', 'name')
      .sort({ 'product.itemName': 1 })
      .lean();

    res.json({ success: true, data: stocks });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/purchase/audit/submit — all-or-nothing decimal-safe physical count.
router.post('/audit/submit', requireAllPermissions('stock.audit.create', 'stock.audit.count', 'stock.audit.submit'), async (req, res) => {
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  const { warehouse, counts } = req.body;
  const remarks = String(req.body.remarks || '').trim();
  if (!idempotencyKey || idempotencyKey.length > 200) return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  if (!warehouse || !Array.isArray(counts) || !counts.length) return res.status(422).json({ success: false, message: 'warehouse and counts are required.' });
  try {
    const durable = await createSubmittedLegacyAudit({ branchId: req.branchId, actorId: req.user._id, body: req.body, idempotencyKey });
    const document = durable.document;
    const countedLines = document.lines.filter((line) => line.physicalCount !== undefined && line.physicalCount !== null);
    return res.json({
      success: true,
      message: durable.replayed
        ? 'Physical audit request already exists and remains subject to approval.'
        : 'Physical audit submitted for independent approval. No stock has been posted.',
      status: document.status,
      data: {
        ...document.toObject(),
        totalItems: countedLines.length,
        adjustedItems: 0,
        totalDiscrepancy: receiptRound(document.totalVariance),
        results: countedLines.map((line) => ({ stockId: line.stock, product: line.product, systemQty: line.expectedPhysicalOnPremise, physicalQty: line.physicalCount, discrepancy: line.variance, adjusted: false, status: 'submitted' })),
      },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message, ...(error.details ? { details: error.details } : {}) });
  }

  /* Retained below only as unreachable historical context; durable workflow above always returns. */
  const normalized = [];
  const ids = new Set();
  for (let index = 0; index < counts.length; index += 1) {
    const stockId = String(counts[index].stockId || '');
    const physicalQty = Number(counts[index].physicalCount);
    if (!mongoose.isValidObjectId(stockId) || ids.has(stockId) || !Number.isFinite(physicalQty) || physicalQty < 0) {
      return res.status(422).json({ success: false, message: `counts[${index}] requires a unique valid stockId and a finite nonnegative physicalCount.` });
    }
    ids.add(stockId);
    normalized.push({ stockId, physicalQty: receiptRound(physicalQty), unit: counts[index].unit || req.body.unit || '', remarks: String(counts[index].remarks || '') });
  }
  const auditFingerprint = fingerprintRequest({
    warehouse: String(warehouse),
    counts: normalized,
    remarks,
    actor: String(req.user._id),
    enteredUnit: String(req.body.unit || 'Unit'),
    baseUnit: String(req.body.baseUnit || req.body.unit || 'Unit'),
    conversionFactor: 1,
  });
  const session = await mongoose.startSession();
  try {
    let results = [];
    await session.withTransaction(async () => {
      await assertWarehousesInBranch([warehouse], req.branchId, { session });
      const correlationKey = stockOperationKey(req.branchId, 'physical-audit', idempotencyKey);
      const operationKeys = normalized.map(count => `${correlationKey}:${count.stockId}`);
      const existingMovements = await StockMovement.find({ branch: req.branchId, operationKey: { $in: operationKeys } }).session(session).lean();
      if (existingMovements.length) {
        if (existingMovements.length !== normalized.length) throw grnError(409, 'This audit idempotency key has an incomplete movement set.');
        const existingByKey = new Map(existingMovements.map(movement => [movement.operationKey, movement]));
        results = normalized.map((count) => {
          const movement = existingByKey.get(`${correlationKey}:${count.stockId}`);
          if (!movement || String(movement.stock) !== count.stockId || movement.metadata?.requestFingerprint !== auditFingerprint) {
            throw grnError(409, 'This Idempotency-Key was already used for a different physical audit payload.');
          }
          const metadata = movement.metadata || {};
          const ownedTotalBefore = receiptRound(Number(metadata.ownedTotalBefore ?? movement.before?.totalQty ?? 0));
          const transitQty = receiptRound(Number(metadata.transitQty ?? 0));
          const expectedPhysicalOnPremise = receiptRound(Number(metadata.expectedPhysicalOnPremise ?? metadata.systemQty ?? ownedTotalBefore - transitQty));
          const availableBefore = receiptRound(Number(metadata.availableBefore ?? movement.before?.availableQty ?? 0));
          const classifiedBuckets = metadata.classifiedBuckets || {
            reservedQty: receiptRound(Number(metadata.reservedQty ?? movement.before?.reservedQty ?? 0)),
            blockedQty: receiptRound(Number(metadata.blockedQty ?? movement.before?.blockedQty ?? 0)),
            damagedQty: receiptRound(Number(metadata.damagedQty ?? movement.before?.damagedQty ?? 0)),
            sampleQty: receiptRound(Number(metadata.sampleQty ?? movement.before?.sampleQty ?? 0)),
            shortQty: receiptRound(Number(metadata.shortQty ?? movement.before?.shortQty ?? 0)),
          };
          const physicalQty = receiptRound(Number(metadata.physicalQty ?? movement.enteredQuantity ?? 0));
          const discrepancy = receiptRound(Number(metadata.discrepancy ?? movement.deltas?.totalQty ?? 0));
          return {
            stockId: movement.stock, product: movement.product,
            ownedTotalBefore, transitQty, expectedPhysicalOnPremise, availableBefore,
            classifiedBuckets, physicalQty, discrepancy,
            systemQty: expectedPhysicalOnPremise,
            adjusted: Math.abs(discrepancy) > 0,
            replayed: true,
          };
        });
        return;
      }
      const stocks = await Stock.find({ _id: { $in: normalized.map(item => item.stockId) }, branch: req.branchId, warehouse }).session(session);
      if (stocks.length !== normalized.length) throw grnError(422, 'Every count must reference an existing stock bucket in the selected branch and warehouse.');
      const stockById = new Map(stocks.map(stock => [String(stock._id), stock]));
      results = [];
      for (const count of normalized) {
        const stock = stockById.get(count.stockId);
        const ownedTotalBefore = receiptRound(Number(stock.totalQty || 0));
        const transitQty = receiptRound(Number(stock.transitQty || 0));
        const expectedPhysicalOnPremise = receiptRound(ownedTotalBefore - transitQty);
        const availableBefore = receiptRound(Number(stock.availableQty || 0));
        const classifiedBuckets = {
          reservedQty: receiptRound(Number(stock.reservedQty || 0)),
          blockedQty: receiptRound(Number(stock.blockedQty || 0)),
          damagedQty: receiptRound(Number(stock.damagedQty || 0)),
          sampleQty: receiptRound(Number(stock.sampleQty || 0)),
          shortQty: receiptRound(Number(stock.shortQty || 0)),
        };
        const uom = await resolveStockUom({ product: stock.product, enteredQuantity: count.physicalQty, enteredUnit: count.unit || undefined, session });
        const physicalBaseQty = receiptRound(uom.baseQuantity);
        const discrepancy = receiptRound(physicalBaseQty - expectedPhysicalOnPremise);
        if (receiptRound(availableBefore + discrepancy) < 0) {
          throw grnError(409, `Physical count for stock ${stock._id} is below its reserved, blocked, damaged or sample classifications; available stock would become negative.`);
        }
        const movement = await applyStockMovement({
          operationKey: `${correlationKey}:${stock._id}`,
          correlationKey,
          movementType: 'physical_count', phase: 'counted',
          branch: req.branchId, product: stock.product, warehouse: stock.warehouse, shade: stock.shade, batch: stock.batch,
          deltas: { totalQty: discrepancy, availableQty: discrepancy }, allowZeroDeltas: true,
          enteredQuantity: count.physicalQty, ...uom,
          sourceType: 'PhysicalStockAudit', sourceModel: 'Stock', sourceId: deterministicSourceId(correlationKey),
          sourceLineId: stock._id, sourceNumber: idempotencyKey, actor: req.user._id, occurredAt: new Date(),
          reason: 'Physical stock count', remarks: count.remarks || remarks,
          metadata: {
            ownedTotalBefore, transitQty, expectedPhysicalOnPremise, availableBefore,
            ...classifiedBuckets, classifiedBuckets,
            physicalQty: count.physicalQty, physicalBaseQty, discrepancy,
            auditedBy: req.user._id, requestFingerprint: auditFingerprint,
          },
          guardMessage: 'Physical count would make available stock negative or the bucket changed concurrently.',
        }, { session });
        results.push({
          stockId: stock._id, product: stock.product,
          ownedTotalBefore, transitQty, expectedPhysicalOnPremise, availableBefore,
          classifiedBuckets, physicalQty: count.physicalQty, discrepancy,
          systemQty: expectedPhysicalOnPremise,
          adjusted: Math.abs(discrepancy) > 0.000001,
          replayed: movement.replayed,
        });
      }
    });
    const adjustedCount = results.filter(item => item.adjusted).length;
    const totalDiscrepancy = receiptRound(results.reduce((sum, item) => sum + Math.abs(item.discrepancy), 0));
    return res.json({ success: true, message: `Audit complete. ${adjustedCount} items adjusted. Total discrepancy: ${totalDiscrepancy} units.`, data: { totalItems: results.length, adjustedItems: adjustedCount, totalDiscrepancy, results } });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

// ═══════════════════════════════════════
// REORDER SUGGESTIONS (Out-of-stock → PO)
// ═══════════════════════════════════════

// GET /api/v1/purchase/stock/reorder-suggestions — compatibility shape backed by canonical stock alerts
router.get('/stock/reorder-suggestions', requirePermission('stock.view'), async (req, res) => {
  try {
    const result = await getCanonicalStockAlerts(req.branchId, {
      warehouse: req.query.warehouse,
      includeAdequate: false,
      sortBy: 'severity',
      sortOrder: 'asc',
    }, { internalAll: true });
    const suggestions = result.data.map(row => {
      const urgency = row.severity === 'out_of_stock' ? 'critical' : row.severity === 'critical' ? 'high' : 'medium';
      return {
        product: row.product,
        productCode: row.productCode,
        productName: row.productName,
        productImage: row.productImage,
        brand: row.brand?.name || '',
        tileSize: row.tileSize,
        warehouse: row.warehouse?._id || null,
        warehouseName: row.warehouse?.name || 'All branch warehouses',
        stockScope: row.stockScope,
        configuredReorderLevel: row.thresholds.configuredReorderLevel,
        reorderLevel: row.thresholds.effectiveReorderLevel,
        reorderLevelSource: row.thresholds.reorderSource,
        minimumStockLevel: row.thresholds.effectiveMinStockLevel,
        currentStock: row.quantities.availableQty,
        deficit: row.deficit,
        suggestedQty: row.suggestedQuantity,
        netSuggestedQty: row.netSuggestedQuantity,
        lastPurchaseRate: row.lastReceipt?.rate || row.valuation.effectiveRate,
        suggestedSupplier: row.lastReceipt?.supplier || null,
        suggestedSupplierName: row.lastReceipt?.supplierName || 'No supplier history',
        lastReceiptAt: row.lastReceipt?.receivedAt || null,
        isZeroStock: row.quantities.availableQty <= 0,
        urgency,
        hasOpenRequisition: row.hasOpenRequisition,
        openRequisitions: row.openRequisitions,
        openPurchaseOrders: row.openPurchaseOrders,
        configurationWarnings: row.configurationWarnings,
        provenance: {
          source: 'reorder_suggestion',
          key: [req.branchId, row.warehouse?._id || 'all', row.product].map(String).join(':'),
          snapshotAt: result.scope.snapshotAt,
          branch: req.branchId,
          warehouse: row.warehouse?._id || null,
          configuredReorderLevel: row.thresholds.configuredReorderLevel,
          effectiveReorderLevel: row.thresholds.effectiveReorderLevel,
          minimumStockLevel: row.thresholds.effectiveMinStockLevel,
        },
      };
    });
    return res.json({
      success: true,
      data: suggestions,
      scope: {
        branch: req.branchId,
        warehouse: result.scope.warehouse?._id || null,
        warehouseName: result.scope.warehouse?.name || 'All branch warehouses',
        snapshotAt: result.scope.snapshotAt,
        fallbackLevel: result.scope.fallbackReorderLevel,
        minStockFallbackLevel: result.scope.fallbackMinStockLevel,
        minimumReorderQuantity: result.scope.minimumReorderQuantity,
      },
      summary: {
        total: suggestions.length,
        critical: suggestions.filter(item => item.urgency === 'critical').length,
        high: suggestions.filter(item => item.urgency === 'high').length,
        medium: suggestions.filter(item => item.urgency === 'medium').length,
      },
    });
  } catch (error) {
    return res.status(error.status || (error.name === 'CastError' ? 422 : 500)).json({ success: false, message: error.message });
  }
});

// Direct purchase-order creation from stock suggestions is intentionally disabled.
router.post('/stock/create-po-from-suggestions', requirePermission('po.management'), (_req, res) => res.status(405).json({
  success: false,
  code: 'PR_SUPPLIER_QUOTATION_REQUIRED',
  message: 'Create a purchase requisition, compare supplier quotations, and convert the selected quotation to a purchase order.',
}));

export default router;
