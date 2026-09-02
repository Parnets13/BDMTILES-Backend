import { Router } from 'express';
import mongoose from 'mongoose';
import DealerPricing from '../models/DealerPricing.js';
import DealerPricingHistory from '../models/DealerPricingHistory.js';
import DealerPricingSchedule from '../models/DealerPricingSchedule.js';
import Product from '../models/Product.js';
import Dealer from '../models/Dealer.js';
import DealerType from '../models/DealerType.js';
import { resolvePricing } from '../services/pricingResolver.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { roundMoney } from '../utils/pricingCalculations.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const SCOPES = new Set(['dealer', 'dealer_type', 'walk_in']);
const CHANGE_TYPES = new Set(['increase_percent', 'decrease_percent', 'increase_flat', 'decrease_flat', 'set_value']);
const TIER_FIELDS = ['dealerRate', 'wholesaleRate', 'retailRate', 'distributorRate', 'builderRate', 'projectRate'];
const routeError = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, error) => {
  let status = error.status;
  if (!status && ['CastError', 'ValidationError'].includes(error.name)) status = 422;
  if (!status && error.code === 11000) status = 409;
  return res.status(status || 500).json({ success: false, message: error.message });
};
const snapshot = (document) => document?.toObject ? document.toObject() : document;

function parseTarget(source = {}) {
  const scope = source.scope || (source.dealer ? 'dealer' : source.dealerType ? 'dealer_type' : 'walk_in');
  if (!SCOPES.has(scope)) throw routeError(422, 'scope must be dealer, dealer_type, or walk_in.');
  const dealer = source.dealer || source.dealerId || null;
  const dealerType = source.dealerType || source.dealerTypeId || null;
  if (scope === 'dealer' && !dealer) throw routeError(422, 'dealer is required for dealer scope.');
  if (scope === 'dealer_type' && !dealerType) throw routeError(422, 'dealerType is required for dealer_type scope.');
  if (scope === 'walk_in' && (dealer || dealerType)) throw routeError(422, 'walk_in scope cannot include dealer or dealerType.');
  return { scope, dealer, dealerType };
}
async function validateTarget(target, session = null) {
  if (target.scope === 'dealer') {
    if (!mongoose.isValidObjectId(target.dealer)) throw routeError(422, 'dealer is invalid.');
    let query = Dealer.findById(target.dealer).populate('dealerType', 'name pricingTier status');
    if (session) query = query.session(session);
    const dealer = await query.lean();
    if (!dealer) throw routeError(404, 'Dealer not found.');
    if (dealer.status !== 'active') throw routeError(422, 'Dealer is not active.');
    if (dealer.dealerType && dealer.dealerType.status !== 'active') throw routeError(422, 'DealerType is not active.');
    return { ...target, dealerDoc: dealer, dealerTypeDoc: dealer.dealerType || null };
  }
  if (target.scope === 'dealer_type') {
    if (!mongoose.isValidObjectId(target.dealerType)) throw routeError(422, 'dealerType is invalid.');
    let query = DealerType.findById(target.dealerType);
    if (session) query = query.session(session);
    const dealerType = await query.lean();
    if (!dealerType) throw routeError(404, 'DealerType not found.');
    if (dealerType.status !== 'active') throw routeError(422, 'DealerType is not active.');
    return { ...target, dealerTypeDoc: dealerType };
  }
  return target;
}
function targetFields(target) {
  if (target.scope === 'dealer') {
    return { scope: 'dealer', dealer: target.dealer, customerType: 'dealer', customerId: target.dealer, dealerType: undefined };
  }
  if (target.scope === 'dealer_type') {
    return { scope: 'dealer_type', dealerType: target.dealerType, dealer: undefined, customerId: undefined };
  }
  return { scope: 'walk_in', dealer: undefined, dealerType: undefined, customerId: undefined };
}
function targetFilter(branch, target, product) {
  if (target.scope === 'dealer') {
    return {
      branch, product,
      $or: [
        { scope: 'dealer', dealer: target.dealer },
        { scope: { $exists: false }, dealer: target.dealer },
        { customerType: 'dealer', customerId: target.dealer },
      ],
    };
  }
  if (target.scope === 'dealer_type') return { branch, scope: 'dealer_type', dealerType: target.dealerType, product };
  return { branch, scope: 'walk_in', product };
}
function productFilter(source = {}) {
  const filter = { status: 'active' };
  if (source.search) {
    const regex = new RegExp(String(source.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ itemName: regex }, { productCode: regex }, { aliasName: regex }, { barcode: regex }];
  }
  if (source.brand) filter.brand = source.brand;
  if (source.category) filter.category = source.category;
  if (source.subcategory) filter.subcategory = source.subcategory;
  if (Array.isArray(source.productIds) && source.productIds.length) {
    if (source.productIds.some((id) => !mongoose.isValidObjectId(id))) throw routeError(422, 'productIds contains an invalid product id.');
    filter._id = { $in: source.productIds };
  }
  return filter;
}
function changedRate(oldRate, changeType, changeValue) {
  if (!CHANGE_TYPES.has(changeType)) throw routeError(422, 'Unsupported changeType.');
  const value = Number(changeValue);
  if (!Number.isFinite(value) || value < 0) throw routeError(422, 'changeValue must be a non-negative finite number.');
  if (changeType === 'increase_percent') return roundMoney(oldRate * (1 + value / 100));
  if (changeType === 'decrease_percent') return roundMoney(Math.max(0, oldRate * (1 - value / 100)));
  if (changeType === 'increase_flat') return roundMoney(oldRate + value);
  if (changeType === 'decrease_flat') return roundMoney(Math.max(0, oldRate - value));
  return roundMoney(value);
}
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
async function historyEntry({ branch, pricing, schedule, action, target, product, before, after, reason, notes, user, session }) {
  const data = {
    branch, pricing, schedule, action, scope: target.scope,
    dealer: target.scope === 'dealer' ? target.dealer : undefined,
    dealerType: target.scope === 'dealer_type' ? target.dealerType : undefined,
    product, before: before || null, after: after || null,
    reason: reason || '', notes: notes || '', performedBy: user,
  };
  if (session) return DealerPricingHistory.create([data], { session });
  return DealerPricingHistory.create(data);
}
async function previewBulk(branchId, body, session = null) {
  const target = await validateTarget(parseTarget(body), session);
  const quantity = Number(body.quantity ?? 1);
  if (!Number.isFinite(quantity) || quantity <= 0) throw routeError(422, 'quantity must be greater than zero.');
  const products = await Product.find(productFilter(body)).sort({ itemName: 1 }).limit(5001).session(session).lean();
  if (!products.length) throw routeError(404, 'No active products matched the selected filters.');
  if (products.length > 5000) throw routeError(422, 'Bulk operation matched more than 5000 products; narrow the filters.');
  const rows = await mapWithConcurrency(products, 16, async (product) => {
    const oldPricing = await resolvePricing({
      branchId,
      dealerId: target.scope === 'dealer' ? target.dealer : undefined,
      dealerTypeId: target.scope === 'dealer_type' ? target.dealerType : undefined,
      scope: target.scope,
      product,
      quantity,
      pricingDate: body.pricingDate || new Date(),
      orderAmount: body.orderAmount,
      session,
    });
    const newRate = changedRate(oldPricing.effectiveRate, body.changeType, body.changeValue);
    return {
      product: product._id,
      productCode: product.productCode,
      productName: product.itemName,
      oldRate: oldPricing.effectiveRate,
      newRate,
      difference: roundMoney(newRate - oldPricing.effectiveRate),
      minimumSellingRate: oldPricing.minimumSellingRate,
      belowMinimum: oldPricing.minimumSellingRate > 0 && newRate < oldPricing.minimumSellingRate,
      oldSource: oldPricing.source,
      oldOverrideScope: oldPricing.overrideScope,
    };
  });
  const belowMinimum = rows.filter((row) => row.belowMinimum);
  const summary = {
    matched: rows.length,
    increased: rows.filter((row) => row.difference > 0).length,
    decreased: rows.filter((row) => row.difference < 0).length,
    unchanged: rows.filter((row) => row.difference === 0).length,
    belowMinimum: belowMinimum.length,
    totalOldValue: roundMoney(rows.reduce((sum, row) => sum + row.oldRate, 0)),
    totalNewValue: roundMoney(rows.reduce((sum, row) => sum + row.newRate, 0)),
  };
  if (belowMinimum.length) {
    const error = routeError(422, `${belowMinimum.length} bulk result(s) are below minimum selling rate.`);
    error.details = { rows, summary };
    throw error;
  }
  return { target, products, rows, summary, quantity };
}
function assertExpectedRates(expectedRates, rows) {
  if (!Array.isArray(expectedRates) || !expectedRates.length) return;
  const expectedByProduct = new Map(expectedRates.map((row) => [String(row.product), row]));
  const staleRows = rows.filter((row) => {
    const expected = expectedByProduct.get(String(row.product));
    return !expected
      || roundMoney(expected.oldRate) !== roundMoney(row.oldRate)
      || roundMoney(expected.newRate) !== roundMoney(row.newRate);
  });
  if (staleRows.length || expectedByProduct.size !== rows.length) {
    const error = routeError(409, 'Pricing changed after preview. Review the refreshed old/new rates before applying.');
    error.details = { rows, staleProducts: staleRows.map((row) => row.product) };
    throw error;
  }
}
async function applyPreview({ branchId, preview, body, userId, action, scheduleId, session }) {
  const applied = [];
  for (const row of preview.rows) {
    const filter = targetFilter(branchId, preview.target, row.product);
    let pricing = await DealerPricing.findOne(filter).session(session);
    const before = pricing ? snapshot(pricing) : null;
    if (!pricing) pricing = new DealerPricing({ branch: branchId, product: row.product, createdBy: userId });
    Object.assign(pricing, targetFields(preview.target), {
      customRate: row.newRate,
      discountPercent: 0,
      discountFlat: 0,
      schemeDiscount: 0,
      minQty: 0,
      slabs: [],
      validFrom: body.validFrom || new Date(),
      validTo: body.validTo || null,
      isActive: true,
      remarks: body.notes || body.reason || '',
      updatedBy: userId,
    });
    await pricing.save({ session });
    await historyEntry({
      branch: branchId, pricing: pricing._id, schedule: scheduleId, action,
      target: preview.target, product: row.product, before, after: snapshot(pricing),
      reason: body.reason, notes: body.notes, user: userId, session,
    });
    applied.push(pricing);
  }
  return applied;
}

