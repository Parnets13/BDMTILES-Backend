import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../../models/Product.js';
import Stock from '../../models/Stock.js';
import Warehouse from '../../models/Warehouse.js';
import Category from '../../models/Category.js';
import Brand from '../../models/Brand.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';
import { upload } from '../../middleware/upload.js';
import { generateEmbedding, findSimilarProducts } from '../../services/imageEmbedding.js';
import fs from 'fs/promises';

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
  'isNewArrival', 'isFeatured', 'isDealOfWeek',
  'rating', 'reviewCount',
  'brand', 'category', 'subcategory', 'gst',
].join(' ');

const ONLY_ONLINE = { status: 'active', onlineVisible: true };

/**
 * How much of each product the storefront may actually sell.
 *
 * Mirrors the AUTHORITATIVE admin `getStockSummary` / `listStocks` pattern
 * (see services/stockMovementService.js lines 297-397): stock is scoped ONLY to
 * the online branch, then summed across EVERY active warehouse, every shade, and
 * every batch in that branch.  The old code restricted lookups to a single
 * `Warehouse.findOne({...})` bucket, which silently dropped stock held in any
 * non-default warehouse and made SKUs look out of stock despite the admin panel
 * clearly showing them as available.
 *
 * Returns a Map<productId, availableQtyNumber>.  A missing key means zero.
 * Availability is best-effort: a lookup failure must never hide the catalogue.
 */
const onlineAvailability = async (productIds) => {
  const byProduct = new Map();
  if (!productIds?.length) return byProduct;
  try {
    const branchId = await getOnlineBranchId();
    // Collect active warehouses first, same scope as the admin panel would use
    // for a user logged into this branch — any active warehouse ships online.
    const warehouses = await Warehouse.find({ branch: branchId, status: 'active' })
      .select('_id')
      .lean();
    if (!warehouses.length) return byProduct;
    const warehouseIds = warehouses.map((w) => w._id);
    const normalizedIds = productIds.map((id) =>
      (typeof id === 'string' && mongoose.isValidObjectId(id))
        ? new mongoose.Types.ObjectId(id)
        : id,
    );
    // Matches stockMovementService.getStockSummary aggregate verbatim:
    //   { $match: { branch } } → group + sum the buckets.
    // We additionally narrow to the active warehouses + requested productIds.
    const rows = await Stock.aggregate([
      {
        $match: {
          branch: branchId,
          warehouse: { $in: warehouseIds },
          product: { $in: normalizedIds },
        },
      },
      {
        $group: {
          _id: '$product',
          availableQty: {
            $sum: {
              $max: [0, { $ifNull: ['$availableQty', 0] }],
            },
          },
        },
      },
    ]);
    for (const row of rows) {
      byProduct.set(String(row._id), Math.max(0, Number(row.availableQty || 0)));
    }
  } catch (err) {
    console.error('[shopProductRoutes] onlineAvailability failed:', err.message);
    // Leave the map empty; callers fall back to zero.
  }
  return byProduct;
};

/** Attaches availability to a list of already-mapped public products (keyed on `id`). */
const withAvailability = async (products) => {
  const availability = await onlineAvailability(products.map(p => p.id).filter(Boolean));
  return products.map((product) => {
    const availableQty = availability.get(String(product.id)) || 0;
    return { ...product, availableQty, inStock: availableQty > 0 };
  });
};

