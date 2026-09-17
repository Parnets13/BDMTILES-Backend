import { Router } from 'express';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Cheque from '../models/Cheque.js';
import SalesOrder from '../models/SalesOrder.js';
import SupplierInvoice from '../models/SupplierInvoice.js';
import Invoice from '../models/Invoice.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';
import { applyDealerInvoiceAllocation, reverseDealerInvoiceAllocation } from '../services/dealerInvoicePaymentService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

function paymentError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function finitePositive(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw paymentError(422, `${field} must be a finite number greater than zero.`);
  }
  return number;
}

async function assertPaymentNotChequeManaged(payment, session) {
  const linkedCheque = payment.cheque || await Cheque.exists({
    payment: payment._id,
    $or: [
      { branch: payment.branch },
      { branch: null },
      { branch: { $exists: false } },
    ],
  }).session(session);
  if (linkedCheque) {
    throw paymentError(
      409,
      'This Payment is managed by a linked cheque. Use Cheque Management so lifecycle, maker-checker, and accounting remain atomic.'
    );
  }
}

async function refreshSalesOrderPaymentStatus(orderId, session = null) {
  const options = session ? { session } : {};
  let result = await SalesOrder.updateOne(
    { _id: orderId, balanceAmount: { $lte: 0 } },
    { $set: { paymentStatus: 'paid', balanceAmount: 0 } },
    options
  );
  if (result.matchedCount) return;

  result = await SalesOrder.updateOne(
    { _id: orderId, balanceAmount: { $gt: 0 }, advanceAmount: { $gt: 0 } },
    { $set: { paymentStatus: 'partial' } },
    options
  );
  if (result.matchedCount) return;

  await SalesOrder.updateOne(
    { _id: orderId, balanceAmount: { $gt: 0 }, advanceAmount: { $lte: 0 } },
    { $set: { paymentStatus: 'pending', advanceAmount: 0 } },
    options
  );
}

