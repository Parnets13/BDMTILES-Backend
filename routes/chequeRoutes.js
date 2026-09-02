import { Router } from 'express';
import mongoose from 'mongoose';
import Cheque from '../models/Cheque.js';
import Payment from '../models/Payment.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { validatePaymentData, applyPaymentEffects, reversePaymentEffects } from './paymentRoutes.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const CREATE_FIELDS = [
  'chequeNumber', 'chequeDate', 'amount', 'bankName', 'branchName', 'ifscCode',
  'accountNumber', 'accountHolderName', 'micr', 'chequeType', 'dealer', 'supplier',
  'payment', 'againstOrder', 'againstOrderNumber', 'againstInvoice', 'againstInvoiceNumber',
  'chequeFrontImage', 'chequeBackImage', 'isSecurityCheque', 'securityFor', 'isPDC',
  'pdcDueDate', 'remarks', 'tags',
];

function routeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendError(res, error) {
  let status = error.status || 500;
  if (error.name === 'CastError' || error.name === 'ValidationError') status = 422;
  if (error.code === 11000) status = 409;
  return res.status(status).json({
    success: false,
    message: error.name === 'CastError' ? 'Invalid identifier.' : error.message,
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw routeError(422, `${field} is required.`);
  return text;
}

function optionalText(value) {
  return value == null ? '' : String(value).trim();
}

function positiveAmount(value, field = 'amount') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw routeError(422, `${field} must be a finite number greater than zero.`);
  }
  return amount;
}

function nonnegativeAmount(value, field) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) {
    throw routeError(422, `${field} must be a finite nonnegative number.`);
  }
  return amount;
}