// Map a product doc to the customer-facing shape (price = retailRate, fallback mrp).
const toPublic = (p) => {
  // The website sells at MRP, and the order endpoint prices at MRP too, so the
  // figure shown here is the figure charged. retailRate is only a fallback for a
  // product with no MRP set — it must never be the advertised price, because it is
  // the walk-in counter rate and lower than what the site is allowed to quote.
  const price = Number(p.mrp) > 0 ? Number(p.mrp) : Number(p.retailRate) || 0;
  return {
    id: p._id,
    code: p.productCode || '',
    name: p.itemName,
    aliasName: p.aliasName || '',
    description: p.description || '',
    applications: p.applications || '',
    maintenance: p.maintenance || '',
    disclaimer: p.disclaimer || '',
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
    rating: p.rating ?? null,
    reviewCount: Number(p.reviewCount) || 0,
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
// query: page, limit, search, category, categoryName, subcategory, brand, tileSize, finish, tileType, colour, applicationArea, sortBy, order
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const filter = { ...ONLY_ONLINE };

    const { search, category, categoryName, subcategory, brand, tileSize, finish, tileType, colour, applicationArea } = req.query;
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (search) {
      const searchStr = String(search).trim();
      
      // Split search into individual words for better matching
      const searchWords = searchStr.split(/\s+/).filter(w => w.length > 0);
      
      // Create regex patterns for each word
      const wordRegexes = searchWords.map(word => new RegExp(escapeRegex(word), 'i'));
      
      // Also keep the full phrase regex for exact matches
      const fullPhraseRegex = new RegExp(escapeRegex(searchStr), 'i');

      const [matchedBrands, matchedCats] = await Promise.all([
        Brand.find({ name: fullPhraseRegex, status: 'active' }).select('_id').lean().catch(() => []),
        Category.find({ name: fullPhraseRegex, status: 'active' }).select('_id').lean().catch(() => []),
      ]);

      // Build search conditions - match if ANY word appears in ANY field
      const orConditions = [];
      
      // For each word, check all searchable fields
      wordRegexes.forEach(wordRegex => {
        orConditions.push(
          { itemName: wordRegex },
          { aliasName: wordRegex },
          { productCode: wordRegex },
          { description: wordRegex },
          { applications: wordRegex },
          { tileSize: wordRegex },
          { colour: wordRegex },
          { finish: wordRegex },
          { tileType: wordRegex },
          { applicationArea: wordRegex }
        );
      });

      if (matchedBrands.length > 0) {
        orConditions.push({ brand: { $in: matchedBrands.map(b => b._id) } });
      }
      if (matchedCats.length > 0) {
        orConditions.push({ category: { $in: matchedCats.map(c => c._id) } });
      }

      filter.$or = orConditions;
    }
    if (category && mongoose.isValidObjectId(category)) {
      filter.category = category;
    } else if (categoryName) {
      const catName = String(categoryName).trim();
      let matchedCats = await Category.find({ name: new RegExp(`^${escapeRegex(catName)}$`, 'i'), status: 'active' }).select('_id').lean();
      if (matchedCats.length === 0) {
        matchedCats = await Category.find({ name: new RegExp(escapeRegex(catName), 'i'), status: 'active' }).select('_id').lean();
      }
      if (matchedCats.length > 0) {
        filter.category = { $in: matchedCats.map(c => c._id) };
      }
    }
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
      data: await withAvailability(items.map(toPublic)),
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
    res.json({ success: true, data: await withAvailability(deals.map(toPublic)) });
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
    res.json({ success: true, data: await withAvailability(items.map(toPublic)) });
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

    const availabilityById = await onlineAvailability([product._id]);
    const availableQty = availabilityById.get(String(product._id)) || 0;

    return res.json({
      success: true,
      data: { ...toPublic(product), availableQty, inStock: availableQty > 0 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/shop/products/search-by-image — visual product search
// Accepts an uploaded image, generates embedding, finds similar products
router.post('/search-by-image', (req, res, next) => {
  // Use multer as a callback so we can return proper JSON on upload errors
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('[ImageSearch] Upload error:', err.message);
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    // Validate image upload
    if (!req.file) {
      console.error('[ImageSearch] No file received. Content-Type:', req.headers['content-type']);
      console.error('[ImageSearch] Body keys:', Object.keys(req.body || {}));
      return res.status(400).json({ 
        success: false, 
        message: 'No image provided. Send a multipart/form-data request with field name "image".' 
      });
    }

    console.log('[ImageSearch] File received:', req.file.originalname, req.file.size, 'bytes', req.file.mimetype);

    // Generate embedding from uploaded image
    let queryEmbedding;
    try {
      queryEmbedding = await generateEmbedding(req.file.path);
      console.log('[ImageSearch] Generated embedding with', queryEmbedding.length, 'dimensions');
    } catch (embeddingError) {
      console.error('[ImageSearch] Embedding generation failed:', embeddingError);
      // Clean up uploaded file
      try {
        await fs.unlink(req.file.path);
      } catch {}
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to process image. Please try a different image.' 
      });
    }

    // Find products with embeddings (only online visible products)
    const productsWithEmbeddings = await Product.find({
      ...ONLY_ONLINE,
      imageEmbedding: { $exists: true, $ne: null, $not: { $size: 0 } },
    })
      .select('_id imageEmbedding')
      .lean();

    console.log('[ImageSearch] Found', productsWithEmbeddings.length, 'products with embeddings');

    if (productsWithEmbeddings.length === 0) {
      // Clean up uploaded file
      try {
        await fs.unlink(req.file.path);
      } catch {}
      return res.json({
        success: true,
        data: [],
        message: 'No indexed products available for visual search yet.',
        pagination: { currentPage: 1, totalPages: 1, totalItems: 0, itemsPerPage: 20 },
      });
    }

    // Calculate similarity scores
    const similarProducts = findSimilarProducts(
      queryEmbedding,
      productsWithEmbeddings.map(p => ({
        id: String(p._id),
        embedding: p.imageEmbedding,
      })),
      20 // Top 20 results
    );

    console.log('[ImageSearch] Top match similarity:', similarProducts[0]?.similarity || 0);

    // Fetch full product details for top matches
    const productIds = similarProducts.map(p => new mongoose.Types.ObjectId(p.id));
    const products = await Product.find({ _id: { $in: productIds } })
      .select(PUBLIC_PRODUCT_FIELDS)
      .populate('brand', 'name')
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .lean();

    // Create a map for quick lookup and preserve similarity order
    const productMap = new Map(products.map(p => [String(p._id), p]));
    const orderedProducts = similarProducts
      .map(sp => productMap.get(sp.id))
      .filter(p => p); // Filter out any missing products

    // Add availability info
    const results = await withAvailability(orderedProducts.map(toPublic));

    // Clean up uploaded file
    try {
      await fs.unlink(req.file.path);
    } catch (cleanupError) {
      console.warn('[ImageSearch] Failed to cleanup uploaded file:', cleanupError);
    }

    return res.json({
      success: true,
      data: results,
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalItems: results.length,
        itemsPerPage: 20,
      },
    });
  } catch (error) {
    console.error('[ImageSearch] Search failed:', error);
    // Clean up uploaded file on error
    if (req.file?.path) {
      try {
        await fs.unlink(req.file.path);
      } catch {}
    }
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
