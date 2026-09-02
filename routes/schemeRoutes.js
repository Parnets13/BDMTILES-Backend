import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import SupplierScheme from '../models/SupplierScheme.js';
import DealerScheme from '../models/DealerScheme.js';
import SchemeSettlement from '../models/SchemeSettlement.js';
import Supplier from '../models/Supplier.js';
import Dealer from '../models/Dealer.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';
import { uploadSupplierCreditNote, supplierCreditNoteDirectory, legacySupplierCreditNoteDirectory } from '../middleware/upload.js';
import { calculateDealerScheme, calculateSupplierScheme } from '../services/schemeCalculationService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const canView = requireAnyPermission('scheme.analysis', 'incentive.rules.view');
const canManage = requireAnyPermission('scheme.entry', 'incentive.rules.manage');
const canSubmit = requireAnyPermission('claim.submission', 'incentive.earnings.record');
const canApprove = requireAnyPermission('incentive.reconciliation', 'incentive.earnings.approve');

function routeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendError(res, error) {
  const status = error.status || (error.code === 11000 ? 409 : error.name === 'CastError' ? 422 : 500);
  return res.status(status).json({
    success: false,
    message: error.name === 'CastError' ? 'Invalid identifier.' : error.message,
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw routeError(422, `${field} is required.`);
  return text;
}

function nonnegative(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw routeError(422, `${field} must be a finite nonnegative number.`);
  return number;
}

function validDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw routeError(422, `${field} must be a valid date.`);
  return date;
}

function normalizeSlabs(source, basis, calculationType) {
  if (!['highest_slab', 'progressive_slab'].includes(calculationType)) return [];
  if (!Array.isArray(source) || !source.length) throw routeError(422, `${calculationType} requires at least one slab.`);
  const slabs = source.map((row, index) => {
    const from = nonnegative(row.from, `slabs[${index}].from`);
    const to = row.to === '' || row.to == null ? null : nonnegative(row.to, `slabs[${index}].to`);
    const rate = nonnegative(row.rate, `slabs[${index}].rate`);
    const fixedAmount = nonnegative(row.fixedAmount, `slabs[${index}].fixedAmount`);
    if (to != null && to <= from) throw routeError(422, `slabs[${index}].to must be greater than from.`);
    if ((rate > 0) === (fixedAmount > 0)) {
      throw routeError(422, `slabs[${index}] must use exactly one reward: rate or fixedAmount.`);
    }
    if (calculationType === 'progressive_slab' && fixedAmount > 0) {
      throw routeError(422, 'Progressive slabs use rates only; fixed slab rewards are ambiguous and unsupported.');
    }
    if (!basis.endsWith('quantity') && rate > 100) throw routeError(422, 'Value-based slab percentage rates cannot exceed 100.');
    return { from, to, rate, fixedAmount };
  }).sort((left, right) => left.from - right.from);
  for (let index = 1; index < slabs.length; index += 1) {
    const previous = slabs[index - 1];
    if (previous.to == null || slabs[index].from < previous.to) throw routeError(422, 'Slabs must be ordered, non-overlapping, and only the final slab may be open-ended.');
    if (calculationType === 'progressive_slab' && slabs[index].from !== previous.to) {
      throw routeError(422, 'Progressive slabs must be contiguous.');
    }
  }
  if (calculationType === 'progressive_slab' && slabs[0].from !== 0) {
    throw routeError(422, 'Progressive slabs must start at zero.');
  }
  return slabs;
}

function normalizeRule(body, partyType) {
  const unsupported = ['gift', 'points', 'gift_scheme', 'points_reward'];
  if (unsupported.includes(body.schemeType) || unsupported.includes(body.calculationType)) {
    throw routeError(422, 'Points and gifts require a real redemption ledger and are intentionally unsupported. Use a monetary rule.');
  }
  const allowedBasis = partyType === 'dealer'
    ? ['invoice_value', 'invoice_quantity', 'confirmed_payment']
    : ['purchase_value', 'purchase_quantity', 'confirmed_payment'];
  const basis = requiredText(body.basis, 'basis');
  if (!allowedBasis.includes(basis)) throw routeError(422, `basis must be one of ${allowedBasis.join(', ')}.`);
  const calculationType = requiredText(body.calculationType, 'calculationType');
  if (!['fixed', 'percentage', 'per_unit', 'highest_slab', 'progressive_slab'].includes(calculationType)) {
    throw routeError(422, 'Unsupported calculationType.');
  }
  if (calculationType === 'per_unit' && !basis.endsWith('quantity')) {
    throw routeError(422, 'per_unit calculation requires a quantity basis.');
  }
  if (calculationType === 'percentage' && basis.endsWith('quantity')) {
    throw routeError(422, 'percentage calculation requires a value or confirmed-payment basis.');
  }

  const products = [...new Set((Array.isArray(body.products) ? body.products : []).filter(Boolean).map(String))];
  if (products.some(value => !mongoose.isValidObjectId(value))) throw routeError(422, 'One or more products are invalid.');
  if (basis === 'confirmed_payment' && products.length) {
    throw routeError(422, 'Product filtering is unsupported for confirmed-payment rules because allocations are invoice-level.');
  }

  const startDate = validDate(body.startDate, 'startDate');
  const endDate = validDate(body.endDate, 'endDate');
  if (endDate < startDate) throw routeError(422, 'endDate must be on or after startDate.');
  const rate = nonnegative(body.rate, 'rate');
  if (calculationType === 'percentage' && rate > 100) throw routeError(422, 'Percentage rate cannot exceed 100.');
  const paymentWithinDays = nonnegative(body.paymentWithinDays, 'paymentWithinDays');
  if (paymentWithinDays > 365 || !Number.isInteger(paymentWithinDays)) {
    throw routeError(422, 'paymentWithinDays must be a whole number from 0 to 365.');
  }

  const rule = {
    schemeName: requiredText(body.schemeName, 'schemeName'),
    basis,
    calculationType,
    targetAmount: nonnegative(body.targetAmount, 'targetAmount'),
    targetQuantity: nonnegative(body.targetQuantity, 'targetQuantity'),
    rate,
    fixedAmount: nonnegative(body.fixedAmount, 'fixedAmount'),
    paymentWithinDays,
    products,
    slabs: normalizeSlabs(body.slabs, basis, calculationType),
    startDate,
    endDate,
    termsAndConditions: String(body.termsAndConditions || '').trim(),
  };
  if (calculationType === 'fixed' && rule.fixedAmount <= 0) throw routeError(422, 'fixed calculation requires fixedAmount greater than zero.');
  if (['percentage', 'per_unit'].includes(calculationType) && rule.rate <= 0) throw routeError(422, `${calculationType} requires rate greater than zero.`);
  return rule;
}

function dealerRule(body) {
  const rule = normalizeRule(body, 'dealer');
  const applicableTo = body.applicableTo || 'all';
  if (!['all', 'specific_dealers', 'dealer_category', 'dealer_type'].includes(applicableTo)) {
    throw routeError(422, 'Invalid applicableTo value.');
  }
  const dealers = [...new Set((Array.isArray(body.dealers) ? body.dealers : []).filter(Boolean).map(String))];
  if (dealers.some(value => !mongoose.isValidObjectId(value))) throw routeError(422, 'One or more dealer identifiers are invalid.');
  if (applicableTo === 'specific_dealers' && !dealers.length) throw routeError(422, 'Select at least one dealer.');
  if (applicableTo === 'dealer_category' && !mongoose.isValidObjectId(body.dealerCategory)) throw routeError(422, 'dealerCategory is required.');
  if (applicableTo === 'dealer_type' && !mongoose.isValidObjectId(body.dealerType)) throw routeError(422, 'dealerType is required.');
  return {
    ...rule,
    applicableTo,
    dealers: applicableTo === 'specific_dealers' ? dealers : [],
    dealerCategory: applicableTo === 'dealer_category' ? body.dealerCategory : null,
    dealerType: applicableTo === 'dealer_type' ? body.dealerType : null,
    description: String(body.description || '').trim(),
  };
}

function schemeRuleSnapshot(scheme) {
  const fields = [
    'basis', 'calculationType', 'targetAmount', 'targetQuantity', 'rate', 'fixedAmount',
    'paymentWithinDays', 'products', 'slabs', 'startDate', 'endDate', 'version',
    'applicableTo', 'dealers', 'dealerCategory', 'dealerType', 'supplier',
  ];
  const snapshot = { branch: scheme.branch, status: 'closed' };
  for (const field of fields) {
    if (scheme[field] !== undefined) snapshot[field] = scheme[field];
  }
  return snapshot;
}

async function supplierRule(body, session = null) {
  const rule = normalizeRule(body, 'supplier');
  if (!mongoose.isValidObjectId(body.supplier)) throw routeError(422, 'supplier is required.');
  const supplier = await Supplier.findOne({ _id: body.supplier, status: 'active' }).session(session).lean();
  if (!supplier) throw routeError(404, 'Active supplier not found.');
  return {
    ...rule,
    supplier: supplier._id,
    supplierName: supplier.companyName,
    remarks: String(body.remarks || '').trim(),
  };
}

function listFilter(req) {
  const filter = { branch: req.branchId };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), 'i');
    filter.$or = [{ schemeNumber: regex }, { schemeName: regex }, { supplierName: regex }];
  }
  return filter;
}

