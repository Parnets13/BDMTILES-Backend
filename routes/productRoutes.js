import { Router } from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import Product from '../models/Product.js';
import ProductOption from '../models/ProductOption.js';
import Stock from '../models/Stock.js';
import StockMovement from '../models/StockMovement.js';
import Brand from '../models/Brand.js';
import Category from '../models/Category.js';
import Dealer from '../models/Dealer.js';
import Branch from '../models/Branch.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { uploadProductImages, uploadBulkImport } from '../middleware/upload.js';
import { normalizeProductUomConfig } from '../services/stockUomService.js';
import { normalizeAndValidateAttributes } from '../services/attributeService.js';
import { descendantIds } from '../services/categoryTreeService.js';
import { pdfToRows } from '../services/productPdfParser.js';
import { isBdmSheet, convertBdmRows } from '../services/productSheetConverter.js';
import { parseImportFile, importProductRows, IMPORT_FIELDS } from '../services/productImportService.js';
import { uploadProductImportFile } from '../middleware/upload.js';
import { resolvePricing } from '../services/pricingResolver.js';
import { resolveDealerBranch } from '../services/dealerAssignmentService.js';
import {
  MAX_OPTION_LENGTH,
  PRODUCT_OPTION_FIELDS,
  mergedOptions,
  normaliseOptionValue,
  productUsageFilter,
} from '../config/productOptions.js';

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const mrpSaving = (mrp, rate) => {
  const listPrice = money(mrp);
  const yourPrice = rate === null || rate === undefined ? null : money(rate);
  if (!(listPrice > 0) || yourPrice === null || !(yourPrice < listPrice)) {
    return { mrp: listPrice > 0 ? listPrice : null, discountPercent: null, savingPerUnit: null };
  }
  return {
    mrp: listPrice,
    discountPercent: Math.round(((listPrice - yourPrice) / listPrice) * 100),
    savingPerUnit: money(listPrice - yourPrice),
  };
};