async function validatePaymentData(source, session = null, { allowLegacySalesOrder = false } = {}) {
  const paymentType = source.paymentType;
  if (!['dealer_receipt', 'supplier_payment'].includes(paymentType)) {
    throw paymentError(422, 'paymentType must be dealer_receipt or supplier_payment.');
  }

  let party;
  if (paymentType === 'dealer_receipt') {
    if (!source.dealer || source.supplier) throw paymentError(422, 'Dealer receipts require dealer only.');
    party = await Dealer.findById(source.dealer).session(session).lean();
    if (!party) throw paymentError(404, 'Dealer not found.');
  } else {
    if (!source.supplier || source.dealer) throw paymentError(422, 'Supplier payments require supplier only.');
    party = await Supplier.findOne({ _id: source.supplier, status: 'active' }).session(session).lean();
    if (!party) throw paymentError(404, 'Active supplier not found.');
  }

  const amount = finitePositive(source.amount, 'amount');
  const allocations = Array.isArray(source.againstOrders) ? source.againstOrders : [];
  const seen = new Set();
  let allocatedTotal = 0;
  const againstOrders = [];

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const orderModel = allocation.orderModel;
    if (!allocation.order || !orderModel) {
      throw paymentError(422, `againstOrders[${index}] requires order and orderModel.`);
    }
    if (paymentType === 'dealer_receipt'
      && orderModel !== 'Invoice'
      && !(allowLegacySalesOrder && orderModel === 'SalesOrder')) {
      throw paymentError(422, 'New dealer receipt allocations may only reference customer invoices.');
    }
    if (paymentType === 'supplier_payment' && orderModel !== 'SupplierInvoice') {
      throw paymentError(422, 'Supplier payment allocations may only reference verified SupplierInvoice records.');
    }

    const key = `${orderModel}:${String(allocation.order)}`;
    if (seen.has(key)) throw paymentError(422, 'Each allocation target may appear only once.');
    seen.add(key);

    const allocatedAmount = finitePositive(allocation.allocatedAmount, `againstOrders[${index}].allocatedAmount`);
    allocatedTotal = Math.round((allocatedTotal + allocatedAmount + Number.EPSILON) * 100) / 100;
    if (allocatedTotal > amount + 0.01) throw paymentError(422, 'Allocated total cannot exceed payment amount.');

    if (orderModel === 'SalesOrder') {
      const order = await SalesOrder.findOne({ _id: allocation.order, branch: source.branch }).session(session).lean();
      if (!order) throw paymentError(404, `Sales order for allocation ${index + 1} not found.`);
      if (String(order.dealer) !== String(source.dealer)) {
        throw paymentError(422, `Sales order ${order.orderNumber} does not belong to the selected dealer.`);
      }
      if (['draft', 'cancelled'].includes(order.status)) {
        throw paymentError(422, `Sales order ${order.orderNumber} cannot receive allocations in ${order.status} status.`);
      }
      const currentBalance = Number(order.balanceAmount);
      if (!Number.isFinite(currentBalance) || allocatedAmount > currentBalance + 0.01) {
        throw paymentError(422, `Allocation for sales order ${order.orderNumber} exceeds its current balance.`);
      }
      againstOrders.push({ order: order._id, orderModel, orderNumber: order.orderNumber, allocatedAmount });
    } else if (orderModel === 'Invoice') {
      const invoice = await Invoice.findOne({
        _id: allocation.order,
        branch: source.branch,
        dealer: source.dealer,
        status: { $ne: 'cancelled' },
      }).session(session).lean();
      if (!invoice) throw paymentError(404, `Active customer invoice for allocation ${index + 1} not found.`);
      const currentBalance = Number(invoice.balanceAmount);
      if (!Number.isFinite(currentBalance) || allocatedAmount > currentBalance + 0.01) {
        throw paymentError(422, `Allocation for invoice ${invoice.invoiceNumber} exceeds its current balance.`);
      }
      againstOrders.push({
        order: invoice._id,
        orderModel,
        orderNumber: invoice.invoiceNumber,
        allocatedAmount,
      });
    } else {
      const invoice = await SupplierInvoice.findOne({
        _id: allocation.order,
        branch: source.branch,
        supplier: source.supplier,
        status: { $in: ['verified', 'partial'] },
      }).session(session).lean();
      if (!invoice) throw paymentError(404, `Verified supplier invoice for allocation ${index + 1} not found.`);
      const currentBalance = Number(invoice.balanceAmount);
      if (!Number.isFinite(currentBalance) || allocatedAmount > currentBalance + 0.01) {
        throw paymentError(422, `Allocation for supplier invoice ${invoice.invoiceRefNumber} exceeds its current balance.`);
      }
      againstOrders.push({
        order: invoice._id,
        orderModel,
        orderNumber: invoice.invoiceRefNumber,
        allocatedAmount,
      });
    }
  }

  const hasLegacySalesOrder = againstOrders.some(allocation => allocation.orderModel === 'SalesOrder');
  // Field collections captured by the Sales Executive app are recorded unallocated
  // and confirmed by finance as an on-account credit, so the full-allocation rule
  // does not apply to them. All other dealer receipts must be fully allocated.
  const isUnallocatedFieldCollection = source.isFieldCollection === true && allocatedTotal === 0;
  if (paymentType === 'dealer_receipt' && !hasLegacySalesOrder && !isUnallocatedFieldCollection
    && Math.abs(amount - allocatedTotal) > 0.01) {
    throw paymentError(422, 'Dealer receipt amount must be fully allocated to customer invoices.');
  }

  let unallocatedAdvanceAmount = 0;
  if (paymentType === 'supplier_payment') {
    const expectedAdvance = Math.round((amount - allocatedTotal + Number.EPSILON) * 100) / 100;
    const requestedAdvance = Number(source.unallocatedAdvanceAmount ?? 0);
    if (!Number.isFinite(requestedAdvance) || requestedAdvance < 0) {
      throw paymentError(422, 'unallocatedAdvanceAmount must be a finite nonnegative number.');
    }
    if (Math.abs(requestedAdvance - expectedAdvance) > 0.01) {
      throw paymentError(422, 'Supplier payment remainder must be explicitly classified as unallocatedAdvanceAmount.');
    }
    unallocatedAdvanceAmount = expectedAdvance;
  }

  return {
    amount,
    againstOrders,
    unallocatedAdvanceAmount,
    partyName: paymentType === 'dealer_receipt' ? party.businessName : party.companyName,
  };
}