async function appendSettlementSummary(schemes, partyType) {
  if (!schemes.length) return schemes;
  const schemeField = partyType === 'dealer' ? 'dealerScheme' : 'supplierScheme';
  const rows = await SchemeSettlement.aggregate([
    { $match: { [schemeField]: { $in: schemes.map(row => row._id) }, status: { $in: ['submitted', 'approved'] } } },
    { $group: {
      _id: `$${schemeField}`,
      submitted: { $sum: { $cond: [
        { $eq: ['$status', 'submitted'] },
        { $cond: [{ $eq: ['$adjustmentType', 'clawback'] }, { $multiply: ['$amount', -1] }, '$amount'] },
        0,
      ] } },
      approved: { $sum: { $cond: [
        { $eq: ['$status', 'approved'] },
        { $cond: [{ $eq: ['$adjustmentType', 'clawback'] }, { $multiply: ['$amount', -1] }, '$amount'] },
        0,
      ] } },
      records: { $sum: 1 },
    } },
  ]);
  const summaries = new Map(rows.map(row => [String(row._id), row]));
  return schemes.map(row => ({ ...row, settlementSummary: summaries.get(String(row._id)) || { submitted: 0, approved: 0, records: 0 } }));
}

router.get('/supplier', canView, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = listFilter(req);
    if (req.query.supplier) filter.supplier = req.query.supplier;
    const [rows, total] = await Promise.all([
      SupplierScheme.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('supplier', 'companyName supplierCode').populate('products', 'itemName productCode').lean(),
      SupplierScheme.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: await appendSettlementSummary(rows, 'supplier'),
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, itemsPerPage: limit },
    });
  } catch (error) { return sendError(res, error); }
});

