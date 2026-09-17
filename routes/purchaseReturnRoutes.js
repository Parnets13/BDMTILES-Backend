import { Router } from 'express';
import mongoose from 'mongoose';
import PurchaseReturn from '../models/PurchaseReturn.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import SupplierInvoice from '../models/SupplierInvoice.js';
import GRN from '../models/GRN.js';
import { applyStockMovement, stockOperationKey } from '../services/stockMovementService.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const ACTIVE_INVOICE_STATUSES = ['verified', 'partial', 'paid'];
const lineKey = (item) => `${String(item.product)}|${String(item.warehouse)}|${item.shade || ''}|${item.batch || ''}`;
const stockKey = lineKey;
const routeError = (status, message) => Object.assign(new Error(message), { status });
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function invoiceLineValues(source, quantity) {
  const invoiceQuantity = Number(source.invoiceQuantity || 0);
  if (!Number.isFinite(invoiceQuantity) || invoiceQuantity <= 0) {
    throw routeError(409, 'The source supplier invoice contains an invalid quantity.');
  }
  const ratio = quantity / invoiceQuantity;
  return {
    rate: Number(source.rate || 0),
    discountAmount: roundMoney(Number(source.discountAmount || 0) * ratio),
    taxableAmount: roundMoney(Number(source.taxableAmount || 0) * ratio),
    gstPercentage: Number(source.gstPercentage || 0),
    gstAmount: roundMoney(Number(source.taxAmount || 0) * ratio),
    totalAmount: roundMoney(Number(source.totalAmount || 0) * ratio),
  };
}

async function validateReturnItems(data, supplierInvoice, grn, purchaseOrder, options = {}) {
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw routeError(422, 'At least one return item is required.');
  }
  if (!purchaseOrder || String(grn.purchaseOrder || '') !== String(purchaseOrder._id)) {
    throw routeError(422, 'Exact purchase-order lineage is required for every Purchase Return.');
  }

  const invoiceLines = new Map((supplierInvoice.items || []).map((item) => [String(item._id), item]));
  const grnLines = new Map((grn.items || []).map((item) => [String(item._id), item]));
  const purchaseOrderLines = new Map((purchaseOrder.items || []).map((item) => [String(item._id), item]));
  const requested = new Map();
  const normalizedItems = [];

  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index];
    const returnQty = Number(item.returnQty);
    const source = invoiceLines.get(String(item.supplierInvoiceItem || ''));
    if (!source || !Number.isFinite(returnQty) || returnQty <= 0) {
      throw routeError(422, `items[${index}] requires a valid supplierInvoiceItem and a finite returnQty greater than zero.`);
    }
    if (String(source.grn) !== String(grn._id)) {
      throw routeError(422, `items[${index}] does not belong to the selected GRN.`);
    }
    const grnLine = grnLines.get(String(source.grnItem));
    const purchaseOrderLine = purchaseOrderLines.get(String(source.purchaseOrderItem || ''));
    if (!grnLine || String(grnLine.product) !== String(source.product)) {
      throw routeError(409, `items[${index}] no longer matches its exact GRN line.`);
    }
    if (!source.purchaseOrder || String(source.purchaseOrder) !== String(purchaseOrder._id)
      || !source.purchaseOrderItem || !grnLine.purchaseOrderItem
      || String(source.purchaseOrderItem) !== String(grnLine.purchaseOrderItem)
      || !purchaseOrderLine || String(purchaseOrderLine.product) !== String(source.product)) {
      throw routeError(409, `items[${index}] lacks exact supplier-invoice, GRN, and purchase-order line lineage.`);
    }
    const maximumQuantity = Math.min(Number(source.invoiceQuantity || 0), Number(grnLine.acceptedQty || 0));
    if (!Number.isFinite(maximumQuantity) || maximumQuantity <= 0) {
      throw routeError(409, `items[${index}] has no accepted and invoiced quantity available to return.`);
    }

    const sourceId = String(source._id);
    requested.set(sourceId, (requested.get(sourceId) || 0) + returnQty);
    normalizedItems.push({
      supplierInvoiceItem: source._id,
      grnItem: source.grnItem,
      purchaseOrderItem: source.purchaseOrderItem,
      product: source.product,
      productCode: source.productCode || grnLine.productCode || '',
      productName: source.productName || grnLine.productName || '',
      shade: grnLine.shade || '',
      batch: grnLine.batch || '',
      returnQty,
      unit: source.unit || grnLine.unit || 'Box',
      reason: item.reason,
      reasonDetails: item.reasonDetails || '',
      warehouse: grnLine.warehouse,
      ...invoiceLineValues(source, returnQty),
    });
  }

  let query = PurchaseReturn.find({
    branch: data.branch,
    status: { $nin: ['cancelled', 'reversed'] },
    $or: [
      { supplierInvoice: supplierInvoice._id },
      { grn: grn._id, supplierInvoice: { $exists: false } },
      { grn: grn._id, supplierInvoice: null },
    ],
    ...(options.excludeId ? { _id: { $ne: options.excludeId } } : {}),
  }).select('items').lean();
  if (options.session) query = query.session(options.session);
  const previousByLine = new Map();
  const previousLegacy = new Map();
  for (const existing of await query) {
    for (const item of existing.items || []) {
      if (item.supplierInvoiceItem) {
        const key = String(item.supplierInvoiceItem);
        previousByLine.set(key, (previousByLine.get(key) || 0) + Number(item.returnQty || 0));
      } else {
        const key = lineKey(item);
        previousLegacy.set(key, (previousLegacy.get(key) || 0) + Number(item.returnQty || 0));
      }
    }
  }

  for (const [sourceId, quantity] of requested) {
    const source = invoiceLines.get(sourceId);
    const grnLine = grnLines.get(String(source.grnItem));
    const maximumQuantity = Math.min(Number(source.invoiceQuantity || 0), Number(grnLine.acceptedQty || 0));
    const priorQuantity = (previousByLine.get(sourceId) || 0) + (previousLegacy.get(lineKey(grnLine)) || 0);
    if (priorQuantity + quantity > maximumQuantity + 1e-9) {
      throw routeError(422, 'Return quantity exceeds the remaining accepted and invoiced quantity.');
    }
  }

  return normalizedItems;
}

