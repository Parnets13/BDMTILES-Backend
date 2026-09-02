import { Router } from 'express';
import mongoose from 'mongoose';
import SalesReturn from '../models/SalesReturn.js';
import SalesOrder from '../models/SalesOrder.js';
import Invoice from '../models/Invoice.js';
import Stock from '../models/Stock.js';
import Dealer from '../models/Dealer.js';
import Complaint from '../models/Complaint.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';
import { approveSalesReturn } from '../services/salesReturnService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const ACTIVE_INVOICE_STATUSES = ['generated', 'sent'];
const POSTED_RETURN_STATUSES = ['credit_issued', 'refund_pending', 'replacement_pending'];
const legacyLineKey = (item) => `${String(item.product)}|${item.shade || ''}|${item.batch || ''}`;
const stockKey = (item) => `${String(item.product)}|${String(item.warehouse)}|${item.shade || ''}|${item.batch || ''}|${item.condition}`;
const routeError = (status, message) => Object.assign(new Error(message), { status });
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function invoiceLineValues(source, quantity) {
  const invoiceQuantity = Number(source.quantity || 0);
  if (!Number.isFinite(invoiceQuantity) || invoiceQuantity <= 0) {
    throw routeError(409, 'The source sales invoice contains an invalid quantity.');
  }
  const ratio = quantity / invoiceQuantity;
  return {
    rate: Number(source.rate || 0),
    discountAmount: roundMoney(Number(source.discountAmount || 0) * ratio),
    schemeDiscount: roundMoney(Number(source.schemeDiscount || 0) * ratio),
    taxableAmount: roundMoney(Number(source.taxableAmount || 0) * ratio),
    gstPercentage: Number(source.gstPercentage || 0),
    gstAmount: roundMoney(Number(source.gstAmount || 0) * ratio),
    totalAmount: roundMoney(Number(source.totalAmount || 0) * ratio),
  };
}

async function validateReturnItems(data, invoice, options = {}) {
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw routeError(422, 'At least one return item is required.');
  }
  const invoiceLines = new Map((invoice.items || []).map((item) => [String(item._id), item]));
  const requested = new Map();
  const normalizedItems = [];

  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index];
    const returnQty = Number(item.returnQty);
    const source = invoiceLines.get(String(item.invoiceItem || ''));
    if (!source || !Number.isFinite(returnQty) || returnQty <= 0) {
      throw routeError(422, `items[${index}] requires a valid invoiceItem and a finite returnQty greater than zero.`);
    }
    if (!item.condition || !['resaleable', 'damaged', 'scrap'].includes(item.condition)) {
      throw routeError(422, `items[${index}] requires a valid product condition.`);
    }
    if (item.condition !== 'scrap' && !item.warehouse) {
      throw routeError(422, `items[${index}] requires a receiving warehouse for stock adjustment.`);
    }
    const sourceId = String(source._id);
    requested.set(sourceId, (requested.get(sourceId) || 0) + returnQty);
    normalizedItems.push({
      invoiceItem: source._id,
      product: source.product,
      productCode: source.productCode || '',
      productName: source.productName || '',
      shade: source.shade || '',
      batch: source.batch || '',
      returnQty,
      unit: source.unit || 'Box',
      reason: item.reason,
      reasonDetails: item.reasonDetails || '',
      condition: item.condition,
      warehouse: item.condition === 'scrap' ? undefined : item.warehouse,
      ...invoiceLineValues(source, returnQty),
    });
  }

  let query = SalesReturn.find({
    branch: data.branch,
    status: { $nin: ['cancelled', 'reversed'] },
    $or: [
      { invoice: invoice._id },
      { salesOrder: invoice.salesOrder, invoice: { $exists: false } },
      { salesOrder: invoice.salesOrder, invoice: null },
    ],
    ...(options.excludeId ? { _id: { $ne: options.excludeId } } : {}),
  }).select('items').lean();
  if (options.session) query = query.session(options.session);
  const previous = new Map();
  const previousLegacy = new Map();
  for (const existing of await query) {
    for (const item of existing.items || []) {
      if (item.invoiceItem) {
        const key = String(item.invoiceItem);
        previous.set(key, (previous.get(key) || 0) + Number(item.returnQty || 0));
      } else {
        const key = legacyLineKey(item);
        previousLegacy.set(key, (previousLegacy.get(key) || 0) + Number(item.returnQty || 0));
      }
    }
  }
  for (const [sourceId, quantity] of requested) {
    const source = invoiceLines.get(sourceId);
    const priorQuantity = (previous.get(sourceId) || 0) + (previousLegacy.get(legacyLineKey(source)) || 0);
    if (priorQuantity + quantity > Number(source.quantity || 0) + 1e-9) {
      throw routeError(422, 'Return quantity exceeds the remaining quantity on the selected invoice.');
    }
  }
  return normalizedItems;
}

