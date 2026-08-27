import { Router } from 'express';
import mongoose from 'mongoose';
import PurchaseReturn from '../models/PurchaseReturn.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const lineKey = (item) => `${String(item.product)}|${String(item.warehouse)}|${item.shade || ''}|${item.batch || ''}`;
const routeError = (status, message) => Object.assign(new Error(message), { status });

async function validateReturnItems(data, grn, options = {}) {
  if (!Array.isArray(data.items) || data.items.length === 0) throw routeError(422, 'At least one return item is required.');
  const accepted = new Map();
  const sourceLines = new Map();
  for (const item of grn.items || []) {
    const key = lineKey(item);
    accepted.set(key, (accepted.get(key) || 0) + Number(item.acceptedQty || 0));
    if (!sourceLines.has(key)) sourceLines.set(key, item);
  }

  const requested = new Map();
  const normalizedItems = [];
  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index];
    const returnQty = Number(item.returnQty);
    if (!item.product || !item.warehouse || !Number.isFinite(returnQty) || returnQty <= 0) {
      throw routeError(422, `items[${index}] requires product, warehouse, and a finite returnQty greater than zero.`);
    }
    const key = lineKey(item);
    const source = sourceLines.get(key);
    if (!source) throw routeError(422, `items[${index}] is not an accepted line on the selected GRN.`);
    requested.set(key, (requested.get(key) || 0) + returnQty);
    normalizedItems.push({
      ...item,
      product: source.product,
      warehouse: source.warehouse,
      productCode: source.productCode || item.productCode || '',
      productName: source.productName || item.productName || '',
      shade: source.shade || '',
      batch: source.batch || '',
      rate: Number(source.rate || 0),
      returnQty,
    });
  }

  let query = PurchaseReturn.find({
    branch: data.branch,
    grn: grn._id,
    status: { $ne: 'cancelled' },
    ...(options.excludeId ? { _id: { $ne: options.excludeId } } : {}),
  }).select('items').lean();
  if (options.session) query = query.session(options.session);
  const previous = new Map();
  for (const existing of await query) {
    for (const item of existing.items || []) {
      const key = lineKey(item);
      previous.set(key, (previous.get(key) || 0) + Number(item.returnQty || 0));
    }
  }
  for (const [key, quantity] of requested) {
    if ((previous.get(key) || 0) + quantity > (accepted.get(key) || 0)) {
      throw routeError(422, 'Return quantity exceeds the remaining accepted quantity on the selected GRN.');
    }
  }
  return normalizedItems;
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
      filter.$or = [{ debitNoteNumber: regex }, { supplierName: regex }, { poNumber: regex }, { grnNumber: regex }];
    }
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const [returns, total] = await Promise.all([
      PurchaseReturn.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('supplier', 'companyName supplierCode').lean(),
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
    const [total, draft, approved, debitIssued, cancelled, totalValue] = await Promise.all([
      PurchaseReturn.countDocuments(scope),
      PurchaseReturn.countDocuments({ ...scope, status: 'draft' }),
      PurchaseReturn.countDocuments({ ...scope, status: 'approved' }),
      PurchaseReturn.countDocuments({ ...scope, status: 'debit_issued' }),
      PurchaseReturn.countDocuments({ ...scope, status: 'cancelled' }),
      PurchaseReturn.aggregate([
        { $match: { ...scope, status: { $nin: ['cancelled', 'draft'] } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } },
      ]),
    ]);
    return res.json({ success: true, data: { total, draft, approved, debitIssued, cancelled, totalDebitValue: totalValue[0]?.total || 0 } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/grns-for-supplier/:supplierId', requirePermission('debit.note'), async (req, res) => {
  try {
    const grns = await GRN.find({
      branch: req.branchId,
      supplier: req.params.supplierId,
      status: { $in: ['approved', 'posted'] },
    }).select('grnNumber grnDate poNumber items supplierInvoiceNo purchaseOrder').sort({ grnDate: -1 }).limit(50).lean();
    return res.json({ success: true, data: grns });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:id', requirePermission('debit.note'), async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturn.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('supplier', 'companyName supplierCode mobile')
      .populate('purchaseOrder', 'poNumber poDate')
      .populate('grn', 'grnNumber grnDate')
      .populate('items.product', 'productCode itemName tileSize')
      .populate('items.warehouse', 'name')
      .lean();
    if (!purchaseReturn) return res.status(404).json({ success: false, message: 'Purchase Return not found.' });
    return res.json({ success: true, data: purchaseReturn });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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
    if (!req.body.grn) throw routeError(422, 'An approved GRN is required.');
    const grn = await GRN.findOne({
      _id: req.body.grn,
      branch: req.branchId,
      status: { $in: ['approved', 'posted'] },
    }).lean();
    if (!grn) throw routeError(404, 'Approved GRN not found in the active branch.');
    if (String(grn.supplier) !== String(supplier._id)) throw routeError(422, 'GRN does not belong to the selected supplier.');

    let purchaseOrder = null;
    const purchaseOrderId = req.body.purchaseOrder || grn.purchaseOrder;
    if (purchaseOrderId) {
      purchaseOrder = await PurchaseOrder.findOne({ _id: purchaseOrderId, branch: req.branchId }).lean();
      if (!purchaseOrder) throw routeError(404, 'Purchase order not found in the active branch.');
      if (String(purchaseOrder.supplier) !== String(supplier._id)
        || String(grn.purchaseOrder || '') !== String(purchaseOrder._id)) {
        throw routeError(422, 'Purchase order, GRN, and supplier lineage do not match.');
      }
    }

    const data = {
      ...req.body,
      branch: req.branchId,
      supplier: supplier._id,
      supplierName: supplier.companyName,
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
      createdBy: req.user._id,
      tallySyncStatus: 'not_synced',
    };
    data.items = await validateReturnItems(data, grn);
    await assertWarehousesInBranch(data.items.map((item) => item.warehouse), req.branchId);

    let subtotal = 0;
    let totalTax = 0;
    data.items = data.items.map((item) => {
      const gstPercentage = Number(item.gstPercentage ?? 18);
      const taxableAmount = item.returnQty * item.rate;
      const gstAmount = (taxableAmount * gstPercentage) / 100;
      subtotal += taxableAmount;
      totalTax += gstAmount;
      return { ...item, gstPercentage, taxableAmount, gstAmount, totalAmount: taxableAmount + gstAmount };
    });
    data.subtotal = Math.round(subtotal * 100) / 100;
    data.totalTax = Math.round(totalTax * 100) / 100;
    data.grandTotal = Math.round((subtotal + totalTax) * 100) / 100;
    data.debitNoteNumber = await generateBranchNumber(req.branchId, 'purchaseReturn', data.returnDate || new Date());

    const purchaseReturn = await PurchaseReturn.create(data);
    return res.status(201).json({ success: true, message: 'Purchase Return (Debit Note) created.', data: purchaseReturn });
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
    const status = error.status || (error.name === 'CastError' ? 422 : 500);
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

      const grn = await GRN.findOne({
        _id: current.grn,
        branch: req.branchId,
        supplier: current.supplier,
        status: { $in: ['approved', 'posted'] },
      }).session(session).lean();
      if (!grn) throw routeError(409, 'The source GRN is unavailable or no longer matches the supplier.');
      current.items = await validateReturnItems(current.toObject(), grn, { excludeId: current._id, session });
      await assertWarehousesInBranch(current.items.map((item) => item.warehouse), req.branchId, { session });

      const requirements = new Map();
      for (const item of current.items) {
        const quantity = Number(item.returnQty);
        if (!Number.isFinite(quantity) || quantity <= 0) throw routeError(422, 'Return quantities must be finite and greater than zero.');
        const key = lineKey(item);
        const previous = requirements.get(key);
        requirements.set(key, { item, quantity: (previous?.quantity || 0) + quantity });
      }
      for (const { item, quantity } of requirements.values()) {
        const stock = await Stock.findOneAndUpdate(
          {
            branch: current.branch,
            product: item.product,
            warehouse: item.warehouse,
            shade: item.shade || '',
            batch: item.batch || '',
            totalQty: { $gte: quantity },
            availableQty: { $gte: quantity },
          },
          { $inc: { totalQty: -quantity, availableQty: -quantity } },
          { new: true, session }
        );
        if (!stock) throw routeError(409, 'Required stock is missing or changed before this purchase return could be posted.');
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
    return res.json({ success: true, message: 'Purchase Return approved. Stock deducted. Debit note issued.', data: purchaseReturn });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' ? 422 : 500);
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
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