router.get('/supplier/stats', canView, async (req, res) => {
  try {
    const [total, active, settlementRows] = await Promise.all([
      SupplierScheme.countDocuments({ branch: req.branchId }),
      SupplierScheme.countDocuments({ branch: req.branchId, status: 'active' }),
      SchemeSettlement.aggregate([
        { $match: { branch: req.branchId, partyType: 'supplier' } },
        { $group: {
          _id: '$status', count: { $sum: 1 },
          amount: { $sum: { $cond: [{ $eq: ['$adjustmentType', 'clawback'] }, { $multiply: ['$amount', -1] }, '$amount'] } },
        } },
      ]),
    ]);
    const byStatus = Object.fromEntries(settlementRows.map(row => [row._id, row]));
    return res.json({ success: true, data: {
      total, active,
      submitted: byStatus.submitted?.count || 0,
      approved: byStatus.approved?.count || 0,
      approvedAmount: byStatus.approved?.amount || 0,
    } });
  } catch (error) { return sendError(res, error); }
});

router.post('/supplier', canManage, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let scheme;
    await session.withTransaction(async () => {
      const data = await supplierRule(req.body, session);
      data.branch = req.branchId;
      data.schemeNumber = await generateBranchNumber(req.branchId, 'supplier_scheme', data.startDate, { session });
      data.status = 'draft';
      data.createdBy = req.user._id;
      [scheme] = await SupplierScheme.create([data], { session });
    });
    return res.status(201).json({ success: true, message: `Scheme ${scheme.schemeNumber} created as draft.`, data: scheme });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.get('/supplier/:id', canView, async (req, res) => {
  try {
    const scheme = await SupplierScheme.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('supplier', 'companyName supplierCode').populate('products', 'itemName productCode').lean();
    if (!scheme) throw routeError(404, 'Scheme not found in the active branch.');
    return res.json({ success: true, data: scheme });
  } catch (error) { return sendError(res, error); }
});

router.get('/supplier/:id/analysis', canView, async (req, res) => {
  try {
    const scheme = await SupplierScheme.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    const result = await calculateSupplierScheme(scheme);
    return res.json({ success: true, data: { scheme, partyName: result.partyName, ...result.calculation, calculationFingerprint: result.fingerprint } });
  } catch (error) { return sendError(res, error); }
});

router.put('/supplier/:id', canManage, async (req, res) => {
  try {
    const current = await SupplierScheme.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) throw routeError(404, 'Scheme not found in the active branch.');
    if (!['draft', 'paused'].includes(current.status)) throw routeError(409, 'Only draft or paused schemes may be edited.');
    if (Number(req.body.version) !== current.version) throw routeError(409, 'Scheme was changed by another user. Reload before editing.');
    const data = await supplierRule(req.body);
    Object.assign(current, data, { version: current.version + 1, updatedBy: req.user._id });
    await current.save();
    return res.json({ success: true, message: 'Scheme rule updated and versioned.', data: current });
  } catch (error) { return sendError(res, error); }
});

router.get('/dealer', canView, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = listFilter(req);
    const [rows, total] = await Promise.all([
      DealerScheme.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('products', 'itemName productCode').lean(),
      DealerScheme.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: await appendSettlementSummary(rows, 'dealer'),
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, itemsPerPage: limit },
    });
  } catch (error) { return sendError(res, error); }
});

router.post('/dealer', canManage, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let scheme;
    await session.withTransaction(async () => {
      const data = dealerRule(req.body);
      data.branch = req.branchId;
      data.schemeNumber = await generateBranchNumber(req.branchId, 'dealer_scheme', data.startDate, { session });
      data.status = 'draft';
      data.createdBy = req.user._id;
      [scheme] = await DealerScheme.create([data], { session });
    });
    return res.status(201).json({ success: true, message: `Dealer scheme ${scheme.schemeNumber} created as draft.`, data: scheme });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.get('/dealer-analysis', canView, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.query.dealer)) throw routeError(422, 'dealer is required.');
    const schemes = await DealerScheme.find({ branch: req.branchId, status: { $in: ['active', 'expired', 'closed'] } }).lean();
    const results = [];
    for (const scheme of schemes) {
      try {
        const calculation = await calculateDealerScheme(scheme, req.query.dealer);
        results.push({ scheme, partyName: calculation.partyName, ...calculation.calculation, calculationFingerprint: calculation.fingerprint });
      } catch (error) {
        if (error.status !== 422) throw error;
      }
    }
    return res.json({ success: true, data: results });
  } catch (error) { return sendError(res, error); }
});