function applyTotals(data) {
  data.subtotal = roundMoney(data.items.reduce((sum, item) => sum + Number(item.taxableAmount || 0), 0));
  data.totalTax = roundMoney(data.items.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0));
  data.grandTotal = roundMoney(data.items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0));
}

router.get('/', requirePermission('debit.note'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, supplier } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Number.parseInt(limit, 10) || 20);
    const filter = { branch: req.branchId };
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ debitNoteNumber: regex }, { supplierName: regex }, { supplierInvoiceNumber: regex }, { poNumber: regex }, { grnNumber: regex }];
    }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const [returns, total] = await Promise.all([
      PurchaseReturn.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('supplier', 'companyName supplierCode').populate('supplierInvoice', 'invoiceNumber invoiceDate').lean(),
      PurchaseReturn.countDocuments(filter),
    ]);
    return res.json({ success: true, data: returns, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/stats', requirePermission('debit.note'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, draft, approved, debitIssued, cancelled, reversed, totalValue] = await Promise.all([
      PurchaseReturn.countDocuments(scope),
      PurchaseReturn.countDocuments({ ...scope, status: 'draft' }),
      PurchaseReturn.countDocuments({ ...scope, status: 'approved' }),
      PurchaseReturn.countDocuments({ ...scope, status: 'debit_issued' }),
      PurchaseReturn.countDocuments({ ...scope, status: 'cancelled' }),
      PurchaseReturn.countDocuments({ ...scope, status: 'reversed' }),
      PurchaseReturn.aggregate([
        { $match: { ...scope, status: 'debit_issued' } },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } },
      ]),
    ]);
    return res.json({ success: true, data: { total, draft, approved, debitIssued, cancelled, reversed, totalDebitValue: totalValue[0]?.total || 0 } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/grns-for-supplier/:supplierId', requirePermission('debit.note'), async (req, res) => {
  try {
    const invoices = await SupplierInvoice.find({
      branch: req.branchId,
      supplier: req.params.supplierId,
      status: { $in: ACTIVE_INVOICE_STATUSES },
    }).populate('items.product', 'productCode itemName tileSize images').sort({ invoiceDate: -1 }).limit(50).lean();
    const grnIds = [...new Set(invoices.flatMap((invoice) => (invoice.linkedGRNs || []).map(String)))];
    const grns = await GRN.find({
      _id: { $in: grnIds },
      branch: req.branchId,
      supplier: req.params.supplierId,
      status: 'posted',
    }).select('grnNumber grnDate poNumber items purchaseOrder').lean();
    const grnById = new Map(grns.map((grn) => [String(grn._id), grn]));
    const existing = await PurchaseReturn.find({
      branch: req.branchId,
      supplier: req.params.supplierId,
      status: { $nin: ['cancelled', 'reversed'] },
      supplierInvoice: { $in: invoices.map((invoice) => invoice._id) },
    }).select('supplierInvoice items').lean();
    const returned = new Map();
    for (const purchaseReturn of existing) {
      for (const item of purchaseReturn.items || []) {
        if (!item.supplierInvoiceItem) continue;
        const key = `${purchaseReturn.supplierInvoice}:${item.supplierInvoiceItem}`;
        returned.set(key, (returned.get(key) || 0) + Number(item.returnQty || 0));
      }
    }

    const result = [];
    for (const invoice of invoices) {
      for (const grnId of invoice.linkedGRNs || []) {
        const grn = grnById.get(String(grnId));
        if (!grn) continue;
        const grnLines = new Map((grn.items || []).map((item) => [String(item._id), item]));
        const items = (invoice.items || []).filter((item) => String(item.grn) === String(grn._id)).map((item) => {
          const grnLine = grnLines.get(String(item.grnItem));
          if (!grnLine) return null;
          const maximumQuantity = Math.min(Number(item.invoiceQuantity || 0), Number(grnLine.acceptedQty || 0));
          const remainingReturnQty = Math.max(0, maximumQuantity - (returned.get(`${invoice._id}:${item._id}`) || 0));
          return {
            supplierInvoiceItem: item._id,
            grnItem: item.grnItem,
            purchaseOrderItem: item.purchaseOrderItem,
            product: item.product,
            productCode: item.productCode,
            productName: item.productName,
            shade: grnLine.shade || '',
            batch: grnLine.batch || '',
            acceptedQty: grnLine.acceptedQty,
            invoiceQuantity: item.invoiceQuantity,
            remainingReturnQty,
            unit: item.unit,
            rate: item.rate,
            discountAmount: item.discountAmount,
            taxableAmount: item.taxableAmount,
            gstPercentage: item.gstPercentage,
            gstAmount: item.taxAmount,
            totalAmount: item.totalAmount,
            warehouse: grnLine.warehouse,
          };
        }).filter((item) => item && item.remainingReturnQty > 0);
        if (items.length > 0) {
          result.push({
            ...grn,
            supplierInvoice: invoice._id,
            supplierInvoiceNo: invoice.invoiceNumber,
            supplierInvoiceNumber: invoice.invoiceNumber,
            purchaseOrder: items[0]?.purchaseOrder || grn.purchaseOrder,
            items,
          });
        }
      }
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    const status = error.name === 'CastError' ? 422 : 500;
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid supplier identifier.' : error.message });
  }
});

router.get('/:id', requirePermission('debit.note'), async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('supplier', 'companyName supplierCode mobile')
      .populate('supplierInvoice', 'invoiceNumber invoiceDate status')
      .populate('purchaseOrder', 'poNumber poDate')
      .populate('grn', 'grnNumber grnDate')
      .populate('items.product', 'productCode itemName tileSize images')
      .populate('items.warehouse', 'name')
      .lean();
    if (!purchaseReturn) return res.status(404).json({ success: false, message: 'Purchase Return not found.' });
    return res.json({ success: true, data: purchaseReturn });
  } catch (error) {
    return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.post('/', requirePermission('debit.note'), async (req, res) => {
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }
  const sourceKey = `${String(req.branchId)}:${rawIdempotencyKey}`;
  const requestFingerprint = fingerprintRequest(req.body);
  try {
    const existingReturn = await PurchaseReturn.findOne({ branch: req.branchId, sourceKey });
    if (existingReturn) {
      if (existingReturn.requestFingerprint && existingReturn.requestFingerprint !== requestFingerprint) {
        throw routeError(409, 'This Idempotency-Key was already used with a different request payload.');
      }
      return res.json({ success: true, message: 'Purchase Return already recorded.', data: existingReturn });
    }
    const supplier = await Supplier.findById(req.body.supplier).lean();
    if (!supplier) throw routeError(404, 'Supplier not found.');
    if (!req.body.grn || !req.body.supplierInvoice) {
      throw routeError(422, 'A posted GRN and verified supplier invoice are required.');
    }
    const [grn, supplierInvoice] = await Promise.all([
      GRN.findOne({ _id: req.body.grn, branch: req.branchId, status: 'posted' }).lean(),
      SupplierInvoice.findOne({
        _id: req.body.supplierInvoice,
        branch: req.branchId,
        supplier: supplier._id,
        status: { $in: ACTIVE_INVOICE_STATUSES },
      }).lean(),
    ]);
    if (!grn) throw routeError(404, 'Posted GRN not found in the active branch.');
    if (!supplierInvoice) throw routeError(404, 'Verified supplier invoice not found in the active branch.');
    if (String(grn.supplier) !== String(supplier._id)
      || !(supplierInvoice.linkedGRNs || []).some((id) => String(id) === String(grn._id))) {
      throw routeError(422, 'Supplier invoice, GRN, and supplier lineage do not match.');
    }

    const purchaseOrderId = req.body.purchaseOrder || grn.purchaseOrder;
    const purchaseOrder = purchaseOrderId
      ? await PurchaseOrder.findOne({ _id: purchaseOrderId, branch: req.branchId, supplier: supplier._id }).lean()
      : null;
    if (!purchaseOrder || String(grn.purchaseOrder || '') !== String(purchaseOrder._id)) {
      throw routeError(422, 'Purchase order, GRN, and supplier lineage do not match. Exact PO lineage is required.');
    }

    const data = {
      ...req.body,
      branch: req.branchId,
      supplier: supplier._id,
      supplierName: supplier.companyName,
      supplierInvoice: supplierInvoice._id,
      supplierInvoiceNumber: supplierInvoice.invoiceNumber,
      grn: grn._id,
      grnNumber: grn.grnNumber,
      purchaseOrder: purchaseOrder?._id,
      poNumber: purchaseOrder?.poNumber || grn.poNumber || '',
      sourceKey,
      requestFingerprint,
      status: 'draft',
      approvedBy: undefined,
      approvalDate: undefined,
      approvalRemarks: undefined,
      reversedBy: undefined,
      reversedAt: undefined,
      reversalReason: undefined,
      createdBy: req.user._id,
      tallySyncStatus: 'not_synced',
    };
    data.items = await validateReturnItems(data, supplierInvoice, grn, purchaseOrder);
    await assertWarehousesInBranch(data.items.map((item) => item.warehouse), req.branchId);
    applyTotals(data);
    data.debitNoteNumber = await generateBranchNumber(req.branchId, 'purchaseReturn', data.returnDate || new Date());

    const purchaseReturn = await PurchaseReturn.create(data);
    return res.status(201).json({ success: true, message: 'Purchase Return (Debit Note) created from the verified supplier invoice.', data: purchaseReturn });
  } catch (error) {
    if (error.code === 11000) {
      const existingReturn = await PurchaseReturn.findOne({ branch: req.branchId, sourceKey });
      if (existingReturn) {
        if (existingReturn.requestFingerprint && existingReturn.requestFingerprint !== requestFingerprint) {
          return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
        }
        return res.json({ success: true, message: 'Purchase Return already recorded.', data: existingReturn });
      }
    }
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.patch('/:id/approve', requirePermission('debit.note'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let purchaseReturn;
    await session.withTransaction(async () => {
      const current = await PurchaseReturn.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Purchase Return not found.');
      if (current.status === 'debit_issued') {
        purchaseReturn = current;
        return;
      }
      if (current.status !== 'draft') throw routeError(409, `Cannot approve a purchase return in ${current.status} status.`);
      if (current.createdBy && String(current.createdBy) === String(req.user._id)) {
        throw routeError(403, 'Maker-checker violation: the Purchase Return creator cannot approve it.');
      }

      const [grn, supplierInvoice, purchaseOrder] = await Promise.all([
        GRN.findOne({ _id: current.grn, branch: req.branchId, supplier: current.supplier, status: 'posted' }).session(session).lean(),
        SupplierInvoice.findOne({
          _id: current.supplierInvoice,
          branch: req.branchId,
          supplier: current.supplier,
          status: { $in: ACTIVE_INVOICE_STATUSES },
        }).session(session).lean(),
        PurchaseOrder.findOne({ _id: current.purchaseOrder, branch: req.branchId, supplier: current.supplier }).session(session).lean(),
      ]);
      if (!grn || !supplierInvoice || !purchaseOrder
        || String(grn.purchaseOrder || '') !== String(purchaseOrder._id)
        || !(supplierInvoice.linkedGRNs || []).some((id) => String(id) === String(grn._id))) {
        throw routeError(409, 'The exact supplier invoice, posted GRN, or purchase-order lineage is unavailable or no longer matches.');
      }
      current.items = await validateReturnItems(current.toObject(), supplierInvoice, grn, purchaseOrder, { excludeId: current._id, session });
      await assertWarehousesInBranch(current.items.map((item) => item.warehouse), req.branchId, { session });
      applyTotals(current);

      for (const item of current.items) {
        const quantity = Number(item.returnQty);
        await applyStockMovement({
          operationKey: stockOperationKey('purchase-return', current._id, item._id, 'post'),
          correlationKey: stockOperationKey('purchase-return', current._id),
          movementType: 'purchase_return', phase: 'posted',
          branch: current.branch, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '',
          deltas: { totalQty: -quantity, availableQty: -quantity },
          enteredQuantity: quantity, enteredUnit: item.unit || 'Unit', baseUnit: item.unit || 'Unit', conversionFactor: 1,
          sourceType: 'PurchaseReturn', sourceModel: 'PurchaseReturn', sourceId: current._id, sourceLineId: item._id,
          sourceNumber: current.debitNoteNumber, actor: req.user._id, occurredAt: new Date(),
          reason: item.reason || 'Purchase return', remarks: item.reasonDetails || req.body.remarks || '',
          metadata: { supplierInvoice: current.supplierInvoice, supplierInvoiceItem: item.supplierInvoiceItem, grn: current.grn, grnItem: item.grnItem, purchaseOrder: current.purchaseOrder, purchaseOrderItem: item.purchaseOrderItem },
          guardMessage: 'Required stock is missing or changed before this purchase return could be posted.',
        }, { session });
      }
      if (current.grandTotal > 0) {
        await postSubledgerEntry({
          session,
          branch: req.branchId,
          partyType: 'supplier',
          partyId: current.supplier,
          amount: current.grandTotal,
          side: 'debit',
          postingKey: `purchase-return:${current._id}:debit-note`,
          entryType: 'debit_note',
          entryDate: current.returnDate,
          description: `Debit note for purchase return ${current.debitNoteNumber}`,
          referenceNumber: current.debitNoteNumber,
          referenceModel: 'PurchaseReturn',
          referenceId: current._id,
          createdBy: req.user._id,
        });
      }
      current.status = 'debit_issued';
      current.approvedBy = req.user._id;
      current.approvalDate = new Date();
      current.approvalRemarks = req.body.remarks || '';
      await current.save({ session });
      purchaseReturn = current;
    });
    return res.json({ success: true, message: 'Purchase Return approved. Stock deducted and invoice-valued debit note issued.', data: purchaseReturn });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/reverse', requirePermission('debit.note'), async (req, res) => {
  const reversalReason = String(req.body.reason || '').trim();
  if (!reversalReason) return res.status(422).json({ success: false, message: 'A reversal reason is required.' });
  const session = await mongoose.startSession();
  try {
    let purchaseReturn;
    await session.withTransaction(async () => {
      const current = await PurchaseReturn.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Purchase Return not found.');
      if (current.status === 'reversed') {
        purchaseReturn = current;
        return;
      }
      if (current.status !== 'debit_issued') throw routeError(409, `Cannot reverse a purchase return in ${current.status} status.`);
      if ((current.createdBy && String(current.createdBy) === String(req.user._id))
        || (current.approvedBy && String(current.approvedBy) === String(req.user._id))) {
        throw routeError(403, 'Maker-checker violation: the Purchase Return creator or approver cannot reverse it.');
      }

      for (const item of current.items) {
        const quantity = Number(item.returnQty || 0);
        const originalOperationKey = stockOperationKey('purchase-return', current._id, item._id, 'post');
        await applyStockMovement({
          operationKey: stockOperationKey('purchase-return', current._id, item._id, 'reverse'),
          correlationKey: stockOperationKey('purchase-return', current._id),
          movementType: 'purchase_return_reversal', phase: 'reversed',
          branch: current.branch, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '',
          deltas: { totalQty: quantity, availableQty: quantity },
          enteredQuantity: quantity, enteredUnit: item.unit || 'Unit', baseUnit: item.unit || 'Unit', conversionFactor: 1,
          sourceType: 'PurchaseReturn', sourceModel: 'PurchaseReturn', sourceId: current._id, sourceLineId: item._id,
          sourceNumber: current.debitNoteNumber, actor: req.user._id, occurredAt: new Date(),
          reason: reversalReason, remarks: current.approvalRemarks || '', reversalOfOperationKey: originalOperationKey,
          metadata: { supplierInvoice: current.supplierInvoice, grn: current.grn, purchaseOrder: current.purchaseOrder },
          guardMessage: 'The original stock bucket no longer exists; reversal was not posted.',
        }, { session });
      }
      if (current.grandTotal > 0) {
        await postSubledgerEntry({
          session,
          branch: req.branchId,
          partyType: 'supplier',
          partyId: current.supplier,
          postingKey: `purchase-return:${current._id}:debit-note:reversal`,
          reversalOfPostingKey: `purchase-return:${current._id}:debit-note`,
          entryType: 'debit_note',
          entryDate: new Date(),
          description: `Reversal of purchase return ${current.debitNoteNumber}: ${reversalReason}`,
          referenceNumber: current.debitNoteNumber,
          referenceModel: 'PurchaseReturn',
          referenceId: current._id,
          createdBy: req.user._id,
        });
      }
      current.status = 'reversed';
      current.reversedBy = req.user._id;
      current.reversedAt = new Date();
      current.reversalReason = reversalReason;
      await current.save({ session });
      purchaseReturn = current;
    });
    return res.json({ success: true, message: 'Purchase Return reversed. Stock and supplier ledger effects were restored.', data: purchaseReturn });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/cancel', requirePermission('debit.note'), async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'draft' },
      { $set: { status: 'cancelled' } },
      { new: true, runValidators: true }
    );
    if (purchaseReturn) return res.json({ success: true, message: 'Purchase Return cancelled.', data: purchaseReturn });
    const current = await PurchaseReturn.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) return res.status(404).json({ success: false, message: 'Purchase Return not found.' });
    if (current.status === 'cancelled') return res.json({ success: true, message: 'Purchase Return is already cancelled.', data: current });
    return res.status(409).json({ success: false, message: `Cannot cancel a purchase return in ${current.status} status without reversal.` });
  } catch (error) {
    return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

export default router;
