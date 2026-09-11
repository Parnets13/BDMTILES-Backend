import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../../models/Product.js';
import Stock from '../../models/Stock.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';

const router = Router();

// Only these fields are ever exposed to the public storefront.
// NOTE: cost/dealer/wholesale/distributor/project/builder rates are deliberately omitted.
const PUBLIC_PRODUCT_FIELDS = [
  'itemName', 'aliasName', 'description', 'applications', 'maintenance', 'disclaimer', 'productCode',
  'tileSize', 'thickness', 'finish', 'surface', 'colour', 'design', 'grade', 'collection',
  'tileType', 'applicationArea', 'antiSkidRating', 'waterAbsorption', 'breakingStrength',
  'countryOfOrigin', 'manufacturer',
  'unit', 'piecesPerBox', 'sqftPerBox', 'weightPerBox',
  'mrp', 'retailRate',
  'images', 'videos', 'images360', 'cataloguePdf',
  'isNewArrival', 'isFeatured', 'isDealOfWeek', 'brand', 'category', 'subcategory', 'gst',
].join(' ');

const ONLY_ONLINE = { status: 'active', onlineVisible: true };

// Map a product doc to the customer-facing shape (price = retailRate, fallback mrp).
const toPublic = (p) => {
  const price = Number(p.retailRate) > 0 ? Number(p.retailRate) : Number(p.mrp) || 0;
  return {
    id: p._id,
    code: p.productCode || '',
    name: p.itemName,
    description: p.description || '',
    price,
    mrp: Number(p.mrp) || price,
    gst: Number(p.gst) || 0,
    unit: p.unit || 'Box',
    piecesPerBox: Number(p.piecesPerBox) || 0,
    sqftPerBox: Number(p.sqftPerBox) || 0,
    weightPerBox: Number(p.weightPerBox) || 0,
    images: Array.isArray(p.images) ? p.images.filter(Boolean) : [],
    videos: Array.isArray(p.videos) ? p.videos.filter(Boolean) : [],
    images360: Array.isArray(p.images360) ? p.images360.filter(Boolean) : [],
    cataloguePdf: p.cataloguePdf || '',
    brand: p.brand?.name || '',
    category: p.category?.name || '',
    subcategory: p.subcategory?.name || '',
    isNewArrival: !!p.isNewArrival,
    isFeatured: !!p.isFeatured,
    isDealOfWeek: !!p.isDealOfWeek,
    specs: {
      tileSize: p.tileSize || '',
      thickness: p.thickness || '',
      finish: p.finish || '',
      surface: p.surface || '',
      colour: p.colour || '',
      design: p.design || '',
      grade: p.grade || '',
      collection: p.collection || '',
      tileType: p.tileType || '',
      applicationArea: p.applicationArea || '',
      antiSkidRating: p.antiSkidRating || '',
      waterAbsorption: p.waterAbsorption || '',
      breakingStrength: p.breakingStrength || '',
      countryOfOrigin: p.countryOfOrigin || '',
      manufacturer: p.manufacturer || '',
    },
  };
};

// GET /api/v1/shop/products
// query: page, limit, search, category, subcategory, brand, tileSize, finish, tileType, colour, applicationArea, sortBy, order
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const filter = { ...ONLY_ONLINE };

    const { search, category, subcategory, brand, tileSize, finish, tileType, colour, applicationArea } = req.query;
    if (search) filter.$text = { $search: String(search) };
    if (category && mongoose.isValidObjectId(category)) filter.category = category;
    if (subcategory && mongoose.isValidObjectId(subcategory)) filter.subcategory = subcategory;
    if (brand && mongoose.isValidObjectId(brand)) filter.brand = brand;
    if (tileSize) filter.tileSize = String(tileSize);
    if (finish) filter.finish = String(finish);
    if (tileType) filter.tileType = String(tileType);
    if (colour) filter.colour = new RegExp(`^${String(colour)}$`, 'i');
    if (applicationArea) filter.applicationArea = new RegExp(String(applicationArea), 'i');

    const sortField = ['itemName', 'retailRate', 'mrp', 'createdAt'].includes(req.query.sortBy) ? req.query.sortBy : 'createdAt';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    const [items, totalItems] = await Promise.all([
      Product.find(filter)
        .select(PUBLIC_PRODUCT_FIELDS)
        .populate('brand', 'name')
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .sort({ [sortField]: sortOrder })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items.map(toPublic),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalItems / limit) || 1,
        totalItems,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/products/deals — deals of the week (online + isDealOfWeek:true), max 10
router.get('/deals', async (_req, res) => {
  try {
    const deals = await Product.find({ ...ONLY_ONLINE, isDealOfWeek: true })
      .select(PUBLIC_PRODUCT_FIELDS)
      .populate('brand', 'name').populate('category', 'name').populate('subcategory', 'name')
      .sort({ updatedAt: -1 }).limit(10).lean();
    res.json({ success: true, data: deals.map(toPublic) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/products/new-arrivals — new arrivals (online + isNewArrival:true), max 10
router.get('/new-arrivals', async (_req, res) => {
  try {
    const items = await Product.find({ ...ONLY_ONLINE, isNewArrival: true })
      .select(PUBLIC_PRODUCT_FIELDS)
      .populate('brand', 'name').populate('category', 'name').populate('subcategory', 'name')
      .sort({ updatedAt: -1 }).limit(10).lean();
    res.json({ success: true, data: items.map(toPublic) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/filter-options — distinct values for storefront filters (online products only)
router.get('/filter-options', async (_req, res) => {
  try {
    const [sizes, finishes, types, colours, areas] = await Promise.all([
      Product.distinct('tileSize', ONLY_ONLINE),
      Product.distinct('finish', ONLY_ONLINE),
      Product.distinct('tileType', ONLY_ONLINE),
      Product.distinct('colour', ONLY_ONLINE),
      Product.distinct('applicationArea', ONLY_ONLINE),
    ]);
    const clean = (arr) => arr.filter((v) => v && String(v).trim()).sort();
    return res.json({
      success: true,
      data: {
        tileSizes: clean(sizes),
        finishes: clean(finishes),
        tileTypes: clean(types),
        colours: clean(colours),
        applicationAreas: clean(areas),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/products/:id — single product + availability at the online branch
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }
    const product = await Product.findOne({ _id: req.params.id, ...ONLY_ONLINE })
      .select(PUBLIC_PRODUCT_FIELDS)
      .populate('brand', 'name')
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

    let availableQty = 0;
    try {
      const branchId = await getOnlineBranchId();
      const [agg] = await Stock.aggregate([
        { $match: { branch: branchId, product: product._id } },
        { $group: { _id: '$product', availableQty: { $sum: '$availableQty' } } },
      ]);
      availableQty = agg?.availableQty || 0;
    } catch {
      availableQty = 0; // availability best-effort; never block product view
    }

    return res.json({
      success: true,
      data: { ...toPublic(product), availableQty, inStock: availableQty > 0 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