router.get('/dealer/:id', canView, async (req, res) => {
  try {
    const scheme = await DealerScheme.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealers', 'businessName dealerCode').populate('products', 'itemName productCode').lean();
    if (!scheme) throw routeError(404, 'Scheme not found in the active branch.');
    return res.json({ success: true, data: scheme });
  } catch (error) { return sendError(res, error); }
});

router.get('/dealer/:id/analysis', canView, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.query.dealer)) throw routeError(422, 'dealer is required.');
    const scheme = await DealerScheme.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    const result = await calculateDealerScheme(scheme, req.query.dealer);
    return res.json({ success: true, data: { scheme, partyName: result.partyName, ...result.calculation, calculationFingerprint: result.fingerprint } });
  } catch (error) { return sendError(res, error); }
});

router.put('/dealer/:id', canManage, async (req, res) => {
  try {
    const current = await DealerScheme.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) throw routeError(404, 'Scheme not found in the active branch.');
    if (!['draft', 'paused'].includes(current.status)) throw routeError(409, 'Only draft or paused schemes may be edited.');
    if (Number(req.body.version) !== current.version) throw routeError(409, 'Scheme was changed by another user. Reload before editing.');
    Object.assign(current, dealerRule(req.body), { version: current.version + 1, updatedBy: req.user._id });
    await current.save();
    return res.json({ success: true, message: 'Scheme rule updated and versioned.', data: current });
  } catch (error) { return sendError(res, error); }
});

async function changeStatus(Model, req, res) {
  try {
    const scheme = await Model.findOne({ _id: req.params.id, branch: req.branchId });
    if (!scheme) throw routeError(404, 'Scheme not found in the active branch.');
    const next = requiredText(req.body.status, 'status');
    const transitions = {
      draft: ['active'], active: ['paused', 'expired', 'closed'],
      paused: ['active', 'closed'], expired: ['closed'], closed: [],
    };
    if (!transitions[scheme.status]?.includes(next)) throw routeError(409, `Cannot change ${scheme.status} scheme to ${next}.`);
    scheme.status = next;
    scheme.updatedBy = req.user._id;
    await scheme.save();
    return res.json({ success: true, message: `Scheme status changed to ${next}.`, data: scheme });
  } catch (error) { return sendError(res, error); }
}

router.patch('/supplier/:id/status', canManage, (req, res) => changeStatus(SupplierScheme, req, res));
router.patch('/dealer/:id/status', canManage, (req, res) => changeStatus(DealerScheme, req, res));