function requiredDate(value, field) {
  if (!value) throw routeError(422, `${field} is required.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw routeError(422, `${field} must be a valid date.`);
  return date;
}

function sameId(left, right) {
  return Boolean(left && right && String(left._id || left) === String(right._id || right));
}

function sameChequeNumber(left, right) {
  return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase();
}

function actorName(req) {
  return req.user.name || req.user.email || 'User';
}

function timelineEntry(req, action, previousStatus, newStatus, notes, payment = null, date = new Date()) {
  return {
    date,
    action,
    previousStatus,
    newStatus,
    performedBy: req.user._id,
    performedByName: actorName(req),
    notes,
    ...(payment ? {
      referenceModel: 'Payment',
      referenceId: payment._id,
      referenceNumber: payment.paymentNumber,
    } : {}),
  };
}

function assertMakerChecker(cheque, req, action) {
  if (cheque.createdBy && sameId(cheque.createdBy, req.user._id)) {
    throw routeError(
      403,
      `Maker-checker control: the cheque creator cannot ${action} this cheque. A different authorized user must perform this action.`
    );
  }
}

function assertPaymentMakerChecker(payment, req, action) {
  if (payment?.createdBy && sameId(payment.createdBy, req.user._id)) {
    throw routeError(
      403,
      `Maker-checker control: the linked Payment creator cannot ${action} this cheque. A different authorized user must perform this action.`
    );
  }
}

function sourceStatuses(cheque, action) {
  if (cheque.chequeType === 'received') {
    if (action === 'deposit') return ['received'];
    if (action === 'clear' || action === 'bounce') return ['deposited', 're_deposited'];
    if (action === 'return') return ['received', 'bounced'];
    if (action === 'reDeposit') return ['bounced'];
    return [];
  }

  // Legacy issued cheques were stored with status "received". They remain actionable,
  // but never enter the received-cheque deposit/return/re-deposit semantics.
  if (action === 'clear' || action === 'bounce') return ['issued', 'received'];
  return [];
}

function allowedActionsFor(cheque, userId) {
  const actions = [];
  const paymentStatus = cheque.payment?.status;
  const isMaker = (cheque.createdBy && sameId(cheque.createdBy, userId))
    || (cheque.payment?.createdBy && sameId(cheque.payment.createdBy, userId));

  if (sourceStatuses(cheque, 'deposit').includes(cheque.status)
      && (!cheque.payment || paymentStatus === 'pending')) actions.push('deposit');
  if (!isMaker && sourceStatuses(cheque, 'clear').includes(cheque.status)
      && (!cheque.payment || ['pending', 'confirmed'].includes(paymentStatus))) actions.push('clear');
  if (!isMaker && sourceStatuses(cheque, 'bounce').includes(cheque.status)
      && (!cheque.payment || ['pending', 'confirmed', 'bounced'].includes(paymentStatus))) actions.push('bounce');
  if (!isMaker && sourceStatuses(cheque, 'return').includes(cheque.status)
      && (!cheque.payment || ['pending', 'bounced'].includes(paymentStatus))) actions.push('return');
  if (sourceStatuses(cheque, 'reDeposit').includes(cheque.status)
      && (!cheque.payment || paymentStatus === 'bounced')) actions.push('reDeposit');

  return actions;
}

function accountingSummary(cheque) {
  if (!cheque.payment) {
    return 'Standalone cheque: lifecycle actions do not post or reverse ledger/accounting entries.';
  }
  if (cheque.status === 're_deposited') {
    return 'This presentation uses the displayed replacement Payment. The previously bounced Payment remains bounced and is never revived.';
  }
  return `Accounting is authoritative through linked Payment ${cheque.payment.paymentNumber || ''} (${cheque.payment.status || 'unavailable'}).`;
}

function decorateCheque(cheque, userId) {
  return {
    ...cheque,
    allowedActions: allowedActionsFor(cheque, userId),
    accountingSummary: accountingSummary(cheque),
  };
}

async function validateParty(data, session = null) {
  if (!['received', 'issued'].includes(data.chequeType)) {
    throw routeError(422, 'chequeType must be received or issued.');
  }

  if (data.chequeType === 'received') {
    if (!data.dealer || data.supplier) throw routeError(422, 'Received cheques require exactly one dealer and no supplier.');
    const dealer = await Dealer.findOne({ _id: data.dealer, status: 'active' }).session(session).lean();
    if (!dealer) throw routeError(404, 'Active dealer not found.');
    return { party: dealer, partyName: dealer.businessName, partyPhone: dealer.mobile || '' };
  }

  if (!data.supplier || data.dealer) throw routeError(422, 'Issued cheques require exactly one supplier and no dealer.');
  const supplier = await Supplier.findOne({ _id: data.supplier, status: 'active' }).session(session).lean();
  if (!supplier) throw routeError(404, 'Active supplier not found.');
  return { party: supplier, partyName: supplier.companyName, partyPhone: supplier.mobile || '' };
}

async function validatePaymentLink(paymentId, cheque, branchId, session = null, options = {}) {
  const payment = await Payment.findOne({ _id: paymentId, branch: branchId }).session(session);
  if (!payment) throw routeError(404, 'Linked Payment was not found in the active branch.');
  if (payment.paymentMode !== 'cheque') throw routeError(422, 'Linked Payment must use cheque mode.');

  const expectedType = cheque.chequeType === 'received' ? 'dealer_receipt' : 'supplier_payment';
  if (payment.paymentType !== expectedType) throw routeError(422, 'Linked Payment direction does not match the cheque type.');
  if (cheque.chequeType === 'received' && (!sameId(payment.dealer, cheque.dealer) || payment.supplier)) {
    throw routeError(422, 'Linked Payment dealer does not match the received cheque.');
  }
  if (cheque.chequeType === 'issued' && (!sameId(payment.supplier, cheque.supplier) || payment.dealer)) {
    throw routeError(422, 'Linked Payment supplier does not match the issued cheque.');
  }
  const paymentPaise = Math.round(Number(payment.amount) * 100);
  const chequePaise = Math.round(Number(cheque.amount) * 100);
  if (!Number.isSafeInteger(paymentPaise) || !Number.isSafeInteger(chequePaise) || paymentPaise !== chequePaise) {
    throw routeError(422, 'Linked Payment amount does not match the cheque amount exactly.');
  }
  if (!sameChequeNumber(payment.chequeNumber, cheque.chequeNumber)) {
    throw routeError(422, 'Linked Payment cheque number does not match.');
  }
  const targetChequeId = options.chequeId || options.excludeChequeId;
  if (payment.cheque && (!targetChequeId || !sameId(payment.cheque, targetChequeId))) {
    throw routeError(409, 'This Payment is already managed by another cheque.');
  }
  if (options.statuses && !options.statuses.includes(payment.status)) {
    throw routeError(409, `Linked Payment must be in ${options.statuses.join(' or ')} status; it is ${payment.status}.`);
  }

  const duplicateQuery = { branch: branchId, payment: payment._id };
  if (options.excludeChequeId) duplicateQuery._id = { $ne: options.excludeChequeId };
  const duplicate = await Cheque.exists(duplicateQuery).session(session);
  if (duplicate) throw routeError(409, 'This Payment is already linked to another cheque in the active branch.');
  return payment;
}

async function claimPaymentLink(payment, chequeId, branchId, session) {
  const claimed = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      branch: branchId,
      status: payment.status,
      $or: [{ cheque: chequeId }, { cheque: null }, { cheque: { $exists: false } }],
    },
    { $set: { cheque: chequeId } },
    { new: true, runValidators: true, session }
  );
  if (!claimed) {
    throw routeError(409, 'Linked Payment state or cheque ownership changed before it could be claimed.');
  }
  return claimed;
}

async function getScopedCheque(id, branchId, session = null) {
  return Cheque.findOne({ _id: id, branch: branchId }).session(session);
}

function ensureTransition(cheque, action) {
  const allowed = sourceStatuses(cheque, action);
  if (!allowed.includes(cheque.status)) {
    throw routeError(409, `Cannot ${action} a ${cheque.chequeType} cheque in ${cheque.status} status.`);
  }
}

function pickCreateData(body) {
  const data = {};
  for (const field of CREATE_FIELDS) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  data.chequeNumber = requiredText(data.chequeNumber, 'chequeNumber');
  data.chequeDate = requiredDate(data.chequeDate, 'chequeDate');
  data.amount = positiveAmount(data.amount);
  data.bankName = requiredText(data.bankName, 'bankName');
  data.chequeType = requiredText(data.chequeType, 'chequeType');
  for (const field of ['branchName', 'ifscCode', 'accountNumber', 'accountHolderName', 'micr',
    'againstOrderNumber', 'againstInvoiceNumber', 'chequeFrontImage', 'chequeBackImage',
    'securityFor', 'remarks']) {
    if (data[field] !== undefined) data[field] = optionalText(data[field]);
  }
  data.isSecurityCheque = Boolean(data.isSecurityCheque);
  data.isPDC = Boolean(data.isPDC);
  if (data.isPDC) data.pdcDueDate = requiredDate(data.pdcDueDate, 'pdcDueDate');
  else delete data.pdcDueDate;
  data.tags = Array.isArray(data.tags) ? data.tags.map(optionalText).filter(Boolean).slice(0, 20) : [];
  return data;
}

// GET /api/v1/cheques — branch-scoped list
router.get('/', requirePermission('cheque.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, chequeType, dateFrom, dateTo } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ chequeNumber: regex }, { partyName: regex }, { bankName: regex }, { paymentNumber: regex }];
    }
    if (status) filter.status = status;
    if (chequeType) filter.chequeType = chequeType;
    if (dateFrom || dateTo) {
      filter.chequeDate = {};
      if (dateFrom) filter.chequeDate.$gte = requiredDate(dateFrom, 'dateFrom');
      if (dateTo) filter.chequeDate.$lte = requiredDate(dateTo, 'dateTo');
    }

    const [records, total] = await Promise.all([
      Cheque.find(filter).sort({ chequeDate: -1, createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('supplier', 'companyName supplierCode')
        .populate({ path: 'payment', match: { branch: req.branchId }, select: 'paymentNumber paymentType paymentMode status amount chequeNumber createdBy' })
        .lean(),
      Cheque.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: records.map(record => decorateCheque(record, req.user._id)),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/cheques/stats — branch-scoped dashboard
router.get('/stats', requirePermission('cheque.view'), async (req, res) => {
  try {
    const branch = req.branchId;
    const [received, deposited, cleared, bounced, returned, reDeposited, totalReceived, totalCleared] = await Promise.all([
      Cheque.countDocuments({ branch, chequeType: 'received', status: 'received' }),
      Cheque.countDocuments({ branch, status: 'deposited' }),
      Cheque.countDocuments({ branch, status: 'cleared' }),
      Cheque.countDocuments({ branch, status: 'bounced' }),
      Cheque.countDocuments({ branch, status: 'returned' }),
      Cheque.countDocuments({ branch, status: 're_deposited' }),
      Cheque.aggregate([{ $match: { branch, chequeType: 'received', status: { $in: ['received', 'deposited', 're_deposited', 'cleared'] } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Cheque.aggregate([{ $match: { branch, status: 'cleared' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);
    return res.json({ success: true, data: {
      received, deposited, cleared, bounced, returned, reDeposited,
      totalReceived: totalReceived[0]?.total || 0,
      totalCleared: totalCleared[0]?.total || 0,
    } });
  } catch (error) { return sendError(res, error); }
});

// Candidate pending Payments are branch-scoped and exclude already-linked records.
router.get('/linkable-payments', requirePermission('cheque.create'), async (req, res) => {
  try {
    const { chequeType, dealer, supplier } = req.query;
    if (!['received', 'issued'].includes(chequeType)) throw routeError(422, 'A valid chequeType is required.');
    const filter = {
      branch: req.branchId,
      paymentMode: 'cheque',
      status: 'pending',
      cheque: null,
      paymentType: chequeType === 'received' ? 'dealer_receipt' : 'supplier_payment',
    };
    if (chequeType === 'received') {
      if (!dealer) throw routeError(422, 'dealer is required.');
      filter.dealer = dealer;
    } else {
      if (!supplier) throw routeError(422, 'supplier is required.');
      filter.supplier = supplier;
    }
    const linkedIds = await Cheque.find({ branch: req.branchId, payment: { $ne: null } }).distinct('payment');
    if (linkedIds.length) filter._id = { $nin: linkedIds };
    const payments = await Payment.find(filter)
      .select('paymentNumber paymentType paymentDate amount bankName chequeNumber chequeDate dealer supplier status')
      .sort({ paymentDate: -1 }).limit(100).lean();
    return res.json({ success: true, data: payments });
  } catch (error) { return sendError(res, error); }
});

router.get('/:id/re-deposit-candidates', requirePermission('cheque.return'), async (req, res) => {
  try {
    const cheque = await Cheque.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!cheque) throw routeError(404, 'Cheque not found in the active branch.');
    ensureTransition(cheque, 'reDeposit');
    const filter = {
      branch: req.branchId,
      paymentMode: 'cheque',
      status: 'pending',
      cheque: null,
      paymentType: 'dealer_receipt',
      dealer: cheque.dealer,
      amount: cheque.amount,
      chequeNumber: { $regex: `^${escapeRegex(cheque.chequeNumber)}$`, $options: 'i' },
      _id: { $ne: cheque.payment },
    };
    const linkedIds = await Cheque.find({ branch: req.branchId, payment: { $ne: null }, _id: { $ne: cheque._id } }).distinct('payment');
    if (linkedIds.length) filter._id = { $nin: [...linkedIds, cheque.payment].filter(Boolean) };
    const payments = await Payment.find(filter)
      .select('paymentNumber paymentDate amount bankName chequeNumber chequeDate status dealer')
      .sort({ paymentDate: -1 }).limit(100).lean();
    return res.json({ success: true, data: payments });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/cheques/:id — authoritative detail with branch-safe linkage and actors
router.get('/:id', requirePermission('cheque.view'), async (req, res) => {
  try {
    const cheque = await Cheque.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode mobile status')
      .populate('supplier', 'companyName supplierCode mobile status')
      .populate('createdBy', 'name email role')
      .populate('timeline.performedBy', 'name email role')
      .populate({
        path: 'payment',
        match: { branch: req.branchId },
        select: 'paymentNumber branch cheque paymentDate paymentType dealer supplier partyName againstOrders amount paymentMode bankName chequeNumber chequeDate transactionRef status bounceReason bounceCharges remarks createdBy createdAt updatedAt',
        populate: [
          { path: 'dealer', select: 'businessName dealerCode mobile' },
          { path: 'supplier', select: 'companyName supplierCode mobile' },
          { path: 'createdBy', select: 'name email role' },
          { path: 'againstOrders.order', select: 'orderNumber invoiceNumber invoiceRefNumber status paymentStatus grandTotal paidAmount balanceAmount' },
        ],
      })
      .lean();
    if (!cheque) throw routeError(404, 'Cheque not found in the active branch.');
    return res.json({ success: true, data: decorateCheque(cheque, req.user._id) });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/cheques — whitelist-only, server-owned state/timeline/party metadata
router.post('/', requirePermission('cheque.create'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let cheque;
    await session.withTransaction(async () => {
      const data = pickCreateData(req.body);
      const { partyName, partyPhone } = await validateParty(data, session);
      data.branch = req.branchId;
      data.partyName = partyName;
      data.partyPhone = partyPhone;
      data.status = data.chequeType === 'received' ? 'received' : 'issued';
      data.createdBy = req.user._id;
      data.createdByName = actorName(req);
      data._id = new mongoose.Types.ObjectId();

      let payment = null;
      if (data.payment) {
        payment = await validatePaymentLink(data.payment, data, req.branchId, session, {
          statuses: ['pending'], chequeId: data._id,
        });
        payment = await claimPaymentLink(payment, data._id, req.branchId, session);
        data.payment = payment._id;
        data.paymentNumber = payment.paymentNumber;
      } else {
        delete data.payment;
        data.paymentNumber = '';
      }
      data.timeline = [timelineEntry(
        req,
        data.status,
        null,
        data.status,
        `${data.chequeType === 'received' ? 'Received from' : 'Issued to'} ${partyName}.${payment ? ` Linked to pending Payment ${payment.paymentNumber}.` : ' Standalone cheque; no ledger entry was posted.'}`,
        payment,
        new Date()
      )];
      cheque = new Cheque(data);
      await cheque.save({ session });
    });
    return res.status(201).json({
      success: true,
      message: cheque.payment ? 'Cheque recorded and linked to Payment.' : 'Standalone cheque recorded; no accounting entry was posted.',
      data: cheque,
    });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.patch('/:id/deposit', requirePermission('cheque.deposit'), async (req, res) => {
  try {
    const current = await getScopedCheque(req.params.id, req.branchId);
    if (!current) throw routeError(404, 'Cheque not found in the active branch.');
    ensureTransition(current, 'deposit');
    const depositedDate = requiredDate(req.body.depositedDate, 'depositedDate');
    const depositedBank = requiredText(req.body.depositedBank, 'depositedBank');
    let payment = null;
    if (current.payment) {
      payment = await validatePaymentLink(current.payment, current, req.branchId, null, {
        statuses: ['pending'], excludeChequeId: current._id,
      });
    }
    const updated = await Cheque.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, status: current.status },
      {
        $set: {
          status: 'deposited', depositedDate, depositedBank,
          depositedBranch: optionalText(req.body.depositedBranch),
          depositedAccountNumber: optionalText(req.body.depositedAccountNumber),
          depositSlipNumber: optionalText(req.body.depositSlipNumber),
        },
        $push: { timeline: timelineEntry(
          req, 'deposited', current.status, 'deposited',
          `Deposited at ${depositedBank}${req.body.depositSlipNumber ? `; slip ${optionalText(req.body.depositSlipNumber)}` : ''}. No ledger entry was posted by deposit.`,
          payment, depositedDate
        ) },
      },
      { new: true, runValidators: true }
    );
    if (!updated) throw routeError(409, 'Cheque state changed before deposit could be recorded.');
    return res.json({ success: true, message: 'Cheque deposited. No ledger entry was posted.', accountingEffect: 'none', data: updated });
  } catch (error) { return sendError(res, error); }
});

router.patch('/:id/clear', requirePermission('cheque.clear'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const clearedDate = requiredDate(req.body.clearedDate, 'clearedDate');
    let cheque;
    let accountingEffect = 'none_unlinked';
    await session.withTransaction(async () => {
      const current = await getScopedCheque(req.params.id, req.branchId, session);
      if (!current) throw routeError(404, 'Cheque not found in the active branch.');
      ensureTransition(current, 'clear');
      assertMakerChecker(current, req, 'clear');

      let payment = null;
      if (current.payment) {
        payment = await validatePaymentLink(current.payment, current, req.branchId, session, {
          statuses: ['pending', 'confirmed'], excludeChequeId: current._id,
        });
        assertPaymentMakerChecker(payment, req, 'clear');
        payment = await claimPaymentLink(payment, current._id, req.branchId, session);
        if (payment.status === 'pending') {
          await validatePaymentData(payment.toObject(), session, { allowLegacySalesOrder: true });
          payment = await Payment.findOneAndUpdate(
            { _id: payment._id, branch: req.branchId, status: 'pending' },
            { $set: { status: 'confirmed', confirmedAt: clearedDate, bouncedAt: null, cancelledAt: null } },
            { new: true, runValidators: true, session }
          );
          if (!payment) throw routeError(409, 'Linked Payment state changed before clearance.');
          await applyPaymentEffects(payment, session);
          accountingEffect = 'linked_payment_applied';
        } else {
          accountingEffect = 'linked_payment_already_confirmed';
        }
      }

      cheque = await Cheque.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: current.status },
        {
          $set: {
            status: 'cleared', clearedDate,
            clearanceReference: optionalText(req.body.clearanceReference),
          },
          $push: { timeline: timelineEntry(
            req, 'cleared', current.status, 'cleared',
            payment
              ? `Cleared; linked Payment ${payment.paymentNumber} is confirmed${accountingEffect === 'linked_payment_applied' ? ' and accounting was applied atomically' : ' (accounting was already authoritative)'}.`
              : 'Cleared as a standalone cheque; no ledger/accounting entry was posted.',
            payment, clearedDate
          ) },
        },
        { new: true, runValidators: true, session }
      );
      if (!cheque) throw routeError(409, 'Cheque state changed before clearance.');
    });
    const message = accountingEffect === 'none_unlinked'
      ? 'Cheque cleared. It is unlinked, so no ledger/accounting entry was posted.'
      : 'Cheque cleared and linked Payment accounting is authoritative.';
    return res.json({ success: true, message, accountingEffect, data: cheque });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.patch('/:id/bounce', requirePermission('cheque.bounce'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const reason = requiredText(req.body.reason, 'reason');
    const bounceDate = requiredDate(req.body.bounceDate, 'bounceDate');
    const charges = nonnegativeAmount(req.body.charges, 'charges');
    let cheque;
    let accountingEffect = 'none_unlinked';
    await session.withTransaction(async () => {
      const current = await getScopedCheque(req.params.id, req.branchId, session);
      if (!current) throw routeError(404, 'Cheque not found in the active branch.');
      ensureTransition(current, 'bounce');
      assertMakerChecker(current, req, 'bounce');

      let payment = null;
      if (current.payment) {
        payment = await validatePaymentLink(current.payment, current, req.branchId, session, {
          statuses: ['pending', 'confirmed', 'bounced'], excludeChequeId: current._id,
        });
        assertPaymentMakerChecker(payment, req, 'bounce');
        payment = await claimPaymentLink(payment, current._id, req.branchId, session);
        const previousPaymentStatus = payment.status;
        if (previousPaymentStatus !== 'bounced') {
          payment = await Payment.findOneAndUpdate(
            { _id: payment._id, branch: req.branchId, status: previousPaymentStatus },
            { $set: { status: 'bounced', bouncedAt: bounceDate, bounceReason: reason, bounceCharges: charges } },
            { new: true, runValidators: true, session }
          );
          if (!payment) throw routeError(409, 'Linked Payment state changed before bounce processing.');
          if (previousPaymentStatus === 'confirmed') {
            await reversePaymentEffects(payment, charges, session);
            accountingEffect = 'linked_payment_reversed';
          } else {
            accountingEffect = 'linked_pending_payment_cancelled';
          }
        } else {
          accountingEffect = 'linked_payment_already_bounced';
        }
      }

      cheque = await Cheque.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: current.status },
        {
          $set: { status: 'bounced', bounceDate, bounceReason: reason, bounceCharges: charges },
          $inc: { bounceCount: 1 },
          $push: { timeline: timelineEntry(
            req, 'bounced', current.status, 'bounced',
            payment
              ? `Bounced: ${reason}; charges ₹${charges}. Linked Payment ${payment.paymentNumber} is bounced${accountingEffect === 'linked_payment_reversed' ? ' and prior accounting was reversed atomically' : '; no posted accounting required reversal'}.`
              : `Bounced: ${reason}; charges ₹${charges}. Standalone cheque; no ledger/accounting entry was reversed or posted.`,
            payment, bounceDate
          ) },
        },
        { new: true, runValidators: true, session }
      );
      if (!cheque) throw routeError(409, 'Cheque state changed before bounce processing.');
    });
    const message = accountingEffect === 'none_unlinked'
      ? 'Cheque marked bounced. It is unlinked, so no ledger/accounting entry was changed.'
      : 'Cheque and linked Payment marked bounced with accounting handled atomically.';
    return res.json({ success: true, message, accountingEffect, data: cheque });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.patch('/:id/re-deposit', requirePermission('cheque.return'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const reDepositDate = requiredDate(req.body.reDepositDate, 'reDepositDate');
    const reason = requiredText(req.body.reason, 'reason');
    let cheque;
    let contract;
    await session.withTransaction(async () => {
      const current = await getScopedCheque(req.params.id, req.branchId, session);
      if (!current) throw routeError(404, 'Cheque not found in the active branch.');
      ensureTransition(current, 'reDeposit');

      let oldPayment = null;
      if (current.payment) {
        oldPayment = await validatePaymentLink(current.payment, current, req.branchId, session, {
          statuses: ['bounced'], excludeChequeId: current._id,
        });
        oldPayment = await claimPaymentLink(oldPayment, current._id, req.branchId, session);
      }

      let replacementPayment = null;
      if (req.body.replacementPayment) {
        if (oldPayment && sameId(oldPayment._id, req.body.replacementPayment)) {
          throw routeError(422, 'A bounced Payment cannot be revived. Select a new pending Payment for this presentation.');
        }
        replacementPayment = await validatePaymentLink(req.body.replacementPayment, current, req.branchId, session, {
          statuses: ['pending'], excludeChequeId: current._id,
        });
        replacementPayment = await claimPaymentLink(replacementPayment, current._id, req.branchId, session);
      } else if (oldPayment) {
        throw routeError(422, 'Re-depositing a linked bounced cheque requires a distinct new pending replacementPayment. The old Payment will never be revived or reposted.');
      }

      const nextPayment = replacementPayment || null;
      contract = replacementPayment
        ? `Old Payment ${oldPayment?.paymentNumber || 'none'} remains bounced; replacement Payment ${replacementPayment.paymentNumber} is pending and will be applied only on clearance.`
        : 'Standalone cheque re-deposited; no ledger/accounting entry was posted.';
      cheque = await Cheque.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'bounced' },
        {
          $set: {
            status: 're_deposited', reDepositDate, depositedDate: reDepositDate,
            depositedBank: requiredText(req.body.depositedBank, 'depositedBank'),
            depositedBranch: optionalText(req.body.depositedBranch),
            depositedAccountNumber: optionalText(req.body.depositedAccountNumber),
            depositSlipNumber: optionalText(req.body.depositSlipNumber),
            payment: nextPayment?._id || null,
            paymentNumber: nextPayment?.paymentNumber || '',
          },
          $inc: { reDepositCount: 1 },
          $push: { timeline: timelineEntry(
            req, 're_deposited', current.status, 're_deposited',
            `Re-deposited: ${reason}. ${contract}`,
            nextPayment, reDepositDate
          ) },
        },
        { new: true, runValidators: true, session }
      );
      if (!cheque) throw routeError(409, 'Cheque state changed before re-deposit.');
    });
    return res.json({ success: true, message: `Cheque re-deposited. ${contract}`, accountingEffect: 'none_until_clearance', data: cheque });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.patch('/:id/return', requirePermission('cheque.return'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const returnedDate = requiredDate(req.body.returnedDate, 'returnedDate');
    const reason = requiredText(req.body.reason, 'reason');
    let cheque;
    let accountingEffect = 'none_unlinked';
    await session.withTransaction(async () => {
      const current = await getScopedCheque(req.params.id, req.branchId, session);
      if (!current) throw routeError(404, 'Cheque not found in the active branch.');
      ensureTransition(current, 'return');
      assertMakerChecker(current, req, 'return');

      let payment = null;
      if (current.payment) {
        payment = await validatePaymentLink(current.payment, current, req.branchId, session, {
          statuses: ['pending', 'bounced'], excludeChequeId: current._id,
        });
        assertPaymentMakerChecker(payment, req, 'return');
        payment = await claimPaymentLink(payment, current._id, req.branchId, session);
        if (payment.status === 'pending') {
          payment = await Payment.findOneAndUpdate(
            { _id: payment._id, branch: req.branchId, status: 'pending' },
            { $set: { status: 'cancelled', cancelledAt: returnedDate } },
            { new: true, runValidators: true, session }
          );
          if (!payment) throw routeError(409, 'Linked Payment state changed before return.');
          accountingEffect = 'linked_pending_payment_cancelled';
        } else {
          accountingEffect = 'linked_payment_already_bounced';
        }
      }

      cheque = await Cheque.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: current.status },
        {
          $set: { status: 'returned', returnedDate, returnReason: reason },
          $push: { timeline: timelineEntry(
            req, 'returned', current.status, 'returned',
            payment
              ? `Returned to ${current.partyName}: ${reason}. Linked Payment ${payment.paymentNumber} is ${payment.status}; no posted accounting was left active.`
              : `Returned to ${current.partyName}: ${reason}. Standalone cheque; no ledger/accounting entry was changed.`,
            payment, returnedDate
          ) },
        },
        { new: true, runValidators: true, session }
      );
      if (!cheque) throw routeError(409, 'Cheque state changed before return.');
    });
    return res.json({
      success: true,
      message: accountingEffect === 'none_unlinked'
        ? 'Cheque returned. It is unlinked, so no ledger/accounting entry was changed.'
        : 'Cheque returned and linked pending Payment safely closed.',
      accountingEffect,
      data: cheque,
    });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

export default router;
