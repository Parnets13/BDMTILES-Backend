import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../../models/Product.js';
import Stock from '../../models/Stock.js';
import Category from '../../models/Category.js';
import Brand from '../../models/Brand.js';
// Still needed to resolve subcategory ids on products written before the migration;
// the tree is authoritative for anything created after it.
import Subcategory from '../../models/Subcategory.js';
import { descendantIds, slugify } from '../../services/categoryTreeService.js';
import { buildAttributeFilter, filterableOptionsForCategory } from '../../services/attributeService.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';
import { upload } from '../../middleware/upload.js';
// imageEmbedding service is optional (requires onnxruntime-node package)
let generateEmbedding = null, findSimilarProducts = null;
try {
  const module = await import('../../services/imageEmbedding.js');
  generateEmbedding = module.generateEmbedding;
  findSimilarProducts = module.findSimilarProducts;
} catch (err) {
  console.warn('[shopProductRoutes] imageEmbedding service unavailable:', err.message);
}
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
  // Category-defined specs (size, finish, pack size …). Public by design — this is the
  // product information the customer reads, not internal pricing.
  'attributes',
].join(' ');

const ONLY_ONLINE = { status: 'active', onlineVisible: true };

/**
 * How much of each product the storefront may actually sell.
 *
 * Mirrors the AUTHORITATIVE admin `getStockSummary` / `listStocks` pattern
 * (see services/stockMovementService.js lines 297-397): stock is scoped ONLY to
 * the online branch, then summed across EVERY warehouse, every shade, and
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
    const normalizedIds = productIds.map((id) =>
      (typeof id === 'string' && mongoose.isValidObjectId(id))
        ? new mongoose.Types.ObjectId(id)
        : id,
    );
    // Match the admin stock summary: branch-scoped and summed across every
    // warehouse/shade/batch bucket. `availableQty` already excludes reserved,
    // quoted, blocked, damaged, and otherwise unavailable quantities.
    const rows = await Stock.aggregate([
      {
        $match: {
          branch: branchId,
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
    // The storefront routes on slug and filters on id, so both are exposed alongside
    // the display names.
    categoryId: p.category?._id ? String(p.category._id) : (p.category ? String(p.category) : ''),
    categorySlug: p.category?.slug || '',
    subcategoryId: p.subcategory?._id ? String(p.subcategory._id) : (p.subcategory ? String(p.subcategory) : ''),
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
    // Category-defined attributes. The `specs` block above is the legacy tile shape and
    // stays until the storefront reads `attributes` everywhere; both are exposed so the
    // two can be compared during the transition.
    attributes: p.attributes instanceof Map
      ? Object.fromEntries(p.attributes)
      : (p.attributes || {}),
  };
};

// GET /api/v1/shop/products
// query: page, limit, search, category, categoryName, subcategory, brand, tileSize, finish, tileType, colour, applicationArea, sortBy, order
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const filter = { ...ONLY_ONLINE };

    const { search, category, categoryName, subcategory, brand, tileSize, finish, surface, thickness, tileType, colour, applicationArea, minPrice, maxPrice, minRating, dealOnly } = req.query;
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
    // ── Category ──────────────────────────────────────────────────────────
    // Filtering by a department must include everything beneath it, so a customer
    // browsing "Tiles" also sees products filed under Floor Tiles / Wall Tiles.
    //
    // An unmatched name resolves to `{ $in: [] }` — an empty result. This branch
    // previously left `filter.category` unset when nothing matched, which silently
    // DROPPED the filter and returned the ENTIRE catalogue under the requested
    // category's heading. The subcategory and brand branches below already handled
    // this correctly; category was the odd one out.
    // The distinction that matters: a category filter that was NOT requested leaves the
    // query alone, while one that WAS requested and matched nothing must yield zero
    // results. Conflating the two is the original defect — it silently returned the
    // entire catalogue under the heading of a category that does not exist.
    let categoryIds = null;
    let categoryRequested = false;
    // Only set once a category genuinely resolved. The attribute lookup below walks the
    // ancestor chain and throws 404 for an unknown id, so passing it a dangling id would
    // turn "no such category" into a server error instead of an empty result.
    let attributeScope = null;

    if (category) {
      categoryRequested = true;
      if (mongoose.isValidObjectId(category) && await Category.exists({ _id: category })) {
        categoryIds = await descendantIds(category);
        attributeScope = category;
      } else {
        // A malformed or unknown id is a bad request, not "no filter" — returning the
        // whole catalogue here would be the same silent-drop defect in another guise.
        categoryIds = [];
      }
    } else if (categoryName) {
      categoryRequested = true;
      const catName = String(categoryName).trim();
      let matched = await Category.find({ name: new RegExp(`^${escapeRegex(catName)}$`, 'i'), status: 'active' }).select('_id').lean();
      if (!matched.length) {
        matched = await Category.find({ name: new RegExp(escapeRegex(catName), 'i'), status: 'active' }).select('_id').lean();
      }
      // Storefront URLs are slug-based, so accept a slug too.
      if (!matched.length) {
        matched = await Category.find({ slug: slugify(catName), status: 'active' }).select('_id').lean();
      }
      if (matched.length) {
        const expanded = await Promise.all(matched.map((c) => descendantIds(c._id)));
        categoryIds = [...new Map(expanded.flat().map((id) => [String(id), id])).values()];
        attributeScope = String(matched[0]._id);
      } else {
        categoryIds = [];
      }
    }
    if (categoryRequested) {
      const ids = categoryIds || [];

      // A category id can be stored in EITHER field. The admin form's "Category" is level 1 and
      // lands in `product.category`; its "Subcategory" is level 2 and lands in
      // `product.subcategory`. Filtering only `category` meant every level-2 page —
      // /category/floor-tiles, /category/elevation-tiles — came up empty even when products
      // were filed there, because the ids were in the other field all along.
      const categoryClause = { $or: [{ category: { $in: ids } }, { subcategory: { $in: ids } }] };

      if (filter.$or) {
        // The search above already claimed `$or`, so the two are combined under `$and`
        // rather than one silently overwriting the other.
        filter.$and = [{ $or: filter.$or }, categoryClause];
        delete filter.$or;
      } else {
        filter.$or = categoryClause.$or;
      }
    }

    if (subcategory) {
      if (mongoose.isValidObjectId(subcategory)) {
        filter.subcategory = subcategory;
      } else {
        // Resolve the name against the tree. Scoped to LEVEL 2 because that is what
        // `product.subcategory` holds — the form's "Subcategory" field is the second level, not
        // the third. The previous comment said level 3, which would have matched a node whose id
        // never appears in that field.
        const name = new RegExp(`^${escapeRegex(String(subcategory).trim())}$`, 'i');
        const match = await Category.findOne({ name, status: 'active', level: 2 }).select('_id').lean();
        filter.subcategory = match?._id || { $in: [] };
      }
    }
    if (brand) {
      if (mongoose.isValidObjectId(brand)) filter.brand = brand;
      else {
        const match = await Brand.findOne({name: new RegExp(`^${escapeRegex(String(brand).trim())}$`, 'i'), status: 'active'}).select('_id').lean();
        filter.brand = match?._id || { $in: [] };
      }
    }
    if (tileSize) filter.tileSize = String(tileSize);
    if (finish) filter.finish = String(finish);
    if (surface) filter.surface = String(surface);
    if (thickness) filter.thickness = String(thickness);
    if (tileType) filter.tileType = String(tileType);
    if (colour) filter.colour = new RegExp(`^${String(colour)}$`, 'i');
    if (applicationArea) filter.applicationArea = new RegExp(String(applicationArea), 'i');

    // ── Category-defined attributes ───────────────────────────────────────
    // `?attr.finish=Matt` or `?attr.finish=Matt,Glossy`. Keys are validated against the
    // category's own definitions, so a stale bookmarked filter URL degrades to "no
    // filter" instead of erroring. Scoped to the requested category, because the same
    // key can mean different things in different departments.
    // Category-defined attributes. Scoped to the requested category, falling back to the
    // subcategory so filtering inside one still honours its own definitions. Only a
    // scope that genuinely resolved is used — the attribute lookup throws on a dangling
    // id, which would surface as a 404 instead of an empty product list.
    let attributeFilterScope = attributeScope;
    if (!attributeFilterScope && subcategory && mongoose.isValidObjectId(subcategory)
        && await Category.exists({ _id: subcategory })) {
      attributeFilterScope = subcategory;
    }
    if (attributeFilterScope) {
      Object.assign(filter, await buildAttributeFilter(attributeFilterScope, req.query));
    }

    if (Number.isFinite(Number(minRating)) && Number(minRating) > 0) filter.rating = { $gte: Number(minRating) };
    if (dealOnly === 'true') filter.isDealOfWeek = true;
    const priceConditions = [];
    const effectivePrice = { $cond: [{ $gt: [{ $ifNull: ['$mrp', 0] }, 0] }, '$mrp', '$retailRate'] };
    if (Number.isFinite(Number(minPrice)) && Number(minPrice) >= 0) priceConditions.push({ $gte: [effectivePrice, Number(minPrice)] });
    if (Number.isFinite(Number(maxPrice)) && Number(maxPrice) >= 0) priceConditions.push({ $lte: [effectivePrice, Number(maxPrice)] });
    if (priceConditions.length) filter.$expr = { $and: priceConditions };

    const sortField = ['itemName', 'retailRate', 'mrp', 'createdAt', 'rating'].includes(req.query.sortBy) ? req.query.sortBy : 'createdAt';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    const [items, totalItems] = await Promise.all([
      Product.find(filter)
        .select(PUBLIC_PRODUCT_FIELDS)
        .populate('brand', 'name')
        .populate('category', 'name slug')
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
      .populate('brand', 'name').populate('category', 'name slug').populate('subcategory', 'name')
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
      .populate('brand', 'name').populate('category', 'name slug').populate('subcategory', 'name')
      .sort({ updatedAt: -1 }).limit(10).lean();
    res.json({ success: true, data: await withAvailability(items.map(toPublic)) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/filter-options — distinct values for storefront filters (online products only)
//
// Returns the legacy tile-shaped arrays (kept so the current filter rail keeps working)
// alongside two additions:
//   `departments` — the level-1 taxonomy nodes, with slugs, for storefront navigation
//   `attributes`  — the category-defined filters, only when `?category=` is supplied
// The attribute list is what replaces the hardcoded tile fields for the other verticals.
router.get('/filter-options', async (req, res) => {
  try {
    const [sizes, finishes, surfaces, thicknesses, types, colours, areas, brandIds, subcategoryIds, categoryIds] = await Promise.all([
      Product.distinct('tileSize', ONLY_ONLINE),
      Product.distinct('finish', ONLY_ONLINE),
      Product.distinct('surface', ONLY_ONLINE),
      Product.distinct('thickness', ONLY_ONLINE),
      Product.distinct('tileType', ONLY_ONLINE),
      Product.distinct('colour', ONLY_ONLINE),
      Product.distinct('applicationArea', ONLY_ONLINE),
      Product.distinct('brand', ONLY_ONLINE),
      Product.distinct('subcategory', ONLY_ONLINE),
      Product.distinct('category', ONLY_ONLINE),
    ]);
    const clean = (arr) => arr.filter((v) => v && String(v).trim()).sort();

    const [brands, subcategories, categories, departments] = await Promise.all([
      Brand.find({ _id: { $in: brandIds }, status: 'active' }).select('_id name image').sort({ name: 1 }).lean(),
      // Subcategories resolve against BOTH collections during the transition: products
      // written before the migration still reference the deprecated Subcategory docs,
      // while anything written after points at a level-3 Category. Querying only one
      // would make the filter rail empty for whichever half had not been migrated yet.
      Promise.all([
        Category.find({ _id: { $in: subcategoryIds }, status: 'active' }).select('_id name').lean(),
        Subcategory.find({ _id: { $in: subcategoryIds }, status: 'active' }).select('_id name').lean(),
      ]).then(([fromTree, legacy]) => {
        const merged = new Map();
        for (const row of [...fromTree, ...legacy]) merged.set(String(row._id), row);
        return [...merged.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }),
      Category.find({ _id: { $in: categoryIds }, status: 'active' }).select('_id name slug').sort({ name: 1 }).lean(),
      // Departments are listed regardless of whether products sit directly on them, so a
      // newly created department appears in navigation before its first product exists.
      Category.find({ level: 1, status: 'active' })
        .select('_id name slug image badge sortOrder')
        .sort({ sortOrder: 1, name: 1 })
        .lean(),
    ]);

    // Category-defined filters, scoped to the requested category.
    let attributes = [];
    if (req.query.category && mongoose.isValidObjectId(req.query.category)) {
      attributes = await filterableOptionsForCategory(req.query.category);
    }

    return res.json({
      success: true,
      data: {
        tileSizes: clean(sizes),
        finishes: clean(finishes),
        surfaces: clean(surfaces),
        thicknesses: clean(thicknesses),
        tileTypes: clean(types),
        colours: clean(colours),
        applicationAreas: clean(areas),
        brands: brands.map((brand) => ({ id: String(brand._id), name: brand.name, image: brand.image || '' })),
        subcategories: subcategories.map((subcategory) => ({ id: String(subcategory._id), name: subcategory.name })),
        categories: categories.map((category) => ({ id: String(category._id), name: category.name, slug: category.slug || '' })),
        departments: departments.map((d) => ({
          id: String(d._id), name: d.name, slug: d.slug || '',
          image: d.image || '', badge: d.badge || '',
        })),
        attributes,
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
      .populate('category', 'name slug')
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
      .populate('category', 'name slug')
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