async function submitBaseSettlement(req, res, partyType) {
  const session = await mongoose.startSession();
  try {
    let settlement;
    let replay = false;
    await session.withTransaction(async () => {
      const Model = partyType === 'dealer' ? DealerScheme : SupplierScheme;
      const scheme = await Model.findOne({ _id: req.params.id, branch: req.branchId }).session(session).lean();
      const result = partyType === 'dealer'
        ? await calculateDealerScheme(scheme, req.body.dealer, session)
        : await calculateSupplierScheme(scheme, session);
      if (!result.calculation.eligible || result.calculation.earnedAmount <= 0) {
        throw routeError(422, 'Authoritative sources do not currently produce an eligible monetary incentive.');
      }
      const partyId = partyType === 'dealer' ? req.body.dealer : scheme.supplier;
      const rootKey = `${req.branchId}:${partyType}:${scheme._id}:${partyId}:${new Date(scheme.startDate).toISOString()}:${new Date(scheme.endDate).toISOString()}`;
      const survivingAdjustment = await SchemeSettlement.exists({
        branch: req.branchId,
        rootKey,
        adjustmentType: { $ne: 'base' },
        status: { $in: ['submitted', 'approved'] },
      }).session(session);
      if (survivingAdjustment) {
        throw routeError(409, 'A replacement base cannot be submitted while supplemental or clawback records remain active. Resolve that settlement chain first.');
      }
      const baseScopeKey = `${rootKey}:${result.fingerprint}:base`;
      settlement = await SchemeSettlement.findOne({
        branch: req.branchId,
        rootKey,
        calculationFingerprint: result.fingerprint,
        adjustmentType: 'base',
        status: { $in: ['submitted', 'approved'] },
      }).session(session);
      if (settlement) { replay = true; return; }
      const priorAttempts = await SchemeSettlement.countDocuments({
        branch: req.branchId,
        rootKey,
        calculationFingerprint: result.fingerprint,
        adjustmentType: 'base',
      }).session(session);
      const scopeKey = priorAttempts ? `${baseScopeKey}:attempt:${priorAttempts + 1}` : baseScopeKey;
      await SchemeSettlement.updateMany(
        { branch: req.branchId, rootKey, status: 'submitted', adjustmentType: 'base' },
        { $set: { status: 'superseded' } },
        { session }
      );
      const settlementNumber = await generateBranchNumber(
        req.branchId,
        partyType === 'dealer' ? 'dealer_scheme_claim' : 'supplier_scheme_claim',
        new Date(),
        { session }
      );
      settlement = new SchemeSettlement({
        branch: req.branchId,
        settlementNumber,
        partyType,
        dealer: partyType === 'dealer' ? partyId : null,
        supplier: partyType === 'supplier' ? partyId : null,
        partyName: result.partyName,
        dealerScheme: partyType === 'dealer' ? scheme._id : null,
        supplierScheme: partyType === 'supplier' ? scheme._id : null,
        schemeNumber: scheme.schemeNumber,
        schemeName: scheme.schemeName,
        schemeVersion: scheme.version,
        periodStart: scheme.startDate,
        periodEnd: scheme.endDate,
        rootKey,
        scopeKey,
        calculationFingerprint: result.fingerprint,
        ruleSnapshot: schemeRuleSnapshot(scheme),
        calculation: result.calculation,
        amount: result.calculation.earnedAmount,
        adjustmentType: 'base',
        notes: String(req.body.notes || '').trim(),
        submittedBy: req.user._id,
      });
      await settlement.save({ session });
    });
    return res.status(replay ? 200 : 201).json({
      success: true,
      message: replay ? 'This authoritative calculation was already submitted.' : 'Authoritative incentive submitted for independent approval.',
      data: settlement,
    });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
}

router.post('/dealer/:id/submit', canSubmit, (req, res) => submitBaseSettlement(req, res, 'dealer'));
router.post('/supplier/:id/submit', canSubmit, (req, res) => submitBaseSettlement(req, res, 'supplier'));

router.get('/settlements', canView, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { branch: req.branchId };
    if (req.query.partyType) filter.partyType = req.query.partyType;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.scheme) filter.$or = [{ dealerScheme: req.query.scheme }, { supplierScheme: req.query.scheme }];
    const [rows, total] = await Promise.all([
      SchemeSettlement.find(filter).sort({ submittedAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('dealer', 'businessName dealerCode').populate('supplier', 'companyName supplierCode')
        .populate('submittedBy approvedBy reversedBy supplierCreditNote.receivedBy supplierCreditNote.verifiedBy', 'name email role').lean(),
      SchemeSettlement.countDocuments(filter),
    ]);
    return res.json({ success: true, data: rows, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total, itemsPerPage: limit } });
  } catch (error) { return sendError(res, error); }
});

router.get('/settlements/:id', canView, async (req, res) => {
  try {
    const settlement = await SchemeSettlement.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode mobile').populate('supplier', 'companyName supplierCode mobile')
      .populate('dealerScheme supplierScheme')
      .populate('submittedBy approvedBy reversedBy supplierCreditNote.receivedBy supplierCreditNote.verifiedBy', 'name email role').lean();
    if (!settlement) throw routeError(404, 'Scheme settlement not found in the active branch.');
    return res.json({ success: true, data: settlement });
  } catch (error) { return sendError(res, error); }
});

async function recalculateSettlement(settlement, session) {
  const historical = settlement.adjustmentType !== 'base' || settlement.status === 'approved';
  const scheme = historical
    ? { ...settlement.ruleSnapshot, branch: settlement.branch, status: 'closed' }
    : settlement.partyType === 'dealer'
      ? await DealerScheme.findOne({ _id: settlement.dealerScheme, branch: settlement.branch }).session(session).lean()
      : await SupplierScheme.findOne({ _id: settlement.supplierScheme, branch: settlement.branch }).session(session).lean();
  if (!scheme) throw routeError(409, 'The source scheme rule no longer exists.');
  const options = historical ? { historical: true } : {};
  const result = settlement.partyType === 'dealer'
    ? await calculateDealerScheme(scheme, settlement.dealer, session, options)
    : await calculateSupplierScheme(scheme, session, options);
  return { scheme, result };
}

function signedAmount(row) {
  return row.adjustmentType === 'clawback' ? -Number(row.amount) : Number(row.amount);
}

async function assertCurrentCalculation(settlement, session) {
  const { result } = await recalculateSettlement(settlement, session);
  if (settlement.adjustmentType === 'base') {
    const activeBase = await SchemeSettlement.exists({
      branch: settlement.branch,
      rootKey: settlement.rootKey,
      adjustmentType: 'base',
      status: 'approved',
      _id: { $ne: settlement._id },
    }).session(session);
    if (activeBase) throw routeError(409, 'This scheme, party, and period already has an approved base settlement.');
    if (result.fingerprint !== settlement.calculationFingerprint
      || Math.abs(result.calculation.earnedAmount - settlement.amount) > 0.01) {
      throw routeError(409, 'Source invoices, returns, or confirmed payments changed after submission. Submit a fresh server calculation.');
    }
  } else {
    const approved = await SchemeSettlement.find({
      branch: settlement.branch,
      rootKey: settlement.rootKey,
      status: 'approved',
      _id: { $ne: settlement._id },
    }).select('amount adjustmentType').session(session).lean();
    const accounted = approved.reduce((sum, row) => sum + signedAmount(row), 0);
    const difference = Math.round((result.calculation.earnedAmount - accounted + Number.EPSILON) * 100) / 100;
    const expectedType = difference >= 0 ? 'supplemental' : 'clawback';
    if (result.fingerprint !== settlement.calculationFingerprint
      || expectedType !== settlement.adjustmentType
      || Math.abs(Math.abs(difference) - settlement.amount) > 0.01) {
      throw routeError(409, 'Adjustment sources or prior accounting changed. Generate a fresh adjustment submission.');
    }
  }
  return result;
}

