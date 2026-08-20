import { Router } from 'express';
import Brand from '../models/Brand.js';
import Category from '../models/Category.js';
import Subcategory from '../models/Subcategory.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);
router.use(requirePermission('category.setup'));

// ═══════════════════════════════════════
// BRANDS
// ═══════════════════════════════════════

// GET all brands
router.get('/brands', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 50);

    let filter = {};
    if (search) filter.name = new RegExp(search, 'i');
    if (status) filter.status = status;

    const [brands, total] = await Promise.all([
      Brand.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l).lean(),
      Brand.countDocuments(filter),
    ]);

    // Get category count per brand
    const brandsWithCount = await Promise.all(
      brands.map(async (brand) => {
        const categoryCount = await Category.countDocuments({ brand: brand._id });
        return { ...brand, categoryCount };
      })
    );

    res.json({
      success: true,
      data: brandsWithCount,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create brand
router.post('/brands', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Brand name is required.' });

    const brand = await Brand.create({ name: name.trim(), description, createdBy: req.user._id });
    res.status(201).json({ success: true, message: 'Brand created.', data: brand });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Brand already exists.' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update brand
router.put('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found.' });
    res.json({ success: true, message: 'Brand updated.', data: brand });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Brand name already exists.' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE brand
router.delete('/brands/:id', async (req, res) => {
  try {
    const catCount = await Category.countDocuments({ brand: req.params.id });
    if (catCount > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete. ${catCount} categories exist under this brand.` });
    }
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Brand, req.params.id, { user: req.user, module: 'brand', titleField: 'name', skipDependencyCheck: true });
    res.status(result.status || 200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════
// CATEGORIES (under a brand)
// ═══════════════════════════════════════

// GET categories by brand
router.get('/brands/:brandId/categories', async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 50);

    let filter = { brand: req.params.brandId };
    if (search) filter.name = new RegExp(search, 'i');

    const [categories, total] = await Promise.all([
      Category.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l).lean(),
      Category.countDocuments(filter),
    ]);

    // Get subcategory count per category
    const categoriesWithCount = await Promise.all(
      categories.map(async (cat) => {
        const subcategoryCount = await Subcategory.countDocuments({ category: cat._id });
        return { ...cat, subcategoryCount };
      })
    );

    res.json({
      success: true,
      data: categoriesWithCount,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create category under brand
router.post('/brands/:brandId/categories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Category name is required.' });

    const brand = await Brand.findById(req.params.brandId);
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found.' });

    const category = await Category.create({
      name: name.trim(), description, brand: req.params.brandId, createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Category created.', data: category });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Category already exists under this brand.' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update category
router.put('/categories/:id', async (req, res) => {
  try {
    const category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found.' });
    res.json({ success: true, message: 'Category updated.', data: category });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Category name already exists.' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE category
router.delete('/categories/:id', async (req, res) => {
  try {
    const subCount = await Subcategory.countDocuments({ category: req.params.id });
    if (subCount > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete. ${subCount} subcategories exist.` });
    }
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Category, req.params.id, { user: req.user, module: 'category', titleField: 'name', skipDependencyCheck: true });
    res.status(result.status || 200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════
// SUBCATEGORIES (under a category)
// ═══════════════════════════════════════

// GET subcategories by brand + category
router.get('/brands/:brandId/categories/:categoryId/subcategories', async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 50);

    let filter = { brand: req.params.brandId, category: req.params.categoryId };
    if (search) filter.name = new RegExp(search, 'i');

    const [subcategories, total] = await Promise.all([
      Subcategory.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l).lean(),
      Subcategory.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: subcategories,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create subcategory
router.post('/brands/:brandId/categories/:categoryId/subcategories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Subcategory name is required.' });

    const category = await Category.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found.' });

    const subcategory = await Subcategory.create({
      name: name.trim(), description,
      brand: req.params.brandId, category: req.params.categoryId,
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Subcategory created.', data: subcategory });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Subcategory already exists under this category.' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update subcategory
router.put('/subcategories/:id', async (req, res) => {
  try {
    const subcategory = await Subcategory.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!subcategory) return res.status(404).json({ success: false, message: 'Subcategory not found.' });
    res.json({ success: true, message: 'Subcategory updated.', data: subcategory });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Subcategory name already exists.' });
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE subcategory
router.delete('/subcategories/:id', async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Subcategory, req.params.id, { user: req.user, module: 'subcategory', titleField: 'name', skipDependencyCheck: true });
    res.status(result.status || 200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
