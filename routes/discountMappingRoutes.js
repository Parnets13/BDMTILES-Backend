import { Router } from 'express';
import DiscountMapping from '../models/DiscountMapping.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

// ══════════════════════════════════════════════════════
// GET /api/v1/discount-mappings — list all rules (paginated + filters)
// ══════════════════════════════════════════════════════
router.get('/', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const { page = 1, limit = 50, targetType, status, search, dealerType, mappingType = 'sales' } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 50);

    const filter = { branch: req.branchId };
    // Default to sales so the existing dealer/builder tab keeps its behavior;
    // 'all' explicitly opts out of the mappingType filter.
    if (mappingType && mappingType !== 'all') filter.mappingType = mappingType;
    if (targetType) filter.targetType = targetType;
    if (status) filter.status = status;
    if (dealerType) {
      filter.$or = [{ applicableTo: 'all' }, { applicableDealerTypes: dealerType }];
    }
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [
        ...(filter.$or || []),
        { ruleName: regex },
        { ruleCode: regex },
        { targetName: regex },
      ];
      if (!dealerType) delete filter.$or; // rebuild if no dealerType
      if (search && !dealerType) {
        filter.$or = [{ ruleName: regex }, { ruleCode: regex }, { targetName: regex }];
      }
    }

    const [rules, total] = await Promise.all([
      DiscountMapping.find(filter)
        .sort({ priority: -1, createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .populate('product', 'itemName productCode')
        .populate('brand', 'name')
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .populate('suppliers', 'companyName supplierCode')
        .populate('createdBy', 'name')
        .lean(),
      DiscountMapping.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: rules,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// GET /api/v1/discount-mappings/stats — summary counts
// ══════════════════════════════════════════════════════
router.get('/stats', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const now = new Date();
    const { mappingType = 'sales' } = req.query;
    const scope = { branch: req.branchId, ...(mappingType && mappingType !== 'all' ? { mappingType } : {}) };
    const [total, active, inactive, expired, byType] = await Promise.all([
      DiscountMapping.countDocuments(scope),
      DiscountMapping.countDocuments({ ...scope, status: 'active', validFrom: { $lte: now }, validTo: { $gte: now } }),
      DiscountMapping.countDocuments({ ...scope, status: 'inactive' }),
      DiscountMapping.countDocuments({ ...scope, $or: [{ status: 'expired' }, { validTo: { $lt: now } }] }),
      DiscountMapping.aggregate([
        { $match: { ...scope, status: 'active' } },
        { $group: { _id: '$targetType', count: { $sum: 1 } } },
      ]),
    ]);
    const typeMap = {};
    byType.forEach(t => { typeMap[t._id] = t.count; });

    res.json({
      success: true,
      data: { total, active, inactive, expired, byTargetType: typeMap },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// GET /api/v1/discount-mappings/calculate — resolve discount for product + dealerType
// Called by frontend when adding products to Quotation/SO
// Query: ?product=<id>&dealerType=<type>&rate=<number>&quantity=<number>
// ══════════════════════════════════════════════════════
router.get('/calculate', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { product: productId, dealerType = 'dealer', rate, quantity = 1 } = req.query;
    if (!productId) return res.status(400).json({ success: false, message: 'product is required' });

    const productDoc = await Product.findById(productId)
      .select('_id brand category subcategory itemName productCode')
      .lean();
    if (!productDoc) return res.status(404).json({ success: false, message: 'Product not found' });

    const rule = await DiscountMapping.findBestDiscount(productDoc, dealerType, req.branchId);

    if (!rule) {
      return res.json({
        success: true,
        data: {
          hasDiscount: false,
          discountAmount: 0,
          discountPercentage: 0,
          effectiveRate: parseFloat(rate) || 0,
          rule: null,
        },
      });
    }

    // Calculate discount
    const baseRate = parseFloat(rate) || 0;
    const qty = parseInt(quantity) || 1;

    // Check min order constraints
    if (rule.minOrderQty > 0 && qty < rule.minOrderQty) {
      return res.json({
        success: true,
        data: {
          hasDiscount: false,
          discountAmount: 0,
          discountPercentage: 0,
          effectiveRate: baseRate,
          rule: { ...rule, reason: `Min qty ${rule.minOrderQty} not met` },
        },
      });
    }

    const baseAmount = baseRate * qty;
    let discountAmt = 0;

    if (rule.discountType === 'slab') {
      // Find matching slab
      const slab = (rule.slabs || [])
        .sort((a, b) => b.minQty - a.minQty)
        .find(s => qty >= s.minQty && (s.maxQty === 0 || qty <= s.maxQty));
      if (slab) {
        if (slab.discountPercentage > 0) discountAmt += (baseAmount * slab.discountPercentage) / 100;
        if (slab.discountFlat > 0) discountAmt += slab.discountFlat * qty;
      }
    } else {
      if (rule.discountType === 'percentage' || rule.discountType === 'both') {
        discountAmt += (baseAmount * rule.discountPercentage) / 100;
      }
      if (rule.discountType === 'flat' || rule.discountType === 'both') {
        discountAmt += rule.discountFlat * qty;
      }
    }

    // Cap at maxDiscountPercentage
    const maxAmt = (baseAmount * rule.maxDiscountPercentage) / 100;
    discountAmt = Math.min(discountAmt, maxAmt);

    const perUnitDiscount = qty > 0 ? discountAmt / qty : 0;
    const effectiveRate = Math.max(0, baseRate - perUnitDiscount);

    res.json({
      success: true,
      data: {
        hasDiscount: true,
        discountAmount: Math.round(discountAmt * 100) / 100,
        discountPerUnit: Math.round(perUnitDiscount * 100) / 100,
        discountPercentage: baseAmount > 0 ? Math.round((discountAmt / baseAmount) * 10000) / 100 : 0,
        effectiveRate: Math.round(effectiveRate * 100) / 100,
        rule: {
          _id: rule._id,
          ruleName: rule.ruleName,
          targetType: rule.targetType,
          targetName: rule.targetName,
          discountType: rule.discountType,
          discountPercentage: rule.discountPercentage,
          discountFlat: rule.discountFlat,
          maxDiscountPercentage: rule.maxDiscountPercentage,
        },
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// POST /api/v1/discount-mappings/bulk-calculate — resolve for multiple products at once
// Body: { products: [{ productId, rate, quantity }], dealerType }
// ══════════════════════════════════════════════════════
router.post('/bulk-calculate', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { products: productItems, dealerType = 'dealer' } = req.body;
    if (!productItems?.length) return res.json({ success: true, data: {} });

    const productIds = productItems.map(p => p.productId);
    const productDocs = await Product.find({ _id: { $in: productIds } })
      .select('_id brand category subcategory')
      .lean();

    const discountMap = await DiscountMapping.bulkResolveDiscounts(productDocs, dealerType, req.branchId);

    const results = {};
    for (const item of productItems) {
      const rule = discountMap[item.productId];
      if (!rule) {
        results[item.productId] = { hasDiscount: false, discountAmount: 0, discountPercentage: 0, effectiveRate: item.rate || 0 };
        continue;
      }

      const baseRate = parseFloat(item.rate) || 0;
      const qty = parseInt(item.quantity) || 1;
      const baseAmount = baseRate * qty;
      let discountAmt = 0;

      if (rule.discountType === 'percentage' || rule.discountType === 'both') {
        discountAmt += (baseAmount * rule.discountPercentage) / 100;
      }
      if (rule.discountType === 'flat' || rule.discountType === 'both') {
        discountAmt += rule.discountFlat * qty;
      }
      const maxAmt = (baseAmount * rule.maxDiscountPercentage) / 100;
      discountAmt = Math.min(discountAmt, maxAmt);
      const perUnitDiscount = qty > 0 ? discountAmt / qty : 0;

      results[item.productId] = {
        hasDiscount: true,
        discountAmount: Math.round(discountAmt * 100) / 100,
        discountPerUnit: Math.round(perUnitDiscount * 100) / 100,
        discountPercentage: baseAmount > 0 ? Math.round((discountAmt / baseAmount) * 10000) / 100 : 0,
        effectiveRate: Math.round(Math.max(0, baseRate - perUnitDiscount) * 100) / 100,
        rule: { _id: rule._id, ruleName: rule.ruleName, targetType: rule.targetType, targetName: rule.targetName },
      };
    }

    res.json({ success: true, data: results });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// GET /api/v1/discount-mappings/calculate-purchase — resolve supplier (purchase) discount
// Query: ?product=<id>&supplier=<id>&rate=<number>
// Returns the mapped supplier discount as the expected baseline; the buyer may
// accept MORE (up to floatingDiscountMax) but not less than floatingDiscountMin.
// ══════════════════════════════════════════════════════
router.get('/calculate-purchase', requirePermission('po.management'), async (req, res) => {
  try {
    const { product: productId, supplier: supplierId, rate } = req.query;
    if (!productId) return res.status(400).json({ success: false, message: 'product is required' });

    const productDoc = await Product.findById(productId)
      .select('_id brand category subcategory itemName productCode')
      .lean();
    if (!productDoc) return res.status(404).json({ success: false, message: 'Product not found' });

    const rule = await DiscountMapping.findBestPurchaseDiscount(productDoc, supplierId, req.branchId);
    const baseRate = parseFloat(rate) || 0;

    if (!rule) {
      return res.json({
        success: true,
        data: { hasDiscount: false, discountPercentage: 0, effectiveRate: baseRate, rule: null },
      });
    }

    const direct = Number(rule.directDiscountPercentage || 0);
    const floatingEnabled = Boolean(rule.floatingDiscountEnabled);
    const minPct = floatingEnabled ? Number(rule.floatingDiscountMin || 0) : direct;
    const maxPct = floatingEnabled ? Number(rule.floatingDiscountMax || direct) : direct;
    const effectiveRate = Math.round(Math.max(0, baseRate - (baseRate * direct) / 100) * 100) / 100;

    res.json({
      success: true,
      data: {
        hasDiscount: direct > 0 || floatingEnabled,
        discountPercentage: direct,
        // Buyer bounds: never below min, may go up to max (more discount is better when buying).
        floatingEnabled,
        minDiscountPercentage: minPct,
        maxDiscountPercentage: maxPct,
        effectiveRate,
        rule: {
          _id: rule._id,
          ruleName: rule.ruleName,
          targetType: rule.targetType,
          targetName: rule.targetName,
          directDiscountPercentage: direct,
          floatingDiscountMin: rule.floatingDiscountMin,
          floatingDiscountMax: rule.floatingDiscountMax,
        },
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// GET /api/v1/discount-mappings/:id — get single rule
// ══════════════════════════════════════════════════════
router.get('/:id', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const rule = await DiscountMapping.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('product', 'itemName productCode')
      .populate('brand', 'name')
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .populate('suppliers', 'companyName supplierCode')
      .populate('createdBy', 'name')
      .lean();
    if (!rule) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rule });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// POST /api/v1/discount-mappings — create new rule
// ══════════════════════════════════════════════════════
router.post('/', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const data = { ...req.body, branch: req.branchId, createdBy: req.user._id };

    // Auto-generate ruleCode if not provided
    if (!data.ruleCode) {
      data.ruleCode = await generateBranchNumber(req.branchId, 'discountMapping', data.validFrom || new Date());
    }

    // Resolve targetName for display
    if (data.targetType === 'product' && data.product) {
      const p = await Product.findById(data.product).select('itemName productCode').lean();
      if (p) data.targetName = `${p.itemName} (${p.productCode})`;
    } else if (data.targetType === 'brand' && data.brand) {
      const Brand = (await import('../models/Brand.js')).default;
      const b = await Brand.findById(data.brand).select('name').lean();
      if (b) data.targetName = b.name;
    } else if (data.targetType === 'category' && data.category) {
      const Category = (await import('../models/Category.js')).default;
      const c = await Category.findById(data.category).select('name').lean();
      if (c) data.targetName = c.name;
    } else if (data.targetType === 'subcategory' && data.subcategory) {
      const Subcategory = (await import('../models/Subcategory.js')).default;
      const s = await Subcategory.findById(data.subcategory).select('name').lean();
      if (s) data.targetName = s.name;
    }

    const rule = await DiscountMapping.create(data);
    res.status(201).json({ success: true, message: `Discount rule "${rule.ruleName}" created.`, data: rule });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Rule code already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════
// PUT /api/v1/discount-mappings/:id — update rule
// ══════════════════════════════════════════════════════
router.put('/:id', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const { branch, ...updates } = req.body;
    const rule = await DiscountMapping.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId },
      updates,
      { new: true, runValidators: true }
    );
    if (!rule) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Discount rule updated.', data: rule });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// PATCH /api/v1/discount-mappings/:id/status — toggle active/inactive
// ══════════════════════════════════════════════════════
router.patch('/:id/status', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive', 'expired'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const rule = await DiscountMapping.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId },
      { status },
      { new: true }
    );
    if (!rule) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: `Rule status changed to "${status}".`, data: rule });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════
// DELETE /api/v1/discount-mappings/:id — delete rule
// ══════════════════════════════════════════════════════
router.delete('/:id', requirePermission('dealer.discounts'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(DiscountMapping, req.params.id, {
      user: req.user,
      module: 'discount_mapping',
      titleField: 'ruleName',
      codeField: 'ruleCode',
      skipDependencyCheck: true,
      scope: { branch: req.branchId },
    });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