router.patch('/settlements/:id/approve', canApprove, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let settlement;
    await session.withTransaction(async () => {
      const current = await SchemeSettlement.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Scheme settlement not found in the active branch.');
      if (current.status !== 'submitted') throw routeError(409, `Only submitted records can be approved; this record is ${current.status}.`);
      if (String(current.submittedBy) === String(req.user._id)) throw routeError(403, 'The submitter cannot approve the same incentive.');
      await assertCurrentCalculation(current, session);

      const isClawback = current.adjustmentType === 'clawback';
      const side = current.partyType === 'dealer'
        ? (isClawback ? 'debit' : 'credit')
        : (isClawback ? 'credit' : 'debit');
      const entryType = current.partyType === 'dealer'
        ? (isClawback ? 'debit_note' : 'credit_note')
        : (isClawback ? 'credit_note' : 'debit_note');
      const documentType = `${current.partyType}_scheme_${entryType}`;
      const noteDate = new Date();
      const noteNumber = await generateBranchNumber(req.branchId, documentType, noteDate, { session });
      const postingKey = `scheme-settlement:${current._id}:approved`;
      await postSubledgerEntry({
        session,
        branch: req.branchId,
        partyType: current.partyType,
        partyId: current.partyType === 'dealer' ? current.dealer : current.supplier,
        amount: current.amount,
        side,
        postingKey,
        entryType,
        entryDate: noteDate,
        description: `${current.adjustmentType} ${current.schemeName} (${current.periodStart.toISOString().slice(0, 10)} to ${current.periodEnd.toISOString().slice(0, 10)})`,
        referenceNumber: noteNumber,
        referenceModel: 'SchemeSettlement',
        referenceId: current._id,
        createdBy: req.user._id,
      });
      settlement = await SchemeSettlement.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'submitted' },
        { $set: {
          status: 'approved', approvedBy: req.user._id, approvedAt: noteDate,
          accountingNoteNumber: noteNumber, accountingNoteDate: noteDate, postingKey,
        } },
        { new: true, runValidators: true, session }
      );
      if (!settlement) throw routeError(409, 'Settlement state changed before approval.');
    });
    return res.json({
      success: true,
      message: settlement.partyType === 'dealer'
        ? `Dealer ${settlement.adjustmentType === 'clawback' ? 'debit' : 'credit'} note posted to the dealer ledger.`
        : `Internal supplier ${settlement.adjustmentType === 'clawback' ? 'credit' : 'debit'} memo posted. Capture the supplier-issued GST credit note separately when applicable.`,
      data: settlement,
    });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.post('/settlements/:id/adjustment', canSubmit, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let adjustment;
    let replay = false;
    await session.withTransaction(async () => {
      const parent = await SchemeSettlement.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!parent) throw routeError(404, 'Scheme settlement not found in the active branch.');
      if (parent.status !== 'approved') throw routeError(409, 'Adjustments can only be generated from active approved accounting.');
      const { result } = await recalculateSettlement(parent, session);
      const approved = await SchemeSettlement.find({ branch: req.branchId, rootKey: parent.rootKey, status: 'approved' })
        .select('amount adjustmentType').session(session).lean();
      const accounted = approved.reduce((sum, row) => sum + signedAmount(row), 0);
      const difference = Math.round((result.calculation.earnedAmount - accounted + Number.EPSILON) * 100) / 100;
      if (Math.abs(difference) <= 0.01) throw routeError(409, 'Current authoritative entitlement already matches posted accounting.');
      const adjustmentType = difference > 0 ? 'supplemental' : 'clawback';
      const absoluteDifference = Math.abs(difference);
      const baseScopeKey = `${parent.rootKey}:${result.fingerprint}:${adjustmentType}:${absoluteDifference.toFixed(2)}`;
      adjustment = await SchemeSettlement.findOne({
        branch: req.branchId,
        rootKey: parent.rootKey,
        calculationFingerprint: result.fingerprint,
        adjustmentType,
        amount: absoluteDifference,
        status: { $in: ['submitted', 'approved'] },
      }).session(session);
      if (adjustment) { replay = true; return; }
      const priorAttempts = await SchemeSettlement.countDocuments({
        branch: req.branchId,
        rootKey: parent.rootKey,
        calculationFingerprint: result.fingerprint,
        adjustmentType,
        amount: absoluteDifference,
      }).session(session);
      const scopeKey = priorAttempts ? `${baseScopeKey}:attempt:${priorAttempts + 1}` : baseScopeKey;
      await SchemeSettlement.updateMany(
        { branch: req.branchId, rootKey: parent.rootKey, status: 'submitted', adjustmentType: { $ne: 'base' } },
        { $set: { status: 'superseded' } },
        { session }
      );
      const settlementNumber = await generateBranchNumber(req.branchId, `${parent.partyType}_scheme_adjustment`, new Date(), { session });
      adjustment = new SchemeSettlement({
        branch: req.branchId,
        settlementNumber,
        partyType: parent.partyType,
        dealer: parent.dealer,
        supplier: parent.supplier,
        partyName: parent.partyName,
        dealerScheme: parent.dealerScheme,
        supplierScheme: parent.supplierScheme,
        schemeNumber: parent.schemeNumber,
        schemeName: parent.schemeName,
        schemeVersion: parent.schemeVersion,
        periodStart: parent.periodStart,
        periodEnd: parent.periodEnd,
        rootKey: parent.rootKey,
        scopeKey,
        calculationFingerprint: result.fingerprint,
        ruleSnapshot: parent.ruleSnapshot,
        calculation: { ...result.calculation, accountedAmount: accounted, adjustmentDifference: difference },
        amount: Math.abs(difference),
        adjustmentType,
        parentSettlement: parent._id,
        notes: String(req.body.notes || '').trim(),
        submittedBy: req.user._id,
      });
      await adjustment.save({ session });
    });
    return res.status(replay ? 200 : 201).json({
      success: true,
      message: replay ? 'This adjustment was already submitted.' : `${adjustment.adjustmentType} adjustment submitted for independent approval.`,
      data: adjustment,
    });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.patch('/settlements/:id/reverse', canApprove, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let settlement;
    const reason = requiredText(req.body.reason, 'reason');
    await session.withTransaction(async () => {
      const current = await SchemeSettlement.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Scheme settlement not found in the active branch.');
      if (current.status !== 'approved') throw routeError(409, `Only approved records can be reversed; this record is ${current.status}.`);
      if ([current.submittedBy, current.approvedBy].some(actor => String(actor) === String(req.user._id))) {
        throw routeError(403, 'Reversal requires a third actor who was neither submitter nor approver.');
      }
      if (current.adjustmentType === 'base') {
        const activeDependent = await SchemeSettlement.exists({
          branch: req.branchId,
          rootKey: current.rootKey,
          adjustmentType: { $ne: 'base' },
          status: { $in: ['submitted', 'approved'] },
        }).session(session);
        if (activeDependent) {
          throw routeError(409, 'Reverse or supersede every active supplemental/clawback record before reversing the base settlement.');
        }
      }
      const reversedAt = new Date();
      const reversalPostingKey = `scheme-settlement:${current._id}:reversed`;
      await postSubledgerEntry({
        session,
        branch: req.branchId,
        partyType: current.partyType,
        partyId: current.partyType === 'dealer' ? current.dealer : current.supplier,
        postingKey: reversalPostingKey,
        reversalOfPostingKey: current.postingKey,
        entryType: current.partyType === 'dealer'
          ? (current.adjustmentType === 'clawback' ? 'credit_note' : 'debit_note')
          : (current.adjustmentType === 'clawback' ? 'debit_note' : 'credit_note'),
        entryDate: reversedAt,
        description: `Reversal of ${current.accountingNoteNumber}: ${reason}`,
        referenceNumber: current.accountingNoteNumber,
        referenceModel: 'SchemeSettlement',
        referenceId: current._id,
        createdBy: req.user._id,
      });
      const reversalState = {
        status: 'reversed', reversedBy: req.user._id, reversedAt, reversalReason: reason, reversalPostingKey,
      };
      if (current.partyType === 'supplier' && current.supplierCreditNote?.status) {
        reversalState['supplierCreditNote.status'] = 'superseded_by_reversal';
        reversalState['supplierCreditNote.verificationRemarks'] = [
          current.supplierCreditNote.verificationRemarks,
          `Accounting reversed on ${reversedAt.toISOString()}: ${reason}`,
        ].filter(Boolean).join(' | ');
      }
      settlement = await SchemeSettlement.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'approved' },
        { $set: reversalState },
        { new: true, runValidators: true, session }
      );
      if (!settlement) throw routeError(409, 'Settlement state changed before reversal.');
    });
    return res.json({ success: true, message: 'Scheme accounting reversed exactly against the original posting.', data: settlement });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.get('/settlements/:id/supplier-credit-note/document', canView, async (req, res) => {
  try {
    const settlement = await SchemeSettlement.findOne({ _id: req.params.id, branch: req.branchId })
      .select('partyType supplierCreditNote')
      .lean();
    if (!settlement) throw routeError(404, 'Scheme settlement not found in the active branch.');
    if (settlement.partyType !== 'supplier' || !settlement.supplierCreditNote?.documentUrl) {
      throw routeError(404, 'Supplier credit-note evidence not found.');
    }
    const storedName = settlement.supplierCreditNote.storedName
      || String(settlement.supplierCreditNote.documentUrl).split('/').filter(Boolean).at(-1);
    if (!storedName || path.basename(storedName) !== storedName) throw routeError(409, 'Stored evidence reference is invalid.');
    const directory = settlement.supplierCreditNote.storedName
      ? supplierCreditNoteDirectory
      : legacySupplierCreditNoteDirectory;
    const content = await fs.promises.readFile(path.join(directory, storedName));
    res.type(settlement.supplierCreditNote.mimeType || 'application/octet-stream');
    res.attachment(settlement.supplierCreditNote.originalName || storedName);
    return res.send(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendError(res, routeError(404, 'Supplier credit-note evidence file is unavailable.'));
    return sendError(res, error);
  }
});

router.post('/settlements/:id/supplier-credit-note', canSubmit, uploadSupplierCreditNote, async (req, res) => {
  try {
    if (!req.file) throw routeError(422, 'Supplier credit-note document is required.');
    const amount = nonnegative(req.body.amount, 'amount');
    const current = await SchemeSettlement.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) throw routeError(404, 'Scheme settlement not found in the active branch.');
    if (current.partyType !== 'supplier' || current.status !== 'approved' || current.adjustmentType === 'clawback') {
      throw routeError(409, 'Supplier credit-note evidence applies only to approved supplier claims or supplemental claims.');
    }
    if (['pending_verification', 'verified'].includes(current.supplierCreditNote?.status)) {
      throw routeError(409, 'Existing supplier credit-note evidence must be verified or rejected before another immutable attempt can be captured.');
    }
    if (Math.abs(amount - current.amount) > 0.01) throw routeError(422, 'Supplier credit-note amount must equal the approved internal claim amount.');
    const documentHash = createHash('sha256').update(await fs.promises.readFile(req.file.path)).digest('hex');
    const noteNumber = requiredText(req.body.noteNumber, 'noteNumber').toUpperCase();
    if (current.supplierCreditNote?.status === 'rejected') {
      current.supplierCreditNoteHistory.push(current.supplierCreditNote.toObject?.() || current.supplierCreditNote);
    }
    current.supplierEvidenceKeys = [...new Set([
      ...(current.supplierEvidenceKeys || []),
      `note:${noteNumber}`,
      `sha256:${documentHash}`,
    ])];
    current.supplierCreditNote = {
      noteNumber,
      noteDate: validDate(req.body.noteDate, 'noteDate'),
      amount,
      documentUrl: `/api/v1/schemes/settlements/${current._id}/supplier-credit-note/document`,
      storedName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      documentHash,
      status: 'pending_verification',
      receivedBy: req.user._id,
      receivedAt: new Date(),
    };
    await current.save();
    return res.status(201).json({
      success: true,
      message: 'Supplier-issued credit note captured for independent verification. No second ledger posting was created.',
      data: current,
    });
  } catch (error) {
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    return sendError(res, error);
  }
});