async function applyPaymentEffects(payment, session) {
  const isDealerReceipt = payment.paymentType === 'dealer_receipt';
  await postSubledgerEntry({
    session,
    branch: payment.branch,
    partyType: isDealerReceipt ? 'dealer' : 'supplier',
    partyId: isDealerReceipt ? payment.dealer : payment.supplier,
    amount: payment.amount,
    side: isDealerReceipt ? 'credit' : 'debit',
    postingKey: `payment:${payment._id}:confirmed`,
    entryType: 'payment',
    entryDate: payment.paymentDate,
    description: isDealerReceipt
      ? `Dealer receipt ${payment.paymentNumber}`
      : `Supplier payment ${payment.paymentNumber}`,
    referenceNumber: payment.paymentNumber,
    referenceModel: 'Payment',
    referenceId: payment._id,
    createdBy: payment.createdBy,
  });

  for (const allocation of payment.againstOrders ?? []) {
    if (allocation.orderModel === 'SalesOrder') {
      const activeInvoice = await Invoice.findOne({
        branch: payment.branch,
        dealer: payment.dealer,
        salesOrder: allocation.order,
        status: { $ne: 'cancelled' },
      }).select('_id').session(session).lean();
      if (activeInvoice) {
        await applyDealerInvoiceAllocation({
          invoiceId: activeInvoice._id,
          branch: payment.branch,
          dealer: payment.dealer,
          amount: allocation.allocatedAmount,
          session,
        });
        continue;
      }

      const order = await SalesOrder.findOneAndUpdate(
        {
          _id: allocation.order,
          branch: payment.branch,
          dealer: payment.dealer,
          status: { $nin: ['draft', 'cancelled'] },
          balanceAmount: { $gte: allocation.allocatedAmount },
        },
        { $inc: { advanceAmount: allocation.allocatedAmount, balanceAmount: -allocation.allocatedAmount } },
        { new: true, session }
      );
      if (!order) throw paymentError(409, 'A sales order balance changed before the payment could be applied.');
      await refreshSalesOrderPaymentStatus(order._id, session);
      continue;
    }

    if (allocation.orderModel === 'Invoice') {
      await applyDealerInvoiceAllocation({
        invoiceId: allocation.order,
        branch: payment.branch,
        dealer: payment.dealer,
        amount: allocation.allocatedAmount,
        session,
      });
      continue;
    }

    if (allocation.orderModel === 'SupplierInvoice') {
      const invoice = await SupplierInvoice.findOneAndUpdate(
        {
          _id: allocation.order,
          branch: payment.branch,
          supplier: payment.supplier,
          status: { $in: ['verified', 'partial'] },
          balanceAmount: { $gte: allocation.allocatedAmount },
        },
        { $inc: { paidAmount: allocation.allocatedAmount, balanceAmount: -allocation.allocatedAmount } },
        { new: true, session }
      );
      if (!invoice) throw paymentError(409, 'A supplier invoice balance changed before the payment could be applied.');
      if (Number(invoice.balanceAmount) <= 0.01) {
        invoice.balanceAmount = 0;
        invoice.status = 'paid';
      } else {
        invoice.status = 'partial';
      }
      await invoice.save({ session });
    }
  }
}

