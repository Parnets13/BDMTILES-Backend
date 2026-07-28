import { Router } from 'express';
import DealerPricing from '../models/DealerPricing.js';
import Product from '../models/Product.js';
import Dealer from '../models/Dealer.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/dealer-pricing?dealer=id — get all overrides for a dealer
router.get('/', requirePermission('product.master'), async (req, res) => {
  try {
    const { dealer, product, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 50);
    let filter = {};
    if (dealer) filter.dealer = dealer;
    if (product) filter.product = product;

    const [pricings, total] = await Promise.all([
      DealerPricing.find(filter)
        .sort({ updatedAt: -1 })
        .skip((p - 1) * l).limit(l)
        .populate('product', 'productCode itemName tileSize finish brand dealerRate mrp minimumSellingRate unit')
        .populate('dealer', 'businessName dealerCode')
        .lean(),
      DealerPricing.countDocuments(filter),
    ]);

    res.json({ success: true, data: pricings, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dealer-pricing/effective-rate?dealer=id&product=id — get effective rate for checkout
router.get('/effective-rate', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { dealer, product } = req.query;
    if (!dealer || !product) return res.status(400).json({ success: false, message: 'dealer and product required' });

    const [pricing, prod] = await Promise.all([
      DealerPricing.findOne({ dealer, product, isActive: true }).lean(),
      Product.findById(product).lean(),
    ]);

    if (!prod) return res.status(404).json({ success: false, message: 'Product not found' });

    let effectiveRate = prod.dealerRate || prod.mrp || 0;

    if (pricing) {
      if (pricing.customRate != null) {
        effectiveRate = pricing.customRate;
      } else {
        if (pricing.discountPercent > 0) {
          effectiveRate = effectiveRate * (1 - pricing.discountPercent / 100);
        }
        if (pricing.discountFlat > 0) {
          effectiveRate = Math.max(0, effectiveRate - pricing.discountFlat);
        }
      }
      effectiveRate += pricing.schemeDiscount || 0;
    }

    res.json({
      success: true,
      data: {
        effectiveRate: Math.round(effectiveRate * 100) / 100,
        baseRate: prod.dealerRate || prod.mrp || 0,
        hasOverride: !!pricing,
        pricing: pricing || null,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/dealer-pricing — create or upsert override
router.post('/', requirePermission('product.master'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };

    // Validate effective rate vs minimum
    if (data.customRate != null && data.product) {
      const prod = await Product.findById(data.product).lean();
      if (prod && prod.minimumSellingRate > 0 && data.customRate < prod.minimumSellingRate) {
        return res.status(400).json({
          success: false,
          message: `Custom rate ₹${data.customRate} is below minimum selling rate ₹${prod.minimumSellingRate}`,
        });
      }
    }

    const pricing = await DealerPricing.findOneAndUpdate(
      { dealer: data.dealer, product: data.product },
      data,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true, message: 'Dealer pricing saved.', data: pricing });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Override already exists for this dealer+product' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// PUT /api/v1/dealer-pricing/:id — update
router.put('/:id', requirePermission('product.master'), async (req, res) => {
  try {
    const pricing = await DealerPricing.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pricing) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Updated.', data: pricing });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/v1/dealer-pricing/:id — remove override
router.delete('/:id', requirePermission('product.master'), async (req, res) => {
  try {
    await DealerPricing.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Override removed.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/dealer-pricing/bulk-by-dealer/:dealerId — all products with their effective rates for a dealer
router.get('/bulk-by-dealer/:dealerId', requirePermission('product.master'), async (req, res) => {
  try {
    const overrides = await DealerPricing.find({ dealer: req.params.dealerId, isActive: true })
      .populate('product', 'productCode itemName tileSize finish unit dealerRate mrp minimumSellingRate')
      .lean();
    res.json({ success: true, data: overrides });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