function applyTotals(data) {
  data.subtotal = roundMoney(data.items.reduce((sum, item) => sum + Number(item.taxableAmount || 0), 0));
  data.totalTax = roundMoney(data.items.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0));
  data.grandTotal = roundMoney(data.items.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0));
}

function postedStatus(adjustmentType) {
  if (adjustmentType === 'credit_note') return 'credit_issued';
  if (adjustmentType === 'refund') return 'refund_pending';
  return 'replacement_pending';
}

function postedMessage(adjustmentType) {
  if (adjustmentType === 'credit_note') return 'Sales Return approved. Stock updated and credit note issued.';
  if (adjustmentType === 'refund') return 'Sales Return approved and stock updated. Customer refund is pending settlement.';
  return 'Sales Return approved and stock updated. Replacement fulfilment is pending.';
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
      filter.$or = [{ returnNumber: regex }, { dealerName: regex }, { orderNumber: regex }, { invoiceNumber: regex }];
    }
    if (status) filter.status = status;
    if (dealer) filter.dealer = dealer;

    const [returns, total] = await Promise.all([
      SalesReturn.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('salesOrder', 'orderNumber grandTotal')
        .populate('invoice', 'invoiceNumber invoiceDate status')
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
    const [total, draft, approved, creditIssued, refundPending, replacementPending, cancelled, reversed, totalValue] = await Promise.all([
      SalesReturn.countDocuments(scope),
      SalesReturn.countDocuments({ ...scope, status: 'draft' }),
      SalesReturn.countDocuments({ ...scope, status: 'approved' }),
      SalesReturn.countDocuments({ ...scope, status: 'credit_issued' }),
      SalesReturn.countDocuments({ ...scope, status: 'refund_pending' }),
      SalesReturn.countDocuments({ ...scope, status: 'replacement_pending' }),
      SalesReturn.countDocuments({ ...scope, status: 'cancelled' }),
      SalesReturn.countDocuments({ ...scope, status: 'reversed' }),
      SalesReturn.aggregate([
        { $match: { ...scope, status: { $in: POSTED_RETURN_STATUSES } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } },
      ]),
    ]);
    return res.json({
      success: true,
      data: { total, draft, approved, creditIssued, refundPending, replacementPending, cancelled, reversed, totalReturnValue: totalValue[0]?.total || 0 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/orders-for-dealer/:dealerId', requirePermission('credit.note'), async (req, res) => {
  try {
    const invoices = await Invoice.find({
      branch: req.branchId,
      dealer: req.params.dealerId,
      status: { $in: ACTIVE_INVOICE_STATUSES },
      invoiceType: 'tax_invoice',
      salesOrder: { $ne: null },
    }).select('invoiceNumber invoiceDate salesOrder orderNumber grandTotal items status')
      .populate('items.product', 'productCode itemName tileSize images')
      .sort({ invoiceDate: -1 }).limit(50).lean();
    const eligibleOrders = await SalesOrder.find({
      _id: { $in: invoices.map((invoice) => invoice.salesOrder) },
      branch: req.branchId,
      dealer: req.params.dealerId,
      status: { $in: ['dispatched', 'delivered'] },
    }).select('_id').lean();
    const eligibleOrderIds = new Set(eligibleOrders.map((order) => String(order._id)));
    const eligibleInvoices = invoices.filter((invoice) => eligibleOrderIds.has(String(invoice.salesOrder)));
    const existing = await SalesReturn.find({
      branch: req.branchId,
      dealer: req.params.dealerId,
      invoice: { $in: eligibleInvoices.map((invoice) => invoice._id) },
      status: { $nin: ['cancelled', 'reversed'] },
    }).select('invoice items').lean();
    const returned = new Map();
    for (const salesReturn of existing) {
      for (const item of salesReturn.items || []) {
        if (!item.invoiceItem) continue;
        const key = `${salesReturn.invoice}:${item.invoiceItem}`;
        returned.set(key, (returned.get(key) || 0) + Number(item.returnQty || 0));
      }
    }
    const data = eligibleInvoices.map((invoice) => ({
      _id: invoice.salesOrder,
      salesOrder: invoice.salesOrder,
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      orderNumber: invoice.orderNumber,
      orderDate: invoice.invoiceDate,
      grandTotal: invoice.grandTotal,
      status: invoice.status,
      items: (invoice.items || []).map((item) => ({
        ...item,
        remainingReturnQty: Math.max(0, Number(item.quantity || 0) - (returned.get(`${invoice._id}:${item._id}`) || 0)),
      })).filter((item) => item.remainingReturnQty > 0),
    })).filter((invoice) => invoice.items.length > 0);
    return res.json({ success: true, data });
  } catch (error) {
    const status = error.name === 'CastError' ? 422 : 500;
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid dealer identifier.' : error.message });
  }
});

router.get('/:id', requirePermission('credit.note'), async (req, res) => {
  try {
    const salesReturn = await SalesReturn.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode mobile city')
      .populate('salesOrder', 'orderNumber orderDate grandTotal items')
      .populate('invoice', 'invoiceNumber invoiceDate status')
      .populate('items.product', 'productCode itemName tileSize images')
      .populate('items.warehouse', 'name')
      .lean();
    if (!salesReturn) return res.status(404).json({ success: false, message: 'Sales Return not found.' });
    return res.json({ success: true, data: salesReturn });
  } catch (error) {
    return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
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
    if (!req.body.salesOrder || !req.body.invoice) throw routeError(422, 'An active sales invoice is required.');
    const [order, invoice] = await Promise.all([
      SalesOrder.findOne({ _id: req.body.salesOrder, branch: req.branchId, dealer: dealer._id }).lean(),
      Invoice.findOne({
        _id: req.body.invoice,
        branch: req.branchId,
        dealer: dealer._id,
        status: { $in: ACTIVE_INVOICE_STATUSES },
        invoiceType: 'tax_invoice',
      }).lean(),
    ]);
    if (!order) throw routeError(404, 'Sales order not found in the active branch.');
    if (!invoice) throw routeError(404, 'Active sales invoice not found in the active branch.');
    if (String(invoice.salesOrder) !== String(order._id)) throw routeError(422, 'Invoice, sales order, and dealer lineage do not match.');
    if (!['dispatched', 'delivered'].includes(order.status)) {
      throw routeError(422, 'Only invoiced, dispatched or delivered sales can be returned.');
    }
    if (!['credit_note', 'refund', 'replacement'].includes(req.body.adjustmentType || 'credit_note')) {
      throw routeError(422, 'Invalid sales return adjustment type.');
    }

    const data = {
      ...req.body,
      branch: req.branchId,
      dealer: dealer._id,
      dealerName: dealer.businessName,
      dealerCode: dealer.dealerCode,
      salesOrder: order._id,
      orderNumber: order.orderNumber,
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
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
    data.items = await validateReturnItems(data, invoice);
    await assertWarehousesInBranch(data.items.map((item) => item.warehouse).filter(Boolean), req.branchId);
    applyTotals(data);
    data.returnNumber = await generateBranchNumber(req.branchId, 'salesReturn', data.returnDate || new Date());
    if (data.adjustmentType === 'credit_note') {
      data.creditNoteNumber = await generateBranchNumber(req.branchId, 'creditNote', data.returnDate || new Date());
      data.creditNoteDate = new Date();
    } else {
      data.creditNoteNumber = undefined;
      data.creditNoteDate = undefined;
    }

    const salesReturn = await SalesReturn.create(data);
    return res.status(201).json({ success: true, message: 'Invoice-linked Sales Return created.', data: salesReturn });
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
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
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
      salesReturn = await approveSalesReturn({
        current,
        branchId: req.branchId,
        approver: req.user._id,
        remarks: req.body.remarks,
        session,
      });
    });
    return res.json({ success: true, message: postedMessage(salesReturn.adjustmentType), data: salesReturn });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/reverse', requirePermission('credit.note'), async (req, res) => {
  const reversalReason = String(req.body.reason || '').trim();
  if (!reversalReason) return res.status(422).json({ success: false, message: 'A reversal reason is required.' });
  const session = await mongoose.startSession();
  try {
    let salesReturn;
    await session.withTransaction(async () => {
      const current = await SalesReturn.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Sales Return not found.');
      if (current.status === 'reversed') {
        salesReturn = current;
        return;
      }
      if (!POSTED_RETURN_STATUSES.includes(current.status)) {
        throw routeError(409, `Cannot reverse a sales return in ${current.status} status.`);
      }
      if ((current.createdBy && String(current.createdBy) === String(req.user._id))
        || (current.approvedBy && String(current.approvedBy) === String(req.user._id))) {
        throw routeError(403, 'Maker-checker violation: the Sales Return creator or approver cannot reverse it.');
      }

      const stockUpdates = new Map();
      for (const item of current.items) {
        if (!['resaleable', 'damaged'].includes(item.condition)) continue;
        const key = stockKey(item);
        const previous = stockUpdates.get(key);
        stockUpdates.set(key, { item, quantity: (previous?.quantity || 0) + Number(item.returnQty || 0) });
      }
      for (const { item, quantity } of stockUpdates.values()) {
        const quantityGuard = item.condition === 'resaleable'
          ? { totalQty: { $gte: quantity }, availableQty: { $gte: quantity } }
          : { totalQty: { $gte: quantity }, damagedQty: { $gte: quantity } };
        const decrement = item.condition === 'resaleable'
          ? { totalQty: -quantity, availableQty: -quantity }
          : { totalQty: -quantity, damagedQty: -quantity };
        const stock = await Stock.findOneAndUpdate(
          {
            branch: current.branch,
            product: item.product,
            warehouse: item.warehouse,
            shade: item.shade || '',
            batch: item.batch || '',
            ...quantityGuard,
          },
          { $inc: decrement },
          { new: true, session, runValidators: true }
        );
        if (!stock) throw routeError(409, 'Returned stock has changed and cannot be safely removed for reversal.');
      }
      if (current.adjustmentType === 'credit_note' && current.grandTotal > 0) {
        await postSubledgerEntry({
          session,
          branch: req.branchId,
          partyType: 'dealer',
          partyId: current.dealer,
          postingKey: `sales-return:${current._id}:credit-note:reversal`,
          reversalOfPostingKey: `sales-return:${current._id}:credit-note`,
          entryType: 'credit_note',
          entryDate: new Date(),
          description: `Reversal of sales return ${current.returnNumber}: ${reversalReason}`,
          referenceNumber: current.creditNoteNumber || current.returnNumber,
          referenceModel: 'SalesReturn',
          referenceId: current._id,
          createdBy: req.user._id,
        });
      }
      current.status = 'reversed';
      current.reversedBy = req.user._id;
      current.reversedAt = new Date();
      current.reversalReason = reversalReason;
      await current.save({ session });
      if (current.complaint) {
        await Complaint.findOneAndUpdate(
          { _id: current.complaint, branch: current.branch, salesReturn: current._id },
          {
            $set: {
              status: 'return_reversed',
              creditNoteIssued: false,
              creditNoteAmount: 0,
            },
            $unset: { creditNoteNumber: 1, resolvedAt: 1 },
            $push: {
              resolutionHistory: {
                action: `Sales Return ${current.returnNumber} reversed`,
                resolvedBy: req.user._id,
                resolvedByName: req.user.name,
                notes: reversalReason,
              },
            },
          },
          { session, runValidators: true }
        );
      }
      salesReturn = current;
    });
    return res.json({ success: true, message: 'Sales Return reversed. Returned stock and any credit-note ledger effect were removed.', data: salesReturn });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
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
    return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

export default router;
