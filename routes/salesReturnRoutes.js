import { Router } from 'express';
import mongoose from 'mongoose';
import SalesReturn from '../models/SalesReturn.js';
import SalesOrder from '../models/SalesOrder.js';
import Stock from '../models/Stock.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const lineKey = (item) => `${String(item.product)}|${item.shade || ''}|${item.batch || ''}`;
const stockKey = (item) => `${lineKey(item)}|${String(item.warehouse)}|${item.condition}`;
const routeError = (status, message) => Object.assign(new Error(message), { status });

function sourceQuantities(order) {
  const quantities = new Map();
  const sourceLines = new Map();
  for (const item of order.items || []) {
    const key = lineKey(item);
    quantities.set(key, (quantities.get(key) || 0) + Number(item.quantity || 0));
    if (!sourceLines.has(key)) sourceLines.set(key, item);
  }
  return { quantities, sourceLines };
}

async function validateReturnItems(data, order, options = {}) {
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw routeError(422, 'At least one return item is required.');
  }
  const { quantities: orderedQuantities, sourceLines } = sourceQuantities(order);
  const requested = new Map();
  const normalizedItems = [];

  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index];
    const returnQty = Number(item.returnQty);
    if (!item.product || !Number.isFinite(returnQty) || returnQty <= 0) {
      throw routeError(422, `items[${index}] requires a product and a finite returnQty greater than zero.`);
    }
    const key = lineKey(item);
    const source = sourceLines.get(key);
    if (!source) throw routeError(422, `items[${index}] is not present on the selected sales order.`);
    requested.set(key, (requested.get(key) || 0) + returnQty);
    normalizedItems.push({
      ...item,
      product: source.product,
      productCode: source.productCode || item.productCode || '',
      productName: source.productName || item.productName || '',
      shade: source.shade || '',
      batch: source.batch || '',
      unit: source.unit || item.unit || 'Box',
      rate: Number(source.rate || 0),
      gstPercentage: Number(source.gstPercentage ?? 18),
      returnQty,
    });
  }

  const previous = new Map();
  let query = SalesReturn.find({
    branch: data.branch,
    salesOrder: order._id,
    status: { $ne: 'cancelled' },
    ...(options.excludeId ? { _id: { $ne: options.excludeId } } : {}),
  }).select('items').lean();
  if (options.session) query = query.session(options.session);
  for (const existing of await query) {
    for (const item of existing.items || []) {
      const key = lineKey(item);
      previous.set(key, (previous.get(key) || 0) + Number(item.returnQty || 0));
    }
  }

  for (const [key, quantity] of requested) {
    if ((previous.get(key) || 0) + quantity > (orderedQuantities.get(key) || 0)) {
      throw routeError(422, 'Return quantity exceeds the remaining quantity on the selected sales order.');
    }
  }
  return normalizedItems;
}