// GET /api/v1/dealer-pricing
router.get('/', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const { dealer, dealerType, scope, product, page = 1, limit = 50, isActive } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
    const filter = { branch: req.branchId };
    if (scope === 'dealer') filter.$or = [{ scope: 'dealer' }, { scope: { $exists: false } }];
    else if (scope) filter.scope = scope;
    if (dealer) filter.dealer = dealer;
    if (dealerType) filter.dealerType = dealerType;
    if (product) filter.product = product;
    if (isActive !== undefined) filter.isActive = String(isActive) === 'true';
    const [data, total] = await Promise.all([
      DealerPricing.find(filter).sort({ updatedAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('product', 'productCode itemName tileSize finish unit dealerRate wholesaleRate retailRate distributorRate builderRate projectRate mrp minimumSellingRate')
        .populate('dealer', 'businessName dealerCode dealerType').populate('dealerType', 'name pricingTier').lean(),
      DealerPricing.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/dealer-pricing/effective-rate
router.get('/effective-rate', requireAnyPermission('sales.order.create', 'quotation.management'), async (req, res) => {
  try {
    if (!req.query.product) throw routeError(422, 'product is required.');
    const target = parseTarget(req.query);
    const result = await resolvePricing({
      branchId: req.branchId, product: req.query.product,
      dealerId: target.scope === 'dealer' ? target.dealer : undefined,
      dealerTypeId: target.scope === 'dealer_type' ? target.dealerType : undefined,
      scope: target.scope, quantity: req.query.quantity || 1,
      pricingDate: req.query.date || new Date(), orderAmount: req.query.orderAmount,
    });
    return res.json({ success: true, data: result });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/dealer-pricing/catalog
router.get('/catalog', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const target = await validateTarget(parseTarget(req.query));
    const p = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const l = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const quantity = Number(req.query.quantity || 1);
    if (!Number.isFinite(quantity) || quantity <= 0) throw routeError(422, 'quantity must be greater than zero.');
    const filter = productFilter(req.query);
    const [products, total] = await Promise.all([
      Product.find(filter).sort({ itemName: 1 }).skip((p - 1) * l).limit(l)
        .populate('brand', 'name status').populate('category', 'name status').populate('subcategory', 'name status').lean(),
      Product.countDocuments(filter),
    ]);
    const data = await mapWithConcurrency(products, 16, async (product) => {
      const [result, targetOverride] = await Promise.all([
        resolvePricing({
          branchId: req.branchId,
          dealerId: target.scope === 'dealer' ? target.dealer : undefined,
          dealerTypeId: target.scope === 'dealer_type' ? target.dealerType : undefined,
          scope: target.scope, product, quantity,
        }),
        DealerPricing.findOne(targetFilter(req.branchId, target, product._id)).lean(),
      ]);
      return {
        ...product,
        tierRates: Object.fromEntries([...TIER_FIELDS, 'mrp'].map((field) => [field, product[field] ?? 0])),
        baseTier: result.requestedTier,
        rateField: result.rateField,
        baseRate: result.baseRate,
        applicableOverride: result.applicableOverride || null,
        targetOverride: targetOverride || null,
        finalEffectiveRate: result.effectiveRate,
        minimumSellingRate: result.minimumSellingRate,
        minimumWarning: result.belowMinimum ? `Effective rate ${result.effectiveRate} is below minimum ${result.minimumSellingRate}.` : null,
        source: result.source,
        sourceName: result.sourceName,
        overrideScope: result.overrideScope,
      };
    });
    return res.json({
      success: true, data, target: { scope: target.scope, dealer: target.dealerDoc || null, dealerType: target.dealerTypeDoc || null },
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { return sendError(res, error); }
});

router.post('/preview-bulk', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const preview = await previewBulk(req.branchId, req.body || {});
    return res.json({ success: true, data: { rows: preview.rows, summary: preview.summary } });
  } catch (error) {
    if (error.details) return res.status(error.status || 422).json({ success: false, message: error.message, data: error.details });
    return sendError(res, error);
  }
});

router.post('/apply-bulk', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const body = req.body || {};
    let preview = await previewBulk(req.branchId, body);
    if (!Array.isArray(body.expectedRates) || !body.expectedRates.length) {
      throw routeError(422, 'Preview confirmation is required before applying or scheduling a bulk pricing change.');
    }
    assertExpectedRates(body.expectedRates, preview.rows);
    if (body.applyImmediately === false) {
      const applyAt = new Date(body.applyAt);
      if (Number.isNaN(applyAt.getTime()) || applyAt <= new Date()) throw routeError(422, 'A future applyAt is required when applyImmediately is false.');
      const schedule = await DealerPricingSchedule.create({
        branch: req.branchId, ...targetFields(preview.target), scope: preview.target.scope,
        products: preview.rows.map((row) => row.product),
        expectedRates: preview.rows.map((row) => ({ product: row.product, oldRate: row.oldRate, newRate: row.newRate })),
        filters: { search: body.search, brand: body.brand, category: body.category, subcategory: body.subcategory },
        changeType: body.changeType, changeValue: body.changeValue, quantity: preview.quantity,
        validFrom: body.validFrom || applyAt, validTo: body.validTo || null,
        applyAt, reason: body.reason || '', notes: body.notes || '', createdBy: req.user._id,
      });
      return res.status(201).json({ success: true, message: 'Pricing change scheduled.', data: { schedule, preview: { rows: preview.rows, summary: preview.summary } } });
    }
    const session = await mongoose.startSession();
    let applied;
    try {
      await session.withTransaction(async () => {
        preview = await previewBulk(req.branchId, body, session);
        assertExpectedRates(body.expectedRates, preview.rows);
        applied = await applyPreview({
          branchId: req.branchId, preview, body, userId: req.user._id,
          action: 'bulk', session,
        });
      });
    } finally { await session.endSession(); }
    return res.json({ success: true, message: `${applied.length} pricing override(s) applied.`, data: { rows: preview.rows, summary: preview.summary } });
  } catch (error) {
    if (error.details) return res.status(error.status || 422).json({ success: false, message: error.message, data: error.details });
    return sendError(res, error);
  }
});

router.get('/history', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const p = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const l = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const filter = { branch: req.branchId };
    if (req.query.scope) filter.scope = req.query.scope;
    if (req.query.product) filter.product = req.query.product;
    if (req.query.dealer) filter.dealer = req.query.dealer;
    if (req.query.dealerType) filter.dealerType = req.query.dealerType;
    const [data, total] = await Promise.all([
      DealerPricingHistory.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('product', 'productCode itemName').populate('dealer', 'businessName dealerCode')
        .populate('dealerType', 'name pricingTier').populate('performedBy', 'name').lean(),
      DealerPricingHistory.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (error) { return sendError(res, error); }
});

router.get('/schedules', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const p = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const l = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const filter = { branch: req.branchId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.scope) {
      if (!SCOPES.has(req.query.scope)) throw routeError(422, 'scope must be dealer, dealer_type, or walk_in.');
      filter.scope = req.query.scope;
    }
    if (req.query.dealer) {
      if (!mongoose.isValidObjectId(req.query.dealer)) throw routeError(422, 'dealer is invalid.');
      filter.dealer = req.query.dealer;
    }
    if (req.query.dealerType) {
      if (!mongoose.isValidObjectId(req.query.dealerType)) throw routeError(422, 'dealerType is invalid.');
      filter.dealerType = req.query.dealerType;
    }
    const [data, total] = await Promise.all([
      DealerPricingSchedule.find(filter).sort({ applyAt: 1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode').populate('dealerType', 'name pricingTier')
        .populate('products', 'productCode itemName').populate('createdBy', 'name').lean(),
      DealerPricingSchedule.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (error) { return sendError(res, error); }
});

router.delete('/schedules/:id', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const schedule = await DealerPricingSchedule.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'pending' },
      { $set: { status: 'cancelled', cancelledBy: req.user._id, cancelledAt: new Date() } },
      { new: true, runValidators: true }
    );
    if (!schedule) throw routeError(404, 'Pending schedule not found.');
    return res.json({ success: true, message: 'Pricing schedule cancelled.', data: schedule });
  } catch (error) { return sendError(res, error); }
});

router.post('/apply-due-schedules', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const due = await DealerPricingSchedule.find({ branch: req.branchId, status: 'pending', applyAt: { $lte: new Date() } }).sort({ applyAt: 1 });
    const results = [];
    for (const schedule of due) {
      const body = {
        scope: schedule.scope, dealer: schedule.dealer, dealerType: schedule.dealerType,
        productIds: schedule.products, expectedRates: schedule.expectedRates,
        changeType: schedule.changeType, changeValue: schedule.changeValue,
        quantity: schedule.quantity, validFrom: schedule.validFrom, validTo: schedule.validTo,
        reason: schedule.reason, notes: schedule.notes,
      };
      const session = await mongoose.startSession();
      try {
        let count = 0;
        await session.withTransaction(async () => {
          const claimed = await DealerPricingSchedule.findOne({ _id: schedule._id, branch: req.branchId, status: 'pending' }).session(session);
          if (!claimed) throw routeError(409, 'Schedule was already actioned.');
          const preview = await previewBulk(req.branchId, body, session);
          assertExpectedRates(body.expectedRates, preview.rows);
          const applied = await applyPreview({
            branchId: req.branchId, preview, body, userId: req.user._id,
            action: 'scheduled_application', scheduleId: schedule._id, session,
          });
          count = applied.length;
          claimed.status = 'applied'; claimed.appliedBy = req.user._id; claimed.appliedAt = new Date(); claimed.error = '';
          await claimed.save({ session });
        });
        results.push({ schedule: schedule._id, status: 'applied', count });
      } catch (error) {
        await DealerPricingSchedule.updateOne(
          { _id: schedule._id, branch: req.branchId, status: 'pending' },
          { $set: { status: 'failed', error: error.message, appliedBy: req.user._id, appliedAt: new Date() } }
        );
        results.push({ schedule: schedule._id, status: 'failed', error: error.message });
      } finally { await session.endSession(); }
    }
    return res.json({ success: true, message: `${results.length} due schedule(s) processed.`, data: results });
  } catch (error) { return sendError(res, error); }
});

router.post('/', requirePermission('dealer.discounts'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const auditReason = String(req.body.reason || '').trim();
    if (!auditReason) throw routeError(422, 'A fresh audit reason is required.');
    let pricing;
    let before;
    await session.withTransaction(async () => {
      const target = await validateTarget(parseTarget(req.body), session);
      if (!req.body.product || !mongoose.isValidObjectId(req.body.product)) throw routeError(422, 'A valid product is required.');
      const product = await Product.findOne({ _id: req.body.product, status: 'active' }).session(session).lean();
      if (!product) throw routeError(404, 'Active product not found.');
      const filter = targetFilter(req.branchId, target, product._id);
      pricing = await DealerPricing.findOne(filter).session(session);
      before = pricing ? snapshot(pricing) : null;
      if (!pricing) pricing = new DealerPricing({ branch: req.branchId, product: product._id, createdBy: req.user._id });
      const editable = ['customRate', 'discountPercent', 'discountFlat', 'schemeDiscount', 'minQty', 'slabs', 'validFrom', 'validTo', 'isActive', 'remarks'];
      Object.assign(pricing, Object.fromEntries(editable.filter((key) => Object.hasOwn(req.body, key)).map((key) => [key, req.body[key]])));
      Object.assign(pricing, targetFields(target), {
        productCode: product.productCode, productName: product.itemName, updatedBy: req.user._id,
      });
      await pricing.validate();
      const resolved = await resolvePricing({
        branchId: req.branchId, dealerId: target.scope === 'dealer' ? target.dealer : undefined,
        dealerTypeId: target.scope === 'dealer_type' ? target.dealerType : undefined,
        scope: target.scope, product, quantity: req.body.quantity || Math.max(1, pricing.minQty || 1),
        proposedOverride: pricing.toObject(), session,
      });
      if (resolved.belowMinimum) throw routeError(422, `Effective rate ${resolved.effectiveRate} is below minimum selling rate ${resolved.minimumSellingRate}.`);
      await pricing.save({ session });
      await historyEntry({
        branch: req.branchId, pricing: pricing._id, action: before ? 'update' : 'create', target,
        product: product._id, before, after: snapshot(pricing), reason: auditReason,
        notes: req.body.notes, user: req.user._id, session,
      });
    });
    return res.status(before ? 200 : 201).json({ success: true, message: 'Dealer pricing saved.', data: pricing });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.put('/:id', requirePermission('dealer.discounts'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const auditReason = String(req.body.reason || '').trim();
    if (!auditReason) throw routeError(422, 'A fresh audit reason is required.');
    let pricing;
    await session.withTransaction(async () => {
      pricing = await DealerPricing.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!pricing) throw routeError(404, 'Pricing override not found.');
      const before = snapshot(pricing);
      const currentTarget = parseTarget({
        scope: req.body.scope ?? pricing.scope ?? 'dealer',
        dealer: req.body.dealer ?? pricing.dealer ?? pricing.customerId,
        dealerType: req.body.dealerType ?? pricing.dealerType,
      });
      const target = await validateTarget(currentTarget, session);
      const productId = req.body.product || pricing.product;
      const product = await Product.findOne({ _id: productId, status: 'active' }).session(session).lean();
      if (!product) throw routeError(404, 'Active product not found.');
      const editable = ['customRate', 'discountPercent', 'discountFlat', 'schemeDiscount', 'minQty', 'slabs', 'validFrom', 'validTo', 'isActive', 'remarks'];
      Object.assign(pricing, Object.fromEntries(editable.filter((key) => Object.hasOwn(req.body, key)).map((key) => [key, req.body[key]])));
      Object.assign(pricing, targetFields(target), { product: product._id, productCode: product.productCode, productName: product.itemName, updatedBy: req.user._id });
      await pricing.validate();
      if (pricing.isActive) {
        const resolved = await resolvePricing({
          branchId: req.branchId, dealerId: target.scope === 'dealer' ? target.dealer : undefined,
          dealerTypeId: target.scope === 'dealer_type' ? target.dealerType : undefined,
          scope: target.scope, product, quantity: req.body.quantity || Math.max(1, pricing.minQty || 1),
          proposedOverride: pricing.toObject(), session,
        });
        if (resolved.belowMinimum) throw routeError(422, `Effective rate ${resolved.effectiveRate} is below minimum selling rate ${resolved.minimumSellingRate}.`);
      }
      await pricing.save({ session });
      const action = Object.hasOwn(req.body, 'isActive') && Object.keys(req.body).every((key) => ['isActive', 'reason', 'notes'].includes(key)) ? 'toggle' : 'update';
      await historyEntry({ branch: req.branchId, pricing: pricing._id, action, target, product: product._id, before, after: snapshot(pricing), reason: auditReason, notes: req.body.notes, user: req.user._id, session });
    });
    return res.json({ success: true, message: 'Pricing override updated.', data: pricing });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.delete('/:id', requirePermission('dealer.discounts'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let pricing;
    await session.withTransaction(async () => {
      pricing = await DealerPricing.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!pricing) throw routeError(404, 'Pricing override not found.');
      const before = snapshot(pricing);
      pricing.isActive = false; pricing.updatedBy = req.user._id;
      await pricing.save({ session });
      const target = parseTarget({ scope: pricing.scope || 'dealer', dealer: pricing.dealer || pricing.customerId, dealerType: pricing.dealerType });
      await historyEntry({ branch: req.branchId, pricing: pricing._id, action: 'toggle', target, product: pricing.product, before, after: snapshot(pricing), reason: req.body?.reason || 'Deactivated', notes: req.body?.notes, user: req.user._id, session });
    });
    return res.json({ success: true, message: 'Pricing override deactivated.', data: pricing });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.get('/bulk-by-dealer/:dealerId', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const target = await validateTarget({ scope: 'dealer', dealer: req.params.dealerId });
    const overrides = await DealerPricing.find({ branch: req.branchId, dealer: target.dealer, isActive: true })
      .populate('product', 'productCode itemName tileSize finish unit dealerRate mrp minimumSellingRate').lean();
    return res.json({ success: true, data: overrides });
  } catch (error) { return sendError(res, error); }
});

export default router;
