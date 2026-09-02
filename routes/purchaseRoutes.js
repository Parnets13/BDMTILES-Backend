import { Router } from 'express';
import mongoose from 'mongoose';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Product from '../models/Product.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import Supplier from '../models/Supplier.js';
import BranchSettings from '../models/BranchSettings.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import {
  actionPurchaseOrderApproval,
  amendmentDiff,
  assertPurchaseOrderSourceIntegrity,
  calculatePurchaseOrder,
  purchaseOrderSnapshot,
  submitPurchaseOrder,
} from '../services/purchaseOrderService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

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

      await updateStockFromGRN(grn, session);
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
        .populate('product', 'productCode itemName tileSize finish brand images reorderLevel minStockLevel')
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

// GET /api/v1/purchase/stock/reorder-suggestions — branch/warehouse scoped, server-authoritative guidance
router.get('/stock/reorder-suggestions', requirePermission('stock.view'), async (req, res) => {
  try {
    const { warehouse } = req.query;
    let warehouseRecord = null;
    if (warehouse) [warehouseRecord] = await assertWarehousesInBranch([warehouse], req.branchId);

    const [settings, products] = await Promise.all([
      BranchSettings.findOne({ branch: req.branchId }).select('inventory').lean(),
      Product.find({ status: 'active' })
        .select('productCode itemName brand category tileSize reorderLevel minStockLevel images basicPrice')
        .populate('brand', 'name')
        .lean(),
    ]);
    if (!products.length) return res.json({ success: true, data: [] });

    const fallbackLevel = Math.max(1, Number(settings?.inventory?.reorderFallbackLevel || 10));
    const minimumReorderQuantity = Math.max(1, Number(settings?.inventory?.minimumReorderQuantity || 10));
    const productIds = products.map(product => product._id);
    const stockFilter = { branch: req.branchId, ...(warehouse ? { warehouse: warehouseRecord._id } : {}) };
    const grnMatch = {
      branch: new mongoose.Types.ObjectId(String(req.branchId)),
      status: { $in: ['approved', 'posted'] },
    };
    const grnItemMatch = {
      'items.product': { $in: productIds },
      ...(warehouse ? { 'items.warehouse': warehouseRecord._id } : {}),
    };
    const [stockAgg, supplierHistory] = await Promise.all([
      Stock.aggregate([
        { $match: stockFilter },
        { $group: { _id: '$product', currentStock: { $sum: '$availableQty' }, stockRate: { $max: '$purchaseRate' } } },
      ]),
      GRN.aggregate([
        { $match: grnMatch },
        { $unwind: '$items' },
        { $match: grnItemMatch },
        { $sort: { createdAt: -1, _id: -1 } },
        { $group: {
          _id: '$items.product',
          supplier: { $first: '$supplier' },
          supplierName: { $first: '$supplierName' },
          rate: { $first: '$items.rate' },
          grn: { $first: '$_id' },
          receivedAt: { $first: '$createdAt' },
        } },
      ]),
    ]);
    const stockMap = new Map(stockAgg.map(stock => [String(stock._id), stock]));
    const historyMap = new Map(supplierHistory.map(history => [String(history._id), history]));
    const snapshotAt = new Date();
    const scopeWarehouse = warehouseRecord?._id || null;
    const scopeWarehouseName = warehouseRecord?.name || 'All branch warehouses';

    const suggestions = products.flatMap(product => {
      const stock = stockMap.get(String(product._id)) || { currentStock: 0, stockRate: 0 };
      const currentStock = Number(stock.currentStock || 0);
      const configuredReorderLevel = Number(product.reorderLevel || 0);
      const effectiveReorderLevel = configuredReorderLevel > 0 ? configuredReorderLevel : fallbackLevel;
      if (currentStock > effectiveReorderLevel) return [];
      const minimumStockLevel = Number(product.minStockLevel || 0);
      const minimumQty = minimumStockLevel > 0 ? minimumStockLevel : minimumReorderQuantity;
      const suggestedQty = Math.max(effectiveReorderLevel * 2 - currentStock, minimumQty);
      const history = historyMap.get(String(product._id));
      const provenanceKey = [req.branchId, scopeWarehouse || 'all', product._id].map(String).join(':');
      return [{
        product: product._id,
        productCode: product.productCode,
        productName: product.itemName,
        productImage: product.images?.[0] || '',
        brand: product.brand?.name || '',
        tileSize: product.tileSize || '',
        warehouse: scopeWarehouse,
        warehouseName: scopeWarehouseName,
        stockScope: warehouse ? 'warehouse' : 'branch',
        configuredReorderLevel,
        reorderLevel: effectiveReorderLevel,
        reorderLevelSource: configuredReorderLevel > 0 ? 'product' : 'branch_fallback',
        minimumStockLevel,
        currentStock,
        deficit: Math.max(0, effectiveReorderLevel - currentStock),
        suggestedQty,
        lastPurchaseRate: Number(history?.rate || stock.stockRate || product.basicPrice || 0),
        suggestedSupplier: history?.supplier || null,
        suggestedSupplierName: history?.supplierName || 'No supplier history',
        lastReceiptAt: history?.receivedAt || null,
        isZeroStock: currentStock <= 0,
        urgency: currentStock <= 0 ? 'critical' : currentStock <= effectiveReorderLevel / 2 ? 'high' : 'medium',
        provenance: {
          source: 'reorder_suggestion', key: provenanceKey, snapshotAt,
          branch: req.branchId, warehouse: scopeWarehouse,
          configuredReorderLevel, effectiveReorderLevel, minimumStockLevel,
        },
      }];
    });

    const urgencyOrder = { critical: 0, high: 1, medium: 2 };
    suggestions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || a.productName.localeCompare(b.productName));
    res.json({
      success: true,
      data: suggestions,
      scope: { branch: req.branchId, warehouse: scopeWarehouse, warehouseName: scopeWarehouseName, snapshotAt, fallbackLevel, minimumReorderQuantity },
      summary: {
        total: suggestions.length,
        critical: suggestions.filter(item => item.urgency === 'critical').length,
        high: suggestions.filter(item => item.urgency === 'high').length,
        medium: suggestions.filter(item => item.urgency === 'medium').length,
      },
    });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
});

// Direct purchase-order creation from stock suggestions is intentionally disabled.
router.post('/stock/create-po-from-suggestions', requirePermission('po.management'), (_req, res) => res.status(405).json({
  success: false,
  code: 'PR_SUPPLIER_QUOTATION_REQUIRED',
  message: 'Create a purchase requisition, compare supplier quotations, and convert the selected quotation to a purchase order.',
}));

export default router;