// imageEmbedding service is optional (requires onnxruntime-node package)
let generateEmbedding = null;
try {
  const module = await import('../services/imageEmbedding.js');
  generateEmbedding = module.generateEmbedding;
} catch (err) {
  console.warn('[productRoutes] imageEmbedding service unavailable:', err.message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

/**
 * Resolve a stored image path (e.g. "/uploads/products/xxx.jpg"
 * or "uploads/products/xxx.jpg") to an absolute filesystem path.
 */
function resolveImagePath(imagePath) {
  if (!imagePath) return null;
  let clean = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
  if (clean.startsWith('uploads/')) return path.join(__dirname, '..', clean);
  return path.join(UPLOADS_ROOT, clean);
}

/**
 * Fire-and-forget: generate an embedding for the product's first image
 * and save it to the product document.
 * Never throws — errors are logged silently so the main save request
 * is not affected.
 *
 * @param {string} productId  MongoDB ObjectId string
 * @param {string[]} images   Array of image relative paths
 */
async function scheduleEmbedding(productId, images) {
  if (!images || images.length === 0) return;
  // Run in background — do not await
  (async () => {
    try {
      const imagePath = resolveImagePath(images[0]);
      if (!imagePath) return;
      const embedding = await generateEmbedding(imagePath);
      await Product.findByIdAndUpdate(productId, {
        imageEmbedding: embedding,
        imageEmbeddingVersion: 1,
        imageEmbeddingUpdatedAt: new Date(),
      });
      console.log(`[ImageEmbedding] ✅ Indexed product ${productId} (${embedding.length}d)`);
    } catch (err) {
      console.error(`[ImageEmbedding] ❌ Failed for product ${productId}:`, err.message);
    }
  })();
}

const router = Router();
router.use(protect);
// Reading the catalogue is allowed for anyone with the blanket grant or any single
// write grant. Without this, an account given only `products.update` could not
// reach the routes it is supposed to be able to use.
router.use(requireAnyPermission('product.master', 'products.create', 'products.update', 'products.delete'));

// `product.master` is an alias for all three write permissions (see
// config/permissions.js), so existing accounts holding only the blanket grant keep
// working while a granular-only account is now genuinely limited to its own verbs.
const canCreateProduct = requirePermission('products.create');
const canUpdateProduct = requirePermission('products.update');
const canDeleteProduct = requirePermission('products.delete');
// Uploading an image happens both when adding a product and when editing one.
const canUploadProductImage = requireAnyPermission('products.create', 'products.update');

// POST /api/v1/products/upload-images — upload product images
router.post('/upload-images', canUploadProductImage, (req, res) => {
  uploadProductImages(req, res, (err) => {
    if (err) {
      console.error('[upload-images] error:', err.message);
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded. Make sure the field name is "images" and files are JPG/PNG/WEBP.' });
    }
    const urls = req.files.map(f => `/uploads/products/${f.filename}`);
    res.json({ success: true, message: `${urls.length} image(s) uploaded.`, data: urls });
  });
});

// GET /api/v1/products — list with search, filters, pagination
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      brand,
      department,
      category,
      subcategory,
      status,
      tileSize,
      finish,
      tileType,
      applicationArea,
      sortBy = 'createdAt',
      order = 'desc',
      dealer: dealerId,
    } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [
        { itemName: regex }, { productCode: regex }, { aliasName: regex },
        { hsnCode: regex }, { colour: regex }, { design: regex }, { barcode: regex },
      ];
    }
    if (brand) filter.brand = brand;

    // Department / category filtering walks the taxonomy, so picking a department returns
    // everything filed beneath it, not only the products sitting directly on it. `department`
    // was previously ignored outright, which made the filter appear to do nothing.
    const scopeId = [department, category].find((v) => v && mongoose.isValidObjectId(v));
    if (scopeId) {
      filter.category = { $in: await descendantIds(scopeId) };
    } else if (category) {
      // Not a usable id — matched literally so an unknown value yields nothing rather than
      // being silently dropped.
      filter.category = category;
    }

    if (subcategory) filter.subcategory = subcategory;
    if (status) filter.status = status;
    if (tileSize) filter.tileSize = tileSize;
    if (finish) filter.finish = finish;
    if (tileType) filter.tileType = tileType;
    if (applicationArea) filter.applicationArea = applicationArea;

    const sort = { [sortBy]: order === 'asc' ? 1 : -1 };

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort(sort)
        .skip((p - 1) * l)
        .limit(l)
        .populate('brand', 'name')
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .select('-imageEmbedding') // exclude large vector from list view
        .lean(),
      Product.countDocuments(filter),
    ]);

    // Resolve optional dealer for customized rates
    let selectedDealer = null;
    if (dealerId && mongoose.isValidObjectId(dealerId)) {
      selectedDealer = await Dealer.findById(dealerId).populate('dealerType').lean();
    }

    // Attach branch-scoped available/total stock so pickers (PR, quotations, SO)
    // show real balances instead of an undefined field that renders as 0.
    const headerBranchId = req.get('X-Branch-Id');
    let effectiveBranch = (mongoose.isValidObjectId(headerBranchId) ? headerBranchId : null)
      || req.branchId
      || (selectedDealer ? await resolveDealerBranch(selectedDealer) : null)
      || req.user?.defaultBranch
      || req.user?.assignedBranches?.[0]
      || req.user?.branch
      || null;

    if (!effectiveBranch) {
      const firstBranch = await Branch.findOne({ status: 'active' }).select('_id').lean();
      effectiveBranch = firstBranch?._id || null;
    }

    // "All Branches" must sum stock across every branch the user may read. The
    // fallback chain below deliberately lands on ONE branch (needed for dealer
    // pricing), so the stock scope has to be widened before it is used —
    // otherwise the All Branches view silently reported the default branch's
    // balance and looked identical to a single branch.
    const allBranchesStockScope = req.allBranches && req.branchIds?.length
      ? { branch: { $in: req.branchIds.map((id) => new mongoose.Types.ObjectId(String(id))) } }
      : null;

    const branchScope = allBranchesStockScope
      || (effectiveBranch && mongoose.isValidObjectId(effectiveBranch)
        ? { branch: new mongoose.Types.ObjectId(String(effectiveBranch)) }
        : {});
    const productIds = products.map((product) => product._id);
    const stockRows = productIds.length ? await Stock.aggregate([
      { $match: { ...branchScope, product: { $in: productIds } } },
      { $group: {
        _id: '$product',
        totalQty: { $sum: '$totalQty' },
        availableQty: { $sum: '$availableQty' },
        reservedQty: { $sum: '$reservedQty' },
        // Held for an approved quotation. availableQty is already net of this, so
        // it is surfaced only to explain why free stock is lower than total.
        quotedQty: { $sum: '$quotedQty' },
        damagedQty: { $sum: '$damagedQty' },
      } },
    ]) : [];
    const stockByProduct = new Map(stockRows.map((row) => [String(row._id), row]));

    const withStock = await Promise.all(products.map(async (product) => {
      const stock = stockByProduct.get(String(product._id));
      let dealerRate = null;
      let effectiveRate = null;
      let rateField = null;

      if (selectedDealer && effectiveBranch) {
        try {
          const priced = await resolvePricing({
            branchId: effectiveBranch,
            dealerId: selectedDealer._id,
            product,
            quantity: 1,
            pricingDate: new Date(),
          });
          dealerRate = money(priced.pricingRate);
          effectiveRate = money(priced.effectiveRate);
          rateField = priced.rateField;
        } catch {
          dealerRate = Number(product.dealerRate) || Number(product.retailRate) || null;
        }
      } else {
        dealerRate = Number(product.dealerRate) || Number(product.retailRate) || null;
      }

      const savings = mrpSaving(product.mrp, dealerRate);

      return {
        ...product,
        stockAvailable: Number(stock?.availableQty || 0),
        stockTotal: Number(stock?.totalQty || 0),
        stockReserved: Number(stock?.reservedQty || 0),
        stockQuoted: Number(stock?.quotedQty || 0),
        stockDamaged: Number(stock?.damagedQty || 0),
        dealerRate,
        effectiveRate,
        rateField,
        ...savings,
      };
    }));

    res.json({
      success: true,
      data: withStock,
      selectedDealer: selectedDealer ? {
        _id: selectedDealer._id,
        businessName: selectedDealer.businessName,
        dealerCode: selectedDealer.dealerCode,
      } : null,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    console.error('Get products error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/products/stats
router.get('/stats', async (req, res) => {
  try {
    const [total, active, inactive, draft] = await Promise.all([
      Product.countDocuments(),
      Product.countDocuments({ status: 'active' }),
      Product.countDocuments({ status: 'inactive' }),
      Product.countDocuments({ status: 'draft' }),
    ]);
    res.json({ success: true, data: { total, active, inactive, draft } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/products/filter-options — brands + the taxonomy, for filter dropdowns
//
// Returns BOTH shapes while the Product Master is being moved onto the tree:
//   legacy — `categories` (level 2) and `subcategories` (level 3) with a scalar `brand`
//            and a `category` parent, which is what the current cascading selects read
//   new    — `departments` (level 1) and `tree` (nested), for the tree-based UI
//
// Rows written before the migration have no `level` yet, so they are treated as
// level 2 here. Without that fallback the category dropdown would go empty the moment
// the schema changed, before the migration had run.
router.get('/filter-options', async (req, res) => {
  try {
    const [brands, nodes] = await Promise.all([
      Brand.find({ status: 'active' }).sort({ name: 1 }).lean(),
      Category.find({ status: 'active' }).sort({ level: 1, sortOrder: 1, name: 1 }).lean(),
    ]);

    const levelOf = (n) => n.level || 2;   // pre-migration rows default to level 2
    const shape = (n) => ({
      ...n,
      level: levelOf(n),
      // Legacy scalar brand, so the existing brand-first select still resolves.
      // `brands` is the real (many-to-many) field and is what the new UI should use.
      brand: (n.brands && n.brands[0]) || n.brand || null,
      // Legacy parent key for the subcategory select.
      category: n.parent || null,
    });

    const departments = nodes.filter((n) => levelOf(n) === 1).map(shape);
    const categories = nodes.filter((n) => levelOf(n) === 2).map(shape);
    const subcategories = nodes.filter((n) => levelOf(n) === 3).map(shape);

    const tree = nodes
      .filter((n) => !n.parent)
      .map(function build(n) {
        return { ...shape(n), children: nodes.filter((c) => String(c.parent) === String(n._id)).map(build) };
      });

    res.json({
      success: true,
      data: { brands, categories, subcategories, departments, tree },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Specification dropdown options ────────────────────────────────────────────
//
// MUST stay above `/:id` below, or Express would match "options" as a product id and this
// handler would never run.
//
// The lists are seeded in config/productOptions.js and extended per branch by ProductOption
// rows. Only the additions are stored, so correcting a default is a one-line change here
// rather than a data migration across every branch.

/**
 * Every dropdown's full list (defaults + this branch's additions), plus the additions
 * themselves.
 *
 * The additions come back as rows with their `_id` so the UI can offer to remove one. Only
 * additions are removable — the defaults live in code, so "deleting" one would mean nothing.
 */
const loadSpecOptions = async (branchId) => {
  const custom = await ProductOption.find({ branch: branchId })
    .select('field value')
    .sort({ createdAt: 1 })
    .lean();
  const byField = {};
  for (const row of custom) {
    (byField[row.field] = byField[row.field] || []).push(row.value);
  }
  const options = {};
  for (const field of PRODUCT_OPTION_FIELDS) {
    options[field] = mergedOptions(field, byField[field] || []);
  }
  return { options, custom };
};

router.get('/options', async (req, res) => {
  try {
    const { options, custom } = await loadSpecOptions(req.branchId);
    res.json({ success: true, data: options, custom });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Add a value to one dropdown.
 *
 * Returns the WHOLE refreshed option map, so the form can update every list from this single
 * response instead of firing a second GET.
 *
 * Re-adding an existing value is not an error — it returns 200 with the unchanged list, because
 * two admins adding "Rustic" at the same moment is a normal thing to happen and neither should
 * see a failure for it.
 */
router.post('/options', async (req, res) => {
  try {
    const field = String(req.body?.field || '').trim();
    if (!PRODUCT_OPTION_FIELDS.includes(field)) {
      return res.status(422).json({ success: false, message: `Unknown option list "${field}".` });
    }

    // Canonicalise before storing. A tile size saved as "1010" never produces a SqFt/Box
    // calculation — sqftPerTile() parses "WxH" — and nothing downstream would explain why.
    const normalised = normaliseOptionValue(field, req.body?.value);
    if (!normalised.ok) {
      return res.status(422).json({ success: false, message: normalised.message });
    }
    const value = normalised.value;

    if (value.length > MAX_OPTION_LENGTH) {
      return res.status(422).json({
        success: false,
        message: `Keep it under ${MAX_OPTION_LENGTH} characters.`,
      });
    }

    const { options, custom } = await loadSpecOptions(req.branchId);
    // Match on the normalised value so "600x600" does not duplicate an existing "600 x 600".
    const existing = (options[field] || []).find(
      (candidate) => String(candidate).toLowerCase() === value.toLowerCase()
    );
    if (existing) {
      // `added` carries the STORED form, so the form selects the value that actually exists
      // rather than the differently-cased text that was typed.
      return res.json({
        success: true,
        message: `"${existing}" is already in the list.`,
        data: options,
        custom,
        added: existing,
      });
    }

    await ProductOption.create({
      branch: req.branchScope,
      field,
      value,
      createdBy: req.user?._id,
    });

    const refreshed = await loadSpecOptions(req.branchId);
    res.status(201).json({
      success: true,
      message: `"${value}" added.`,
      data: refreshed.options,
      custom: refreshed.custom,
      // The canonical form, so the caller selects exactly what was saved.
      added: value,
    });
  } catch (error) {
    // The unique index is the real guard against a race between two admins adding the same
    // value; treat losing that race as success rather than showing a duplicate-key error.
    if (error?.code === 11000) {
      const raced = await loadSpecOptions(req.branchId);
      return res.json({
        success: true,
        message: 'That value is already in the list.',
        data: raced.options,
        custom: raced.custom,
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Remove an option the admin added earlier.
 *
 * Refused while products still use it — deleting it would leave those products holding a value
 * that is no longer in any list, so the dropdown would show blank for them and nobody would know
 * why. The refusal names the count so the admin can go and re-assign those products first.
 *
 * Only additions can be removed. A built-in default is not a database row at all, so there is
 * nothing to delete; the 404 says so rather than pretending to succeed.
 */
router.delete('/options/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(422).json({ success: false, message: 'Invalid option id.' });
    }
    const option = await ProductOption.findOne({ _id: req.params.id, branch: req.branchScope }).lean();
    if (!option) {
      return res.status(404).json({
        success: false,
        message: 'That option was not added here, so it cannot be removed.',
      });
    }

    const usageFilter = productUsageFilter(option.field, option.value);
    const inUse = usageFilter
      ? await Product.countDocuments({ branch: req.branchScope, ...usageFilter })
      : 0;

    if (inUse > 0) {
      return res.status(409).json({
        success: false,
        message: `"${option.value}" is used by ${inUse} product${inUse === 1 ? '' : 's'}. Change those products first, then remove it.`,
        inUse,
      });
    }

    await ProductOption.deleteOne({ _id: option._id });
    const refreshed = await loadSpecOptions(req.branchId);
    res.json({
      success: true,
      message: `"${option.value}" removed.`,
      data: refreshed.options,
      custom: refreshed.custom,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/products/:id
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('brand', 'name')
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .select('-imageEmbedding') // exclude heavy vector; status shown via imageEmbeddingUpdatedAt
      .lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

    // The raw `attributes` map is included with the document, but a client cannot label it
    // without the definitions. Resolving them here means the SE app shows "Slab Length: 8 ft"
    // rather than "slabLength: 8", and a new attribute needs no app change.
    const { describeProductAttributes } = await import('../services/attributeService.js');
    const attributeSpecs = await describeProductAttributes(product.category?._id, product.attributes);

    // Resolve optional dealer for customized rates
    let selectedDealer = null;
    if (req.query.dealer && mongoose.isValidObjectId(req.query.dealer)) {
      selectedDealer = await Dealer.findById(req.query.dealer).populate('dealerType').lean();
    }

    const headerBranchId = req.get('X-Branch-Id');
    let effectiveBranch = (mongoose.isValidObjectId(headerBranchId) ? headerBranchId : null)
      || req.branchId
      || (selectedDealer ? await resolveDealerBranch(selectedDealer) : null)
      || req.user?.defaultBranch
      || req.user?.assignedBranches?.[0]
      || req.user?.branch
      || null;

    if (!effectiveBranch) {
      const firstBranch = await Branch.findOne({ status: 'active' }).select('_id').lean();
      effectiveBranch = firstBranch?._id || null;
    }

    // Same widening as the list route: All Branches = stock from every branch.
    const allBranchesStockScope = req.allBranches && req.branchIds?.length
      ? { branch: { $in: req.branchIds.map((id) => new mongoose.Types.ObjectId(String(id))) } }
      : null;

    const branchScope = allBranchesStockScope
      ? { ...allBranchesStockScope, product: new mongoose.Types.ObjectId(String(product._id)) }
      : effectiveBranch && mongoose.isValidObjectId(effectiveBranch)
        ? { branch: new mongoose.Types.ObjectId(String(effectiveBranch)), product: new mongoose.Types.ObjectId(String(product._id)) }
        : { product: new mongoose.Types.ObjectId(String(product._id)) };

    const stockRows = await Stock.aggregate([
      { $match: branchScope },
      { $group: {
        _id: '$product',
        totalQty: { $sum: '$totalQty' },
        availableQty: { $sum: '$availableQty' },
        reservedQty: { $sum: '$reservedQty' },
        quotedQty: { $sum: '$quotedQty' },
        damagedQty: { $sum: '$damagedQty' },
      } },
    ]);
    const stock = stockRows[0];

    let dealerRate = null;
    let effectiveRate = null;
    let rateField = null;

    if (selectedDealer && effectiveBranch) {
      try {
        const priced = await resolvePricing({
          branchId: effectiveBranch,
          dealerId: selectedDealer._id,
          product,
          quantity: 1,
          pricingDate: new Date(),
        });
        dealerRate = money(priced.pricingRate);
        effectiveRate = money(priced.effectiveRate);
        rateField = priced.rateField;
      } catch {
        dealerRate = Number(product.dealerRate) || Number(product.retailRate) || null;
      }
    } else {
      dealerRate = Number(product.dealerRate) || Number(product.retailRate) || null;
    }

    const savings = mrpSaving(product.mrp, dealerRate);

    res.json({
      success: true,
      data: {
        ...product,
        attributeSpecs,
        stockAvailable: Number(stock?.availableQty || 0),
        stockTotal: Number(stock?.totalQty || 0),
        stockReserved: Number(stock?.reservedQty || 0),
        stockQuoted: Number(stock?.quotedQty || 0),
        stockDamaged: Number(stock?.damagedQty || 0),
        dealerRate,
        effectiveRate,
        rateField,
        ...savings,
        selectedDealer: selectedDealer ? {
          _id: selectedDealer._id,
          businessName: selectedDealer.businessName,
          dealerCode: selectedDealer.dealerCode,
        } : null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/products
router.post('/', canCreateProduct, async (req, res) => {
  try {
    const productData = { ...req.body, createdBy: req.user._id };
    Object.assign(productData, normalizeProductUomConfig(productData, productData.unit || 'Box'));

    // Validate the flexible attributes against whatever the product's category declares.
    // Run unconditionally on create so a required attribute cannot be skipped, and so
    // unknown keys are dropped rather than stored — otherwise the retired tile columns
    // could leak back in through the attributes bag.
    const { attributes, dropped } = await normalizeAndValidateAttributes(
      productData.category,
      req.body.attributes || {},
    );
    productData.attributes = attributes;

    // Auto-generate product code if not provided — check both products AND recycle bin for uniqueness
    if (!productData.productCode) {
      const RecycleBin = (await import('../models/RecycleBin.js')).default;
      let codeNum = await Product.countDocuments() + 1;
      let code = `BDM${String(codeNum).padStart(6, '0')}`;
      // Keep incrementing until we find a code that doesn't exist in products OR recycle bin
      while (true) {
        const existsInProducts = await Product.findOne({ productCode: code }).lean();
        const existsInBin = await RecycleBin.findOne({ 'data.productCode': code, originalModel: 'Product' }).lean();
        if (!existsInProducts && !existsInBin) break;
        codeNum++;
        code = `BDM${String(codeNum).padStart(6, '0')}`;
      }
      productData.productCode = code;
    }

    const product = await Product.create(productData);

    // Fire-and-forget: generate image embedding for visual search
    scheduleEmbedding(String(product._id), product.images);

    // Surface ignored keys rather than silently discarding them — a form sending a field
    // the category does not define is a wiring mistake worth seeing.
    res.status(201).json({
      success: true,
      message: dropped.length
        ? `Product created. Ignored unrecognised attribute${dropped.length === 1 ? '' : 's'}: ${dropped.join(', ')}.`
        : 'Product created.',
      data: product,
      ...(dropped.length ? { ignoredAttributes: dropped } : {}),
    });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Product code already exists.' });
    if (error.status || error.name === 'ValidationError') return res.status(error.status || 422).json({ success: false, message: error.message });
    console.error('Create product error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/v1/products/:id
router.put('/:id', canUpdateProduct, async (req, res) => {
  try {
    const existing = await Product.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Product not found.' });
    const update = { ...req.body };
    const nextUom = normalizeProductUomConfig({ ...existing.toObject(), ...update }, existing.unit || 'Box');
    const previousUom = normalizeProductUomConfig(existing.toObject(), existing.unit || 'Box');
    const uomChanged = JSON.stringify({ base: previousUom.inventoryBaseUom, conversions: previousUom.uomConversions.map(({ uom, toBaseFactor }) => ({ uom, toBaseFactor })) })
      !== JSON.stringify({ base: nextUom.inventoryBaseUom, conversions: nextUom.uomConversions.map(({ uom, toBaseFactor }) => ({ uom, toBaseFactor })) });
    if (uomChanged && (await Promise.all([
      Stock.exists({ product: existing._id }).then(Boolean),
      StockMovement.exists({ product: existing._id }).then(Boolean),
    ])).some(Boolean)) {
      return res.status(409).json({ success: false, message: 'Inventory base UOM and conversion factors are immutable after stock history exists. Packaging/display fields may still be changed.' });
    }
    if (uomChanged && Number(nextUom.inventoryUomVersion) <= Number(existing.inventoryUomVersion || 1)) {
      nextUom.inventoryUomVersion = Number(existing.inventoryUomVersion || 1) + 1;
      nextUom.uomConversions = nextUom.uomConversions.map(row => ({ ...row, version: nextUom.inventoryUomVersion }));
    }
    Object.assign(update, nextUom);

    // Attributes are validated against the category the product will END UP in, which
    // may differ from the current one when this same update moves it. Re-validating on a
    // category change is what stops a product carrying attributes that belong to the
    // category it just left.
    if (req.body.attributes !== undefined || req.body.category !== undefined) {
      const targetCategory = update.category || existing.category;
      const raw = req.body.attributes !== undefined
        ? req.body.attributes
        : (existing.attributes instanceof Map ? Object.fromEntries(existing.attributes) : (existing.attributes || {}));
      const { attributes } = await normalizeAndValidateAttributes(targetCategory, raw, {
        // A partial update that only moves the category must not fail on required
        // attributes the caller never had the chance to supply.
        partial: req.body.attributes === undefined,
      });
      update.attributes = attributes;
    }

    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .populate('brand', 'name')
      .populate('category', 'name')
      .populate('subcategory', 'name');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

    // Fire-and-forget: re-generate embedding if images changed
    const prevImages = existing.images || [];
    const newImages  = product.images  || [];
    const imagesChanged = newImages[0] !== prevImages[0];
    if (imagesChanged || (newImages.length > 0 && !product.imageEmbedding?.length)) {
      scheduleEmbedding(String(product._id), newImages);
    }

    res.json({ success: true, message: 'Product updated.', data: product });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Product code already exists.' });
    res.status(error.status || (error.name === 'ValidationError' ? 422 : 500)).json({ success: false, message: error.message });
  }
});

// DELETE /api/v1/products/:id
router.delete('/:id', canDeleteProduct, async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Product, req.params.id, {
      user: req.user,
      module: 'product',
      titleField: 'itemName',
      codeField: 'productCode',
    });
    res.status(result.status || 200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/products/bulk-price-update — increase/decrease prices in bulk
router.post('/bulk-price-update', canUpdateProduct, async (req, res) => {
  try {
    const { filterBy, filterId, priceField, changeType, changeValue, applyTo } = req.body;
    // filterBy: 'brand' | 'category' | 'subcategory' | 'all'
    // priceField: 'dealerRate' | 'wholesaleRate' | 'retailRate' | 'distributorRate' | 'builderRate' | 'mrp' | 'all'
    // changeType: 'increase_percent' | 'decrease_percent' | 'increase_flat' | 'decrease_flat' | 'set_value'
    // changeValue: number

    if (!changeValue && changeType !== 'set_value') {
      return res.status(400).json({ success: false, message: 'Change value is required.' });
    }

    let filter = { status: 'active' };
    if (filterBy === 'brand' && filterId) filter.brand = filterId;
    else if (filterBy === 'category' && filterId) filter.category = filterId;
    else if (filterBy === 'subcategory' && filterId) filter.subcategory = filterId;

    const products = await Product.find(filter);
    if (!products.length) return res.status(404).json({ success: false, message: 'No products found for this filter.' });

    const priceFields = priceField === 'all'
      ? ['dealerRate', 'wholesaleRate', 'retailRate', 'distributorRate', 'builderRate', 'mrp']
      : [priceField];

    let updatedCount = 0;
    for (const prod of products) {
      let modified = false;
      for (const field of priceFields) {
        const currentVal = prod[field] || 0;
        let newVal = currentVal;

        switch (changeType) {
          case 'increase_percent': newVal = currentVal + (currentVal * changeValue / 100); break;
          case 'decrease_percent': newVal = currentVal - (currentVal * changeValue / 100); break;
          case 'increase_flat': newVal = currentVal + changeValue; break;
          case 'decrease_flat': newVal = currentVal - changeValue; break;
          case 'set_value': newVal = changeValue; break;
        }

        newVal = Math.max(0, Math.round(newVal * 100) / 100);
        if (newVal !== currentVal) {
          prod[field] = newVal;
          modified = true;
        }
      }
      if (modified) {
        await prod.save();
        updatedCount++;
      }
    }

    res.json({ success: true, message: `${updatedCount} products updated.`, data: { updatedCount, totalFound: products.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /api/v1/products/bulk-min-stock — set minStockLevel and/or reorderLevel for many products at once
// Body: { updates: [{ productId, minStockLevel, reorderLevel }] }
// Each row may omit either field; only the supplied fields are written.
// Useful for the Min Stock grid editor rather than opening each product's full form.
router.patch('/bulk-min-stock', canUpdateProduct, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, message: 'Provide an "updates" array.' });
    }
    if (updates.length > 500) {
      return res.status(400).json({ success: false, message: 'Maximum 500 rows per request.' });
    }

    let updatedCount = 0;
    const errors = [];

    for (const row of updates) {
      if (!mongoose.isValidObjectId(row.productId)) {
        errors.push({ productId: row.productId, error: 'Invalid id.' });
        continue;
      }
      const patch = {};
      if (row.minStockLevel !== undefined) {
        const v = Number(row.minStockLevel);
        if (isNaN(v) || v < 0) { errors.push({ productId: row.productId, error: 'minStockLevel must be ≥ 0.' }); continue; }
        patch.minStockLevel = v;
      }
      if (row.reorderLevel !== undefined) {
        const v = Number(row.reorderLevel);
        if (isNaN(v) || v < 0) { errors.push({ productId: row.productId, error: 'reorderLevel must be ≥ 0.' }); continue; }
        patch.reorderLevel = v;
      }
      if (Object.keys(patch).length === 0) continue;

      const result = await Product.updateOne({ _id: row.productId }, { $set: patch });
      if (result.matchedCount) updatedCount++;
      else errors.push({ productId: row.productId, error: 'Product not found.' });
    }

    res.json({
      success: true,
      message: `${updatedCount} product${updatedCount === 1 ? '' : 's'} updated.`,
      data: { updatedCount, errors },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Two-step import (Excel / CSV / PDF) ───────────────────────────────────────
// Step 1  POST /api/v1/products/import/parse   multipart field "file"
//         -> { rows, matchedFields, ignoredHeaders, fields, warning }. Nothing is saved.
// Step 2  POST /api/v1/products/import/save    JSON { rows, defaultCategory, createBrands }
//         -> { total, imported, errors: [{ row, field, message }], importedItems }
// HTTP 200 is returned even when every row fails; the client reads `imported` and `errors`.
router.post('/import/parse', canCreateProduct, (req, res) => {
  uploadProductImportFile(req, res, async (multerErr) => {
    const file = req.file;
    try {
      if (multerErr) {
        const msg = multerErr.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB.' : multerErr.message;
        return res.status(400).json({ success: false, message: msg });
      }
      if (!file) return res.status(400).json({ success: false, message: 'No file uploaded (field: "file").' });
      const ext = path.extname(file.originalname).toLowerCase();
      const parsed = await parseImportFile(file.path, ext);
      return res.json({
        success: true,
        message: `${parsed.rows.length} row(s) read from ${file.originalname}.`,
        data: { ...parsed, fields: IMPORT_FIELDS, fileName: file.originalname },
      });
    } catch (err) {
      if (!err.status) console.error('Product import parse error:', err);
      return res.status(err.status || 500).json({ success: false, message: err.message });
    } finally {
      // The temp file is only needed for parsing — always remove it.
      if (file?.path) import('fs').then((fs) => fs.promises.unlink(file.path)).catch(() => {});
    }
  });
});

router.post('/import/save', canCreateProduct, async (req, res) => {
  try {
    const { rows, defaultCategory, createBrands = true } = req.body || {};
    const result = await importProductRows(rows, {
      userId: req.user._id,
      defaultCategory: defaultCategory || undefined,
      createBrands: createBrands !== false,
    });
    return res.json({
      success: true,
      message: `Import complete: ${result.imported} of ${result.total} product(s) imported.`,
      data: result,
    });
  } catch (err) {
    if (!err.status) console.error('Product import save error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/products/bulk-import — import products from a CSV file + optional image files
//
// Multipart form fields:
//   csv     — one .csv file with a header row matching the product template columns
//   images  — zero or more image files; matched to rows by the Image_N_Filename column values
//
// The CSV must use the exact column names produced by the "Export CSV" / "Download Template"
// feature on the Product Master page. Brand, Category, and Subcategory are matched by name
// (case-insensitive). Rows with validation errors are skipped and reported in the response.
//
// Response:
//   { success, created, skipped, errors: [{ row, reason }], data: [product] }
router.post('/bulk-import', canCreateProduct, (req, res) => {
  uploadBulkImport(req, res, async (multerErr) => {
    if (multerErr) {
      return res.status(400).json({ success: false, message: multerErr.message });
    }

    const csvFile = req.files?.csv?.[0];
    if (!csvFile) {
      return res.status(400).json({ success: false, message: 'No CSV file uploaded. Attach the file in a field named "csv".' });
    }

    // Build a lookup map from the original filename → stored path, so each row's
    // Image_N_Filename value can be matched against the files that were uploaded.
    const imageFileMap = {};
    for (const imgFile of (req.files?.images || [])) {
      // Key by the original filename (lowercased) the user named on disk — this is what they
      // put into the Image_N_Filename column of the CSV.
      imageFileMap[imgFile.originalname.toLowerCase()] = `/uploads/products/${imgFile.filename}`;
    }

    // ── Parse file (CSV or Excel) ──────────────────────────────────────────
    // Returns allRows as string[][] — one array of strings per row.
    let allRows = [];
    const ext = path.extname(csvFile.originalname).toLowerCase();
    const isExcel = ext === '.xlsx' || ext === '.xls';
    const isPdf = ext === '.pdf';
    // dryRun=true parses and validates only; nothing is written. Powers the preview step.
    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
    const removeUpload = () => import('fs').then(fs => fs.promises.unlink(csvFile.path)).catch(() => {});

    if (isPdf) {
      try {
        allRows = await pdfToRows(csvFile.path);
      } catch (e) {
        await removeUpload();
        return res.status(400).json({ success: false, message: `Could not read PDF: ${e.message}` });
      }
    } else if (isExcel) {
      // Use exceljs to read the first worksheet into a 2-D array of strings.
      try {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(csvFile.path);
        const ws = wb.worksheets[0];
        if (!ws) throw new Error('Excel file has no worksheets.');
        ws.eachRow({ includeEmpty: false }, (row) => {
          const cells = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            // Rich-text cells have a { richText: [...] } value; extract plain text.
            const v = cell.value;
            if (v === null || v === undefined) { cells.push(''); return; }
            if (typeof v === 'object' && v.richText) {
              cells.push(v.richText.map(r => r.text || '').join(''));
            } else if (typeof v === 'object' && v.result !== undefined) {
              cells.push(String(v.result ?? ''));         // formula cell
            } else if (v instanceof Date) {
              cells.push(v.toISOString().slice(0, 10));
            } else {
              cells.push(String(v).trim());
            }
          });
          allRows.push(cells);
        });
      } catch (e) {
        return res.status(400).json({ success: false, message: `Could not read Excel file: ${e.message}` });
      }
    } else {
      // Plain text CSV / TSV
      let rawText;
      try {
        rawText = await import('fs').then(fs => fs.promises.readFile(csvFile.path, 'utf-8'));
      } catch (e) {
        return res.status(500).json({ success: false, message: 'Could not read the uploaded file.' });
      }

      // Strip BOM if present (Excel adds one)
      if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);

      /**
       * Auto-detecting delimiter parser — handles comma, tab, and semicolon separated files.
       * Detects by counting which delimiter appears most on the header line.
       */
      const parseCSV = (text) => {
        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
        if (!lines.length) return [];

        const header = lines[0];
        const tabCount   = (header.match(/\t/g) || []).length;
        const commaCount = (header.match(/,/g) || []).length;
        const semiCount  = (header.match(/;/g) || []).length;
        const SEP = tabCount >= commaCount && tabCount >= semiCount ? '\t'
                  : semiCount > commaCount ? ';'
                  : ',';

        const parseRow = (line) => {
          if (SEP === '\t') return line.split('\t').map(s => s.trim());
          const fields = [];
          let cur = '';
          let inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQ) {
              if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
              else if (ch === '"') { inQ = false; }
              else { cur += ch; }
            } else {
              if (ch === '"') { inQ = true; }
              else if (ch === SEP) { fields.push(cur.trim()); cur = ''; }
              else { cur += ch; }
            }
          }
          fields.push(cur.trim());
          return fields;
        };

        return lines.map(parseRow);
      };

      allRows = parseCSV(rawText);
    }

    if (allRows.length < 2) {
      await removeUpload();
      return res.status(400).json({ success: false, message: 'File has no data rows. Make sure the header row is present.' });
    }

    // ── Find the header row ────────────────────────────────────────────────
    // The header row is the first row that contains "Item_Name" or "Category".
    // This handles Excel files where row 1 has a title/junk and the real header
    // is on row 2 (or later).
    // "BDM code" price-list sheets (PRODUCT NAME, BDMCODE, SIZE, ... MRP/BOX) are converted
    // into the canonical columns first.
    const bdmHeaderIdx = allRows.findIndex(r => isBdmSheet(r));
    if (bdmHeaderIdx >= 0) allRows = convertBdmRows(allRows, bdmHeaderIdx);

    const HEADER_MARKERS = ['Item_Name', 'Category', 'item_name', 'category', 'ITEM_NAME', 'CATEGORY'];
    let headerRowIdx = allRows.findIndex(row =>
      row.some(cell => HEADER_MARKERS.includes(String(cell || '').trim()))
    );
    if (headerRowIdx < 0) {
      await removeUpload();
      return res.status(400).json({ success: false, message: 'Could not find the header row. Make sure "Item_Name" or "Category" is in the header.' });
    }

    const headers = allRows[headerRowIdx].map(h => String(h || '').trim());
    const dataRows = allRows.slice(headerRowIdx + 1);

    const col = (row, name) => {
      const idx = headers.indexOf(name);
      return idx >= 0 ? (row[idx] || '').trim() : '';
    };
    const numCol = (row, name) => {
      const v = col(row, name);
      const n = parseFloat(v);
      return isNaN(n) ? 0 : n;
    };

    // ── Pre-load lookup tables ─────────────────────────────────────────────
    const [allBrands, allCategories] = await Promise.all([
      Brand.find({}).select('name _id').lean(),
      Category.find({}).select('name _id level').lean(),
    ]);

    const brandMap = new Map(allBrands.map(b => [b.name.toLowerCase(), b._id]));
    // Search ALL levels — category names are unique enough and admins enter whatever
    // name they see in the UI (which shows categories from any level).
    const categoryMap = new Map(allCategories.map(c => [c.name.toLowerCase(), c._id]));
    const subcategoryMap = categoryMap; // same map — subcategory is just a deeper node

    // Sheets without a Category column (e.g. BDM code lists) use the category picked in the UI.
    const fallbackCategory = mongoose.isValidObjectId(req.query.defaultCategory)
      ? allCategories.find(c => String(c._id) === String(req.query.defaultCategory))
      : null;
    // Unknown brands are created on real imports (never on a dry run) when requested.
    const createBrands = req.query.createBrands === 'true' || req.query.createBrands === '1';

    // ── Process rows ───────────────────────────────────────────────────────
    const created = [];
    const errors = [];
    const preview = [];
    const RecycleBin = (await import('../models/RecycleBin.js')).default;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 2; // 1-indexed, +1 for header
      if (row.every(c => !c)) continue; // skip blank rows

      try {
        // ── Required: Category ──────────────────────────────────────────
        const categoryName = col(row, 'Category') || fallbackCategory?.name || '';
        if (!categoryName) {
          errors.push({ row: rowNum, reason: 'Category is required.' });
          continue;
        }
        const categoryId = categoryMap.get(categoryName.toLowerCase());
        if (!categoryId) {
          errors.push({ row: rowNum, reason: `Category "${categoryName}" not found.` });
          continue;
        }

        // ── Optional lookups ────────────────────────────────────────────
        const brandName = col(row, 'Brand');
        let brandId = brandName ? (brandMap.get(brandName.toLowerCase()) || null) : null;
        if (brandName && !brandId && createBrands) {
          if (dryRun) {
            brandId = 'new'; // placeholder so validation proceeds; nothing is written
          } else {
            const newBrand = await Brand.create({ name: brandName, createdBy: req.user._id });
            brandMap.set(brandName.toLowerCase(), newBrand._id);
            brandId = newBrand._id;
          }
        }
        if (brandName && !brandId) {
          errors.push({ row: rowNum, reason: `Brand "${brandName}" not found.` });
          continue;
        }

        const subcategoryName = col(row, 'Subcategory');
        const subcategoryId = subcategoryName ? (subcategoryMap.get(subcategoryName.toLowerCase()) || null) : null;
        if (subcategoryName && !subcategoryId) {
          errors.push({ row: rowNum, reason: `Subcategory "${subcategoryName}" not found.` });
          continue;
        }

        // ── Image resolution ────────────────────────────────────────────
        // The "Images" column holds all filenames separated by " | "
        // e.g. "img1.png | img2.png | img3.png"
        const images = [];
        const imagesRaw = col(row, 'Images');
        if (imagesRaw) {
          const fnames = imagesRaw.split('|').map(s => s.trim()).filter(Boolean);
          for (const fname of fnames) {
            const uploaded = imageFileMap[fname.toLowerCase()];
            if (uploaded) images.push(uploaded);
          }
        }

        // ── Build product data ──────────────────────────────────────────
        const statusVal = col(row, 'Status') || 'active';
        const productData = {
          itemName: col(row, 'Item_Name'),
          aliasName: col(row, 'Alias_Name'),
          productCode: col(row, 'Product_Code') || undefined,
          hsnCode: col(row, 'HSN_Code'),
          gst: numCol(row, 'GST_%') || 18,
          unit: col(row, 'Unit') || 'Box',
          category: categoryId,
          subcategory: subcategoryId || undefined,
          brand: brandId || undefined,
          tileSize: col(row, 'Tile_Size'),
          finish: col(row, 'Finish'),
          colour: col(row, 'Colour'),
          design: col(row, 'Design'),
          collection: col(row, 'Collection'),
          tileType: col(row, 'Tile_Type'),
          applicationArea: col(row, 'Application_Area'),
          grade: col(row, 'Grade') || '',
          surface: col(row, 'Surface'),
          thickness: col(row, 'Thickness'),
          antiSkidRating: col(row, 'Anti_Skid_Rating'),
          waterAbsorption: col(row, 'Water_Absorption'),
          breakingStrength: col(row, 'Breaking_Strength'),
          piecesPerBox: numCol(row, 'Pieces_Per_Box'),
          sqftPerBox: numCol(row, 'Sqft_Per_Box'),
          weightPerBox: numCol(row, 'Weight_Per_Box'),
          mrp: numCol(row, 'MRP'),
          purchaseRate: numCol(row, 'Purchase_Rate'),
          landingCost: numCol(row, 'Landing_Cost'),
          retailRate: numCol(row, 'Retail_Rate'),
          dealerRate: numCol(row, 'Dealer_Rate'),
          wholesaleRate: numCol(row, 'Wholesale_Rate'),
          distributorRate: numCol(row, 'Distributor_Rate'),
          projectRate: numCol(row, 'Project_Rate'),
          builderRate: numCol(row, 'Builder_Rate'),
          minimumSellingRate: numCol(row, 'Min_Selling_Rate'),
          minStockLevel: numCol(row, 'Min_Stock_Level'),
          reorderLevel: numCol(row, 'Reorder_Level'),
          countryOfOrigin: col(row, 'Country_Of_Origin') || 'India',
          barcode: col(row, 'Barcode') || undefined,
          description: col(row, 'Description'),
          status: ['active', 'inactive', 'draft'].includes(statusVal) ? statusVal : 'active',
          images,
          createdBy: req.user._id,
        };

        if (!productData.itemName) {
          errors.push({ row: rowNum, reason: 'Item_Name is required.' });
          continue;
        }

        Object.assign(productData, normalizeProductUomConfig(productData, productData.unit));

        if (dryRun) {
          // Validate against the schema without saving or consuming a product code.
          await new Product({ ...productData, brand: productData.brand === 'new' ? undefined : productData.brand }).validate();
          if (productData.productCode && await Product.exists({ productCode: productData.productCode })) {
            throw new Error(`Product code "${productData.productCode}" already exists.`);
          }
          preview.push({
            row: rowNum,
            itemName: productData.itemName,
            productCode: productData.productCode || '',
            category: categoryName,
            subcategory: subcategoryName,
            brand: brandName,
            tileSize: productData.tileSize,
            finish: productData.finish,
            colour: productData.colour,
            unit: productData.unit,
            gst: productData.gst,
            mrp: productData.mrp,
            retailRate: productData.retailRate,
            status: productData.status,
          });
          continue;
        }

        // Validate and normalize flexible attributes (skip if category has none)
        try {
          const { attributes } = await normalizeAndValidateAttributes(productData.category, {}, { partial: true });
          productData.attributes = attributes;
        } catch { /* non-critical — proceed without attributes */ }

        // Auto-generate product code if not provided
        if (!productData.productCode) {
          let codeNum = await Product.countDocuments() + 1;
          let code = `BDM${String(codeNum).padStart(6, '0')}`;
          while (true) {
            const [inProd, inBin] = await Promise.all([
              Product.findOne({ productCode: code }).lean(),
              RecycleBin.findOne({ 'data.productCode': code, originalModel: 'Product' }).lean(),
            ]);
            if (!inProd && !inBin) break;
            codeNum++;
            code = `BDM${String(codeNum).padStart(6, '0')}`;
          }
          productData.productCode = code;
        }

        const product = await Product.create(productData);
        scheduleEmbedding(String(product._id), product.images);
        created.push(product);
      } catch (err) {
        const reason = err.code === 11000
          ? `Product code "${col(row, 'Product_Code')}" already exists.`
          : (err.message || 'Unknown error.');
        errors.push({ row: rowNum, reason });
      }
    }

    // Clean up the uploaded CSV file (it was only needed to parse)
    await removeUpload();

    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        message: `${preview.length} valid, ${errors.length} with errors.`,
        valid: preview.length,
        invalid: errors.length,
        rows: preview,
        errors,
      });
    }

    return res.json({
      success: true,
      message: `Import complete. ${created.length} created, ${errors.length} skipped.`,
      created: created.length,
      skipped: errors.length,
      errors,
      data: created.map(p => ({ _id: p._id, productCode: p.productCode, itemName: p.itemName })),
    });
  });
});

export default router;