router.patch('/settlements/:id/supplier-credit-note/verify', canApprove, async (req, res) => {
  try {
    const current = await SchemeSettlement.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) throw routeError(404, 'Scheme settlement not found in the active branch.');
    if (current.partyType !== 'supplier' || current.status !== 'approved') throw routeError(409, 'Only active approved supplier claims can verify credit-note evidence.');
    if (current.supplierCreditNote?.status !== 'pending_verification') throw routeError(409, 'No supplier credit note is awaiting verification.');
    if (String(current.supplierCreditNote.receivedBy) === String(req.user._id)) {
      throw routeError(403, 'The evidence receiver cannot verify the same supplier credit note.');
    }
    const decision = requiredText(req.body.decision, 'decision');
    if (!['verified', 'rejected'].includes(decision)) throw routeError(422, 'decision must be verified or rejected.');
    current.supplierCreditNote.status = decision;
    current.supplierCreditNote.verifiedBy = req.user._id;
    current.supplierCreditNote.verifiedAt = new Date();
    current.supplierCreditNote.verificationRemarks = String(req.body.remarks || '').trim();
    await current.save();
    return res.json({
      success: true,
      message: decision === 'verified'
        ? 'Supplier-issued GST credit note verified. Existing internal debit-memo accounting remains the only posting.'
        : 'Supplier credit-note evidence rejected; no accounting was changed.',
      data: current,
    });
  } catch (error) { return sendError(res, error); }
});

router.patch('/supplier/:id/claim', canSubmit, (_req, res) => res.status(410).json({
  success: false,
  message: 'Caller-provided claim amounts are disabled. Use POST /supplier/:id/submit for a server-calculated claim.',
}));
router.patch('/supplier/:id/settle', canApprove, (_req, res) => res.status(410).json({
  success: false,
  message: 'Manual settlement is disabled. Approve the submitted settlement record through maker-checker.',
}));
router.patch('/supplier/:id/update-achievement', requirePermission('scheme.analysis'), (_req, res) => res.status(410).json({
  success: false,
  message: 'Manual achievement updates are disabled. Achievement is calculated from verified invoices, returns, and confirmed payments.',
}));

export default router;