router.get('/', requirePermission('credit.note'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealer } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Number.parseInt(limit, 10) || 20);
    const filter = { branch: req.branchId };
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ returnNumber: regex }, { dealerName: regex }, { orderNumber: regex }];
    }
    if (status) filter.status = status;
    if (dealer) filter.dealer = dealer;

    const [returns, total] = await Promise.all([
      SalesReturn.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('salesOrder', 'orderNumber grandTotal')
        .lean(),
      SalesReturn.countDocuments(filter),
    ]);
    return res.json({ success: true, data: returns, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/stats', requirePermission('credit.note'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, draft, approved, creditIssued, cancelled, totalValue] = await Promise.all([
      SalesReturn.countDocuments(scope),
      SalesReturn.countDocuments({ ...scope, status: 'draft' }),
      SalesReturn.countDocuments({ ...scope, status: 'approved' }),
      SalesReturn.countDocuments({ ...scope, status: 'credit_issued' }),
      SalesReturn.countDocuments({ ...scope, status: 'cancelled' }),
      SalesReturn.aggregate([
        { $match: { ...scope, status: { $nin: ['cancelled', 'draft'] } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } },
      ]),
    ]);
    return res.json({ success: true, data: { total, draft, approved, creditIssued, cancelled, totalReturnValue: totalValue[0]?.total || 0 } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/orders-for-dealer/:dealerId', requirePermission('credit.note'), async (req, res) => {
  try {
    const orders = await SalesOrder.find({
      branch: req.branchId,
      dealer: req.params.dealerId,
      status: { $in: ['dispatched', 'delivered'] },
    }).select('orderNumber orderDate grandTotal items status').sort({ orderDate: -1 }).limit(50).lean();
    return res.json({ success: true, data: orders });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:id', requirePermission('credit.note'), async (req, res) => {
  try {
    const salesReturn = await SalesReturn.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode mobile city')
      .populate('salesOrder', 'orderNumber orderDate grandTotal items')
      .populate('items.product', 'productCode itemName tileSize')
      .populate('items.warehouse', 'name')
      .lean();
    if (!salesReturn) return res.status(404).json({ success: false, message: 'Sales Return not found.' });
    return res.json({ success: true, data: salesReturn });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', requirePermission('credit.note'), async (req, res) => {
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }
  const sourceKey = `${String(req.branchId)}:${rawIdempotencyKey}`;
  const requestFingerprint = fingerprintRequest(req.body);
  try {
    const existingReturn = await SalesReturn.findOne({ branch: req.branchId, sourceKey });
    if (existingReturn) {
      if (existingReturn.requestFingerprint && existingReturn.requestFingerprint !== requestFingerprint) {
        throw routeError(409, 'This Idempotency-Key was already used with a different request payload.');
      }
      return res.json({ success: true, message: 'Sales Return already recorded.', data: existingReturn });
    }
    const dealer = await Dealer.findById(req.body.dealer).lean();
    if (!dealer) throw routeError(404, 'Dealer not found.');
    if (!req.body.salesOrder) throw routeError(422, 'Sales order is required.');
    const order = await SalesOrder.findOne({ _id: req.body.salesOrder, branch: req.branchId }).lean();
    if (!order) throw routeError(404, 'Sales order not found in the active branch.');
    if (String(order.dealer) !== String(dealer._id)) throw routeError(422, 'Sales order does not belong to the selected dealer.');
    if (!['dispatched', 'delivered'].includes(order.status)) {
      throw routeError(422, 'Only dispatched or delivered sales orders can be returned.');
    }

    const data = {
      ...req.body,
      branch: req.branchId,
      dealer: dealer._id,
      dealerName: dealer.businessName,
      dealerCode: dealer.dealerCode,
      salesOrder: order._id,
      orderNumber: order.orderNumber,
      sourceKey,
      requestFingerprint,
      status: 'draft',
      approvedBy: undefined,
      approvalDate: undefined,
      approvalRemarks: undefined,
      createdBy: req.user._id,
      tallySyncStatus: 'not_synced',
    };
    data.items = await validateReturnItems(data, order);
    await assertWarehousesInBranch(data.items.map((item) => item.warehouse), req.branchId);

    let subtotal = 0;
    let totalTax = 0;
    data.items = data.items.map((item) => {
      const taxableAmount = item.returnQty * item.rate;
      const gstAmount = (taxableAmount * item.gstPercentage) / 100;
      subtotal += taxableAmount;
      totalTax += gstAmount;
      return { ...item, taxableAmount, gstAmount, totalAmount: taxableAmount + gstAmount };
    });
    data.subtotal = Math.round(subtotal * 100) / 100;
    data.totalTax = Math.round(totalTax * 100) / 100;
    data.grandTotal = Math.round((subtotal + totalTax) * 100) / 100;
    data.returnNumber = await generateBranchNumber(req.branchId, 'salesReturn', data.returnDate || new Date());
    data.creditNoteNumber = await generateBranchNumber(req.branchId, 'creditNote', data.returnDate || new Date());
    data.creditNoteDate = new Date();

    const salesReturn = await SalesReturn.create(data);
    return res.status(201).json({ success: true, message: 'Sales Return created.', data: salesReturn });
  } catch (error) {
    if (error.code === 11000) {
      const existingReturn = await SalesReturn.findOne({ branch: req.branchId, sourceKey });
      if (existingReturn) {
        if (existingReturn.requestFingerprint && existingReturn.requestFingerprint !== requestFingerprint) {
          return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
        }
        return res.json({ success: true, message: 'Sales Return already recorded.', data: existingReturn });
      }
    }
    const status = error.status || (error.name === 'CastError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.patch('/:id/approve', requirePermission('credit.note'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let salesReturn;
    await session.withTransaction(async () => {
      const current = await SalesReturn.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Sales Return not found.');
      if (current.status === 'credit_issued') {
        salesReturn = current;
        return;
      }
      if (current.status !== 'draft') throw routeError(409, `Cannot approve a sales return in ${current.status} status.`);

      const order = await SalesOrder.findOne({ _id: current.salesOrder, branch: req.branchId }).session(session).lean();
      if (!order || String(order.dealer) !== String(current.dealer)) {
        throw routeError(409, 'The source sales order is unavailable or no longer matches the dealer.');
      }
      current.items = await validateReturnItems(current.toObject(), order, { excludeId: current._id, session });
      await assertWarehousesInBranch(current.items.map((item) => item.warehouse), req.branchId, { session });

      const stockUpdates = new Map();
      for (const item of current.items) {
        const quantity = Number(item.returnQty);
        if (!Number.isFinite(quantity) || quantity <= 0) throw routeError(422, 'Return quantities must be finite and greater than zero.');
        if (!['resaleable', 'damaged'].includes(item.condition)) continue;
        const key = stockKey(item);
        const previous = stockUpdates.get(key);
        stockUpdates.set(key, { item, quantity: (previous?.quantity || 0) + quantity });
      }
      for (const { item, quantity } of stockUpdates.values()) {
        const increment = item.condition === 'resaleable'
          ? { totalQty: quantity, availableQty: quantity }
          : { totalQty: quantity, damagedQty: quantity };
        await Stock.findOneAndUpdate(
          { branch: current.branch, product: item.product, warehouse: item.warehouse, shade: item.shade || '', batch: item.batch || '' },
          { $inc: increment, $set: { branch: current.branch } },
          { upsert: true, new: true, session }
        );
      }
      if (current.dealer && current.adjustmentType === 'credit_note' && current.grandTotal > 0) {
        await postSubledgerEntry({
          session,
          branch: req.branchId,
          partyType: 'dealer',
          partyId: current.dealer,
          amount: current.grandTotal,
          side: 'credit',
          postingKey: `sales-return:${current._id}:credit-note`,
          entryType: 'credit_note',
          entryDate: current.returnDate,
          description: `Credit note for sales return ${current.returnNumber}`,
          referenceNumber: current.creditNoteNumber || current.returnNumber,
          referenceModel: 'SalesReturn',
          referenceId: current._id,
          createdBy: req.user._id,
        });
      }
      current.status = 'credit_issued';
      current.approvedBy = req.user._id;
      current.approvalDate = new Date();
      current.approvalRemarks = req.body.remarks || '';
      await current.save({ session });
      salesReturn = current;
    });
    return res.json({ success: true, message: 'Sales Return approved. Stock updated. Credit note issued.', data: salesReturn });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/cancel', requirePermission('credit.note'), async (req, res) => {
  try {
    const salesReturn = await SalesReturn.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'draft' },
      { $set: { status: 'cancelled' } },
      { new: true, runValidators: true }
    );
    if (salesReturn) return res.json({ success: true, message: 'Sales Return cancelled.', data: salesReturn });
    const current = await SalesReturn.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) return res.status(404).json({ success: false, message: 'Sales Return not found.' });
    if (current.status === 'cancelled') return res.json({ success: true, message: 'Sales Return is already cancelled.', data: current });
    return res.status(409).json({ success: false, message: `Cannot cancel a sales return in ${current.status} status without reversal.` });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