async function reversePaymentEffects(payment, bounceCharges, session) {
  const isDealerReceipt = payment.paymentType === 'dealer_receipt';
  await postSubledgerEntry({
    session,
    branch: payment.branch,
    partyType: isDealerReceipt ? 'dealer' : 'supplier',
    partyId: isDealerReceipt ? payment.dealer : payment.supplier,
    postingKey: `payment:${payment._id}:bounce:principal`,
    reversalOfPostingKey: `payment:${payment._id}:confirmed`,
    entryType: 'payment',
    entryDate: new Date(),
    description: `Reversal of bounced payment ${payment.paymentNumber}`,
    referenceNumber: payment.paymentNumber,
    referenceModel: 'Payment',
    referenceId: payment._id,
    createdBy: payment.createdBy,
  });

  if (isDealerReceipt && bounceCharges > 0) {
    await postSubledgerEntry({
      session,
      branch: payment.branch,
      partyType: 'dealer',
      partyId: payment.dealer,
      amount: bounceCharges,
      side: 'debit',
      postingKey: `payment:${payment._id}:bounce:charge`,
      entryType: 'debit_note',
      entryDate: new Date(),
      description: `Bounce charge for payment ${payment.paymentNumber}`,
      referenceNumber: payment.paymentNumber,
      referenceModel: 'Payment',
      referenceId: payment._id,
      createdBy: payment.createdBy,
    });
  }

  for (const allocation of payment.againstOrders ?? []) {
    if (allocation.orderModel === 'SalesOrder') {
      const activeInvoice = await Invoice.findOne({
        branch: payment.branch,
        dealer: payment.dealer,
        salesOrder: allocation.order,
        status: { $ne: 'cancelled' },
      }).select('_id').session(session).lean();
      if (activeInvoice) {
        await reverseDealerInvoiceAllocation({
          invoiceId: activeInvoice._id,
          branch: payment.branch,
          dealer: payment.dealer,
          amount: allocation.allocatedAmount,
          session,
        });
        continue;
      }

      const order = await SalesOrder.findOne({ _id: allocation.order, branch: payment.branch }).session(session);
      if (!order) throw paymentError(409, 'An allocated sales order no longer exists.');
      order.advanceAmount = Math.max(0, (Number(order.advanceAmount) || 0) - allocation.allocatedAmount);
      order.balanceAmount = Math.max(0, (Number(order.grandTotal) || 0) - order.advanceAmount);
      await order.save({ session });
      await refreshSalesOrderPaymentStatus(order._id, session);
      continue;
    }

    if (allocation.orderModel === 'Invoice') {
      await reverseDealerInvoiceAllocation({
        invoiceId: allocation.order,
        branch: payment.branch,
        dealer: payment.dealer,
        amount: allocation.allocatedAmount,
        session,
      });
      continue;
    }

    if (allocation.orderModel === 'SupplierInvoice') {
      const invoice = await SupplierInvoice.findOne({
        _id: allocation.order,
        branch: payment.branch,
        supplier: payment.supplier,
        status: { $in: ['verified', 'partial', 'paid'] },
      }).session(session);
      if (!invoice) throw paymentError(409, 'An allocated supplier invoice no longer exists.');
      if (Number(invoice.paidAmount) + 0.01 < Number(allocation.allocatedAmount)) {
        throw paymentError(409, 'Supplier invoice paid amount is lower than the payment allocation being reversed.');
      }
      invoice.paidAmount = Math.max(0, Number(invoice.paidAmount) - Number(allocation.allocatedAmount));
      invoice.balanceAmount = Math.min(Number(invoice.grandTotal), Number(invoice.balanceAmount) + Number(allocation.allocatedAmount));
      invoice.status = invoice.paidAmount <= 0.01 ? 'verified' : 'partial';
      await invoice.save({ session });
    }
  }
}

function sendPaymentError(res, error) {
  const status = error.status || (error.name === 'CastError' ? 422 : 500);
  res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
}

