import { Router } from 'express';
import Product from '../models/Product.js';
import Brand from '../models/Brand.js';
import Category from '../models/Category.js';
import Subcategory from '../models/Subcategory.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { uploadProductImages } from '../middleware/upload.js';

const router = Router();
router.use(protect);
router.use(requirePermission('product.master'));

// POST /api/v1/products/upload-images — upload product images
router.post('/upload-images', (req, res) => {
  uploadProductImages(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }
    const urls = req.files.map(f => `/uploads/products/${f.filename}`);
    res.json({ success: true, message: `${urls.length} image(s) uploaded.`, data: urls });
  });
});

// GET /api/v1/products — list with search, filters, pagination
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, brand, category, subcategory, status, tileSize, finish, tileType, applicationArea, sortBy = 'createdAt', order = 'desc' } = req.query;
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
    if (category) filter.category = category;
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
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: products,
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

// GET /api/v1/products/filter-options — get brands/categories/subcategories for filter dropdowns
router.get('/filter-options', async (req, res) => {
  try {
    const [brands, categories, subcategories] = await Promise.all([
      Brand.find({ status: 'active' }).sort({ name: 1 }).lean(),
      Category.find({ status: 'active' }).sort({ name: 1 }).lean(),
      Subcategory.find({ status: 'active' }).sort({ name: 1 }).lean(),
    ]);
    res.json({ success: true, data: { brands, categories, subcategories } });
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
      .lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, data: product });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/products
router.post('/', async (req, res) => {
  try {
    const productData = { ...req.body, createdBy: req.user._id };

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
    res.status(201).json({ success: true, message: 'Product created.', data: product });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Product code already exists.' });
    console.error('Create product error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/v1/products/:id
router.put('/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('brand', 'name')
      .populate('category', 'name')
      .populate('subcategory', 'name');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, message: 'Product updated.', data: product });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Product code already exists.' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/v1/products/:id
router.delete('/:id', async (req, res) => {
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
router.post('/bulk-price-update', async (req, res) => {
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

export default router;