// GET /api/v1/payments — list
router.get('/', requirePermission('payment'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, paymentType, status, paymentMode, dealer, supplier } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = { branch: req.branchId };
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ paymentNumber: r }, { partyName: r }, { chequeNumber: r }, { transactionRef: r }];
    }
    if (paymentType) filter.paymentType = paymentType;
    if (status) filter.status = status;
    if (paymentMode) filter.paymentMode = paymentMode;
    if (dealer) filter.dealer = dealer;
    if (supplier) filter.supplier = supplier;

    const [payments, total] = await Promise.all([
      Payment.find(filter).sort({ paymentDate: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('supplier', 'companyName supplierCode')
        .lean(),
      Payment.countDocuments(filter),
    ]);
    res.json({ success: true, data: payments, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { sendPaymentError(res, e); }
});

// GET /api/v1/payments/stats
router.get('/stats', requirePermission('payment'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [totalReceipts, totalPayments, todayReceipts, monthReceipts, pendingCheques] = await Promise.all([
      Payment.aggregate([{ $match: { branch: req.branchId, paymentType: 'dealer_receipt', status: 'confirmed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.aggregate([{ $match: { branch: req.branchId, paymentType: 'supplier_payment', status: 'confirmed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.aggregate([{ $match: { branch: req.branchId, paymentType: 'dealer_receipt', status: 'confirmed', paymentDate: { $gte: today } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { branch: req.branchId, paymentType: 'dealer_receipt', status: 'confirmed', paymentDate: { $gte: thisMonth } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.countDocuments({ branch: req.branchId, paymentMode: 'cheque', status: 'pending' }),
    ]);
    res.json({
      success: true,
      data: {
        totalReceipts: totalReceipts[0]?.total || 0,
        totalPayments: totalPayments[0]?.total || 0,
        todayReceipts: todayReceipts[0]?.total || 0,
        todayCount: todayReceipts[0]?.count || 0,
        monthReceipts: monthReceipts[0]?.total || 0,
        pendingCheques,
      },
    });
  } catch (e) { sendPaymentError(res, e); }
});

// GET /api/v1/payments/dealer-invoices/:dealerId — active customer invoices for allocation
router.get('/dealer-invoices/:dealerId', requirePermission('payment'), async (req, res) => {
  try {
    const invoices = await Invoice.find({
      branch: req.branchId,
      dealer: req.params.dealerId,
      status: { $ne: 'cancelled' },
      paymentStatus: { $in: ['pending', 'partial'] },
      balanceAmount: { $gt: 0 },
    }).select('invoiceNumber invoiceDate orderNumber dispatchNumbers grandTotal paidAmount balanceAmount paymentStatus')
      .sort({ invoiceDate: 1, createdAt: 1 }).lean();
    res.json({ success: true, data: invoices });
  } catch (e) { sendPaymentError(res, e); }
});

// GET /api/v1/payments/supplier-invoices/:supplierId — verified invoices for allocation
router.get('/supplier-invoices/:supplierId', requirePermission('payment'), async (req, res) => {
  try {
    const invoices = await SupplierInvoice.find({
      branch: req.branchId,
      supplier: req.params.supplierId,
      status: { $in: ['verified', 'partial'] },
      balanceAmount: { $gt: 0 },
    }).select('invoiceRefNumber invoiceNumber invoiceDate dueDate grandTotal paidAmount balanceAmount status')
      .sort({ dueDate: 1, invoiceDate: 1 }).lean();
    return res.json({ success: true, data: invoices });
  } catch (error) { return sendPaymentError(res, error); }
});

// GET /api/v1/payments/:id
router.get('/:id', requirePermission('payment'), async (req, res) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode mobile city currentOutstanding')
      .populate('supplier', 'companyName supplierCode mobile')
      .lean();
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    res.json({ success: true, data: payment });
  } catch (e) { sendPaymentError(res, e); }
});

// POST /api/v1/payments — record payment
router.post('/', requirePermission('payment'), async (req, res) => {
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }
  const sourceKey = `${String(req.branchId)}:payment:${rawIdempotencyKey}`;
  const requestFingerprint = fingerprintRequest(req.body);
  const existingPayment = await Payment.findOne({ branch: req.branchId, sourceKey });
  if (existingPayment) {
    if (existingPayment.requestFingerprint && existingPayment.requestFingerprint !== requestFingerprint) {
      return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
    }
    return res.json({ success: true, message: 'Payment already recorded.', data: existingPayment });
  }
  const session = await mongoose.startSession();
  try {
    let payment;
    await session.withTransaction(async () => {
      const validated = await validatePaymentData({ ...req.body, branch: req.branchId }, session);
      const paymentNumber = await generateBranchNumber(req.branchId, 'payment', req.body.paymentDate || new Date(), { session });
      const data = {
        ...req.body,
        ...validated,
        paymentNumber,
        sourceKey,
        requestFingerprint,
        branch: req.branchId,
        transactionRef: req.body.transactionRef ?? req.body.utrNumber,
        status: req.body.paymentMode === 'cheque' ? 'pending' : 'confirmed',
        confirmedAt: req.body.paymentMode === 'cheque' ? null : new Date(),
        tallySyncStatus: 'not_synced',
        createdBy: req.user._id,
      };
      delete data.utrNumber;
      payment = new Payment(data);
      await payment.save({ session });
      if (payment.status === 'confirmed') await applyPaymentEffects(payment, session);
    });

    return res.status(201).json({ success: true, message: 'Payment recorded.', data: payment });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await Payment.findOne({ branch: req.branchId, sourceKey });
      if (duplicate) {
        if (duplicate.requestFingerprint && duplicate.requestFingerprint !== requestFingerprint) {
          return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
        }
        return res.json({ success: true, message: 'Payment already recorded.', data: duplicate });
      }
    }
    return sendPaymentError(res, error);
  } finally {
    await session.endSession();
  }
});

// PATCH /api/v1/payments/:id/confirm — confirm cheque
router.patch('/:id/confirm', requirePermission('payment'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let payment;
    let alreadyConfirmed = false;
    await session.withTransaction(async () => {
      const current = await Payment.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw paymentError(404, 'Payment not found.');
      if (current.status === 'confirmed') {
        payment = current;
        alreadyConfirmed = true;
        return;
      }
      if (current.status !== 'pending') throw paymentError(409, `Cannot confirm a payment in ${current.status} status.`);
      await assertPaymentNotChequeManaged(current, session);

      await validatePaymentData(current.toObject(), session, { allowLegacySalesOrder: true });
      payment = await Payment.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'pending' },
        { $set: { status: 'confirmed', confirmedAt: new Date(), bouncedAt: null, cancelledAt: null } },
        { new: true, runValidators: true, session }
      );
      if (!payment) throw paymentError(409, 'Payment state changed before confirmation.');
      await applyPaymentEffects(payment, session);
    });
    return res.json({ success: true, message: alreadyConfirmed ? 'Payment is already confirmed.' : 'Payment confirmed.', data: payment });
  } catch (error) {
    return sendPaymentError(res, error);
  } finally {
    await session.endSession();
  }
});

// PATCH /api/v1/payments/:id/bounce — mark cheque bounced
router.patch('/:id/bounce', requirePermission('payment'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const bounceCharges = Number(req.body.charges ?? 0);
    if (!Number.isFinite(bounceCharges) || bounceCharges < 0) {
      throw paymentError(422, 'Bounce charges must be a finite nonnegative number.');
    }

    let payment;
    let alreadyBounced = false;
    await session.withTransaction(async () => {
      const current = await Payment.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw paymentError(404, 'Payment not found.');
      if (current.paymentMode !== 'cheque') throw paymentError(422, 'Only cheque payments can use the bounce action.');
      if (current.status === 'bounced') {
        payment = current;
        alreadyBounced = true;
        return;
      }
      if (current.status === 'cancelled') throw paymentError(409, 'Cancelled payments cannot be bounced.');
      if (!['pending', 'confirmed'].includes(current.status)) {
        throw paymentError(409, `Cannot bounce a payment in ${current.status} status.`);
      }
      await assertPaymentNotChequeManaged(current, session);

      const previousStatus = current.status;
      payment = await Payment.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: previousStatus },
        { $set: { status: 'bounced', bouncedAt: new Date(), bounceReason: req.body.reason || '', bounceCharges } },
        { new: true, runValidators: true, session }
      );
      if (!payment) throw paymentError(409, 'Payment state changed before bounce processing.');
      if (previousStatus === 'confirmed') await reversePaymentEffects(payment, bounceCharges, session);
    });
    return res.json({ success: true, message: alreadyBounced ? 'Payment is already bounced.' : 'Payment marked as bounced.', data: payment });
  } catch (error) {
    return sendPaymentError(res, error);
  } finally {
    await session.endSession();
  }
});

export { validatePaymentData, applyPaymentEffects, reversePaymentEffects };
export default router;
