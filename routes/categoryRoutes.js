import { Router } from 'express';
import mongoose from 'mongoose';
import Brand from '../models/Brand.js';
import Category from '../models/Category.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { uploadBrandImage, uploadCategoryImage } from '../middleware/upload.js';
import {
  MAX_LEVEL, listNodes, nestTree, ancestorChain, breadcrumb,
  descendantIds, effectiveAttributes, resolveParent, makeSlug, slugify,
} from '../services/categoryTreeService.js';
import { VERTICAL_TAXONOMY } from '../data/verticalTaxonomy.js';

const router = Router();
router.use(protect);
router.use(requirePermission('category.setup'));

const fail = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, error) => res
  .status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
  .json({ success: false, message: error.message });
const isId = (value) => mongoose.isValidObjectId(value);

/**
 * Category setup — one self-referencing tree.
 *
 * New shape: Department (level 1) -> Category (level 2) -> Subcategory (level 3).
 * Brand is a link on the node (`brands[]`), never a parent.
 *
 * The `brands/:brandId/...` routes below are the LEGACY shape, kept so the existing
 * Category Setup screen keeps working while the new tree UI is built. They are now
 * thin wrappers over the tree — a "category under a brand" is simply a tree node whose
 * `brands` contains that brand. Nothing here writes the deprecated `Subcategory`
 * collection any more.
 */

// ═══════════════════════════════════════
// TREE
// ═══════════════════════════════════════

// GET /suggestions — the default names from the seeded taxonomy, so an admin picks one
// instead of retyping it (and possibly misspelling it).
//
// Only SUGGESTIONS: the frontend subtracts whatever already exists, so a name is offered
// exactly until it has been created, then disappears from the list. Anything typed by hand
// still works — this shortens the common path, it does not constrain it.
router.get('/suggestions', async (_req, res) => {
  try {
    res.json({
      success: true,
      data: VERTICAL_TAXONOMY.map((d) => ({
        name: d.name,
        systemKey: d.systemKey,
        // The default second level, offered when adding a subcategory under this department.
        categories: (d.categories || []).map((c) => c.name),
      })),
    });
  } catch (error) { sendError(res, error); }
});

// GET /tree — the whole taxonomy nested, for the admin tree view.
router.get('/tree', async (req, res) => {
  try {
    const nodes = await listNodes({ status: req.query.status || undefined });
    const tree = nestTree(nodes);
    // Counts are attached here rather than in the service: they need the Product
    // collection, and the service deliberately knows nothing about products.
    const productCounts = await Product.aggregate([
      { $match: { category: { $ne: null } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const countByCategory = new Map(productCounts.map((r) => [String(r._id), r.count]));

    // Two counts, because one number cannot answer both questions:
    //   `ownProductCount`  — filed directly on this node
    //   `productCount`     — this node AND everything beneath it
    // Products normally sit on a leaf, so a category whose goods live in its subcategories
    // would otherwise read 0 and look empty.
    const decorate = (list) => list.map((n) => {
      const children = decorate(n.children);
      const own = countByCategory.get(String(n._id)) || 0;
      const below = children.reduce((sum, child) => sum + child.productCount, 0);
      return { ...n, ownProductCount: own, productCount: own + below, children };
    });
    res.json({ success: true, data: decorate(tree), maxLevel: MAX_LEVEL });
  } catch (error) { sendError(res, error); }
});

// GET /nodes — flat list, optionally filtered by level or parent.
router.get('/nodes', async (req, res) => {
  try {
    const nodes = await listNodes({
      status: req.query.status || undefined,
      level: req.query.level || undefined,
      parent: req.query.parent !== undefined ? req.query.parent : undefined,
    });
    res.json({ success: true, data: nodes });
  } catch (error) { sendError(res, error); }
});

// GET /nodes/:id — one node, with its breadcrumb and the attributes it inherits.
router.get('/nodes/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid category id.');
    const node = await Category.findById(req.params.id).lean();
    if (!node) throw fail(404, 'Category not found.');
    const [path, attributes, children] = await Promise.all([
      breadcrumb(node._id),
      effectiveAttributes(node._id),
      Category.find({ parent: node._id }).sort({ sortOrder: 1, name: 1 }).lean(),
    ]);
    res.json({ success: true, data: { ...node, breadcrumb: path, attributes, children } });
  } catch (error) { sendError(res, error); }
});

// POST /nodes — create a department, category or subcategory.
router.post('/nodes', async (req, res) => {
  try {
    const { name, description, parent, brands, image, badge, sortOrder, showOnHome, status } = req.body;
    if (!name?.trim()) throw fail(422, 'Category name is required.');

    // resolveParent is the only place that decides a level, and it refuses anything
    // that would exceed MAX_LEVEL — so the tree cannot grow a fourth level by accident.
    const resolved = await resolveParent(parent);
    const slug = await makeSlug(name.trim(), resolved.parent);

    const node = await Category.create({
      name: name.trim(),
      slug,
      description: description || '',
      parent: resolved.parent,
      level: resolved.level,
      brands: Array.isArray(brands) ? brands.filter(isId) : [],
      image: image || '',
      badge: badge || '',
      sortOrder: Number(sortOrder) || 0,
      showOnHome: Boolean(showOnHome),
      status: status === 'inactive' ? 'inactive' : 'active',
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Category created.', data: node });
  } catch (error) {
    if (error.code === 11000) return sendError(res, fail(400, 'A category with that name already exists at this level.'));
    sendError(res, error);
  }
});

// PUT /nodes/:id — update. Moving a node re-levels it and every descendant.
router.put('/nodes/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid category id.');
    const existing = await Category.findById(req.params.id);
    if (!existing) throw fail(404, 'Category not found.');

    const updates = {};
    const { name, description, parent, brands, image, badge, sortOrder, showOnHome, status } = req.body;

    if (name !== undefined) {
      if (!String(name).trim()) throw fail(422, 'Category name cannot be empty.');
      updates.name = String(name).trim();
      // Keep the slug aligned with the name unless the caller pinned one explicitly.
      updates.slug = await makeSlug(updates.name, existing.parent, { excludeId: existing._id });
    }
    if (description !== undefined) updates.description = description;
    if (image !== undefined) updates.image = image;
    if (badge !== undefined) updates.badge = badge;
    if (sortOrder !== undefined) updates.sortOrder = Number(sortOrder) || 0;
    if (showOnHome !== undefined) updates.showOnHome = Boolean(showOnHome);
    if (status !== undefined) updates.status = status === 'inactive' ? 'inactive' : 'active';
    if (brands !== undefined) updates.brands = Array.isArray(brands) ? brands.filter(isId) : [];

    // Re-parenting: validate, then cascade the new level down the subtree, because a
    // stale `level` on a descendant would make it invisible to level-filtered queries.
    if (parent !== undefined) {
      const resolved = await resolveParent(parent, { selfId: existing._id });
      updates.parent = resolved.parent;
      updates.level = resolved.level;
      const shift = resolved.level - (existing.level || 1);
      if (shift !== 0) {
        const subtree = await descendantIds(existing._id);
        const others = subtree.filter((id) => String(id) !== String(existing._id));
        if (others.length) {
          await Category.updateMany({ _id: { $in: others } }, { $inc: { level: shift } });
        }
      }
    }

    const node = await Category.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json({ success: true, message: 'Category updated.', data: node });
  } catch (error) {
    if (error.code === 11000) return sendError(res, fail(400, 'A category with that name already exists at this level.'));
    sendError(res, error);
  }
});

// DELETE /nodes/:id — refuses while children or products still point at it, so a
// delete can never orphan a branch or leave products referencing nothing.
//
// `requireBranch` is applied per-route rather than to the whole router on purpose:
// taxonomy reads are global and must keep working with no branch selected, but
// safeDelete needs a branch as audit context for the recycle bin. Omitting it made this
// endpoint return 428 BRANCH_REQUIRED, so deleting a category never actually worked.
router.delete('/nodes/:id', requireBranch, async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid category id.');

    // System categories carry a `systemKey` — the stable identifier the app matches on (the
    // Product form branches on `tiles` to show its dedicated field block). Deleting one would
    // silently break that, so it is refused outright. Renaming is fine; retiring is a script.
    const target = await Category.findById(req.params.id).select('systemKey name').lean();
    if (!target) throw fail(404, 'Category not found.');
    if (target.systemKey) {
      throw fail(400, `"${target.name}" is a system category and cannot be deleted. Rename it, or set it inactive instead.`);
    }

    const [childCount, productCount] = await Promise.all([
      Category.countDocuments({ parent: req.params.id }),
      Product.countDocuments({ $or: [{ category: req.params.id }, { subcategory: req.params.id }] }),
    ]);
    if (childCount > 0) throw fail(400, `Cannot delete. ${childCount} child categor${childCount === 1 ? 'y' : 'ies'} exist.`);
    if (productCount > 0) throw fail(400, `Cannot delete. ${productCount} product${productCount === 1 ? '' : 's'} use this category.`);

    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Category, req.params.id, {
      user: req.user, req, branch: req.branchId,
      module: 'category', titleField: 'name', skipDependencyCheck: true,
    });
    res.status(result.status || 200).json(result);
  } catch (error) { sendError(res, error); }
});

// PUT /nodes/:id/brands — set which brands carry this category. A link, not a copy:
// this is what lets one "Tiles" node serve Kajaria, Somany and AGL at once.
router.put('/nodes/:id/brands', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid category id.');
    const list = Array.isArray(req.body.brands) ? req.body.brands.filter(isId) : null;
    if (!list) throw fail(422, 'brands must be an array of brand ids.');

    const valid = await Brand.find({ _id: { $in: list } }).select('_id').lean();
    if (valid.length !== list.length) throw fail(422, 'One or more brands do not exist.');

    const node = await Category.findByIdAndUpdate(req.params.id, { $set: { brands: valid.map((b) => b._id) } }, { new: true });
    if (!node) throw fail(404, 'Category not found.');
    res.json({ success: true, message: 'Brands updated.', data: node });
  } catch (error) { sendError(res, error); }
});

// GET /nodes/:id/attributes — the attribute definitions this node inherits.
router.get('/nodes/:id/attributes', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid category id.');
    const attributes = await effectiveAttributes(req.params.id, {
      filterableOnly: req.query.filterableOnly === 'true',
    });
    res.json({ success: true, data: attributes });
  } catch (error) { sendError(res, error); }
});

// ═══════════════════════════════════════
// BRANDS
// ═══════════════════════════════════════

router.get('/brands', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 50);

    const filter = {};
    if (search) filter.name = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (status) filter.status = status;

    const [brands, total] = await Promise.all([
      Brand.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l).lean(),
      Brand.countDocuments(filter),
    ]);

    // Counted through the `brands[]` link now, not the deprecated `Category.brand`.
    const counts = await Category.aggregate([
      { $match: { brands: { $in: brands.map((b) => b._id) } } },
      { $unwind: '$brands' },
      { $group: { _id: '$brands', count: { $sum: 1 } } },
    ]);
    const countByBrand = new Map(counts.map((r) => [String(r._id), r.count]));

    res.json({
      success: true,
      data: brands.map((b) => ({ ...b, categoryCount: countByBrand.get(String(b._id)) || 0 })),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { sendError(res, error); }
});

// POST upload a brand logo. The returned path is stored in Brand.image.
router.post('/brands/upload-image', (req, res) => {
  uploadBrandImage(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    if (!req.file) return res.status(400).json({ success: false, message: 'No image uploaded.' });
    res.json({ success: true, message: 'Brand logo uploaded.', data: `/uploads/brands/${req.file.filename}` });
  });
});

// POST upload a category image. The returned path is stored in Category.image and is what the
// storefront shows on that category's card.
router.post('/upload-image', (req, res) => {
  uploadCategoryImage(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    if (!req.file) return res.status(400).json({ success: false, message: 'No image uploaded.' });
    res.json({ success: true, message: 'Category image uploaded.', data: `/uploads/categories/${req.file.filename}` });
  });
});

router.post('/brands', async (req, res) => {
  try {
    const { name, description, image } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Brand name is required.' });
    const brand = await Brand.create({ name: name.trim(), description, image, createdBy: req.user._id });
    res.status(201).json({ success: true, message: 'Brand created.', data: brand });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Brand already exists.' });
    sendError(res, error);
  }
});

router.put('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!brand) return res.status(404).json({ success: false, message: 'Brand not found.' });
    res.json({ success: true, message: 'Brand updated.', data: brand });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Brand name already exists.' });
    sendError(res, error);
  }
});

router.delete('/brands/:id', requireBranch, async (req, res) => {
  try {
    // Pull the brand out of every category that lists it BEFORE deleting, rather than
    // refusing. Refusing would mean an admin has to unlink ten categories by hand just to
    // retire a brand, and every one left behind would be a dangling id in `brands[]`.
    const linked = await Category.updateMany(
      { brands: req.params.id },
      { $pull: { brands: req.params.id } },
    );
    const unlinked = linked.modifiedCount || 0;
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Brand, req.params.id, {
      user: req.user, req, branch: req.branchId,
      module: 'brand', titleField: 'name', skipDependencyCheck: true,
    });
    if (result.success && unlinked) {
      result.message = `${result.message || 'Brand deleted.'} Removed from ${unlinked} categor${unlinked === 1 ? 'y' : 'ies'}.`;
    }
    res.status(result.status || 200).json(result);
  } catch (error) { sendError(res, error); }
});

// ═══════════════════════════════════════
// LEGACY SHAPE (kept for the current Category Setup screen)
// A "category under a brand" is now just a tree node whose brands[] contains that brand.
// ═══════════════════════════════════════

// GET /web-categories — the department list the old screen used as its name dropdown.
// Now reads level-1 tree nodes, so the two vocabularies are finally the same one.
router.get('/web-categories', async (_req, res) => {
  try {
    const departments = await Category.find({ level: 1 })
      .sort({ sortOrder: 1, name: 1 })
      .select('name slug status showOnHome')
      .lean();
    res.json({ success: true, data: departments });
  } catch (error) { sendError(res, error); }
});

// GET /brands/:brandId/categories — categories that list this brand.
router.get('/brands/:brandId/categories', async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 50);

    const filter = { brands: req.params.brandId };
    if (search) filter.name = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [categories, total] = await Promise.all([
      Category.find(filter).sort({ level: 1, name: 1 }).skip((p - 1) * l).limit(l).lean(),
      Category.countDocuments(filter),
    ]);

    // Child count comes from the tree now — subcategories are level-3 Categories.
    const counts = await Category.aggregate([
      { $match: { parent: { $in: categories.map((c) => c._id) } } },
      { $group: { _id: '$parent', count: { $sum: 1 } } },
    ]);
    const countByParent = new Map(counts.map((r) => [String(r._id), r.count]));

    res.json({
      success: true,
      data: categories.map((c) => ({ ...c, subcategoryCount: countByParent.get(String(c._id)) || 0 })),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { sendError(res, error); }
});

// POST /brands/:brandId/categories — create a node and link the brand to it.
router.post('/brands/:brandId/categories', async (req, res) => {
  try {
    const { name, description, parent } = req.body;
    if (!name?.trim()) throw fail(422, 'Category name is required.');

    const brand = await Brand.findById(req.params.brandId).select('_id').lean();
    if (!brand) throw fail(404, 'Brand not found.');

    const resolved = await resolveParent(parent);
    const slug = await makeSlug(name.trim(), resolved.parent);
    const category = await Category.create({
      name: name.trim(), slug, description: description || '',
      parent: resolved.parent, level: resolved.level,
      brands: [brand._id], createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Category created.', data: category });
  } catch (error) {
    if (error.code === 11000) return sendError(res, fail(400, 'A category with that name already exists at this level.'));
    sendError(res, error);
  }
});

// GET /brands/:brandId/categories/:categoryId/subcategories — level-3 children.
router.get('/brands/:brandId/categories/:categoryId/subcategories', async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 50);

    const filter = { parent: req.params.categoryId };
    if (search) filter.name = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [subcategories, total] = await Promise.all([
      Category.find(filter).sort({ sortOrder: 1, name: 1 }).skip((p - 1) * l).limit(l).lean(),
      Category.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: subcategories,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { sendError(res, error); }
});

// POST /brands/:brandId/categories/:categoryId/subcategories
router.post('/brands/:brandId/categories/:categoryId/subcategories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) throw fail(422, 'Subcategory name is required.');
    const parent = await Category.findById(req.params.categoryId).select('_id level').lean();
    if (!parent) throw fail(404, 'Category not found.');

    const resolved = await resolveParent(req.params.categoryId);
    const slug = await makeSlug(name.trim(), resolved.parent);
    const subcategory = await Category.create({
      name: name.trim(), slug, description: description || '',
      parent: resolved.parent, level: resolved.level,
      brands: isId(req.params.brandId) ? [req.params.brandId] : [],
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Subcategory created.', data: subcategory });
  } catch (error) {
    if (error.code === 11000) return sendError(res, fail(400, 'A subcategory with that name already exists here.'));
    sendError(res, error);
  }
});

// PUT /categories/:id — alias onto the tree update path.
router.put('/categories/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid category id.');
    const node = await Category.findById(req.params.id);
    if (!node) throw fail(404, 'Category not found.');

    const updates = {};
    for (const field of ['description', 'image', 'badge']) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (req.body.status !== undefined) updates.status = req.body.status === 'inactive' ? 'inactive' : 'active';
    if (req.body.sortOrder !== undefined) updates.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) throw fail(422, 'Category name cannot be empty.');
      updates.name = String(req.body.name).trim();
      updates.slug = await makeSlug(updates.name, node.parent, { excludeId: node._id });
    }
    if (req.body.parent !== undefined) {
      const resolved = await resolveParent(req.body.parent, { selfId: node._id });
      updates.parent = resolved.parent;
      updates.level = resolved.level;
    }

    const updated = await Category.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json({ success: true, message: 'Category updated.', data: updated });
  } catch (error) {
    if (error.code === 11000) return sendError(res, fail(400, 'A category with that name already exists at this level.'));
    sendError(res, error);
  }
});

// DELETE /categories/:id — same guard as /nodes/:id.
router.delete('/categories/:id', requireBranch, async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid category id.');

    // System categories carry a `systemKey` — the stable identifier the app matches on (the
    // Product form branches on `tiles` to show its dedicated field block). Deleting one would
    // silently break that, so it is refused outright. Renaming is fine; retiring is a script.
    const target = await Category.findById(req.params.id).select('systemKey name').lean();
    if (!target) throw fail(404, 'Category not found.');
    if (target.systemKey) {
      throw fail(400, `"${target.name}" is a system category and cannot be deleted. Rename it, or set it inactive instead.`);
    }

    const [childCount, productCount] = await Promise.all([
      Category.countDocuments({ parent: req.params.id }),
      Product.countDocuments({ $or: [{ category: req.params.id }, { subcategory: req.params.id }] }),
    ]);
    if (childCount > 0) throw fail(400, `Cannot delete. ${childCount} child categor${childCount === 1 ? 'y' : 'ies'} exist.`);
    if (productCount > 0) throw fail(400, `Cannot delete. ${productCount} product${productCount === 1 ? '' : 's'} use this category.`);

    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Category, req.params.id, {
      user: req.user, req, branch: req.branchId,
      module: 'category', titleField: 'name', skipDependencyCheck: true,
    });
    res.status(result.status || 200).json(result);
  } catch (error) { sendError(res, error); }
});

// PUT /subcategories/:id — legacy alias; a subcategory is a level-3 Category.
router.put('/subcategories/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid subcategory id.');
    const updates = {};
    for (const field of ['description']) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (req.body.status !== undefined) updates.status = req.body.status === 'inactive' ? 'inactive' : 'active';
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) throw fail(422, 'Subcategory name cannot be empty.');
      const node = await Category.findById(req.params.id).select('parent').lean();
      if (!node) throw fail(404, 'Subcategory not found.');
      updates.name = String(req.body.name).trim();
      updates.slug = await makeSlug(updates.name, node.parent, { excludeId: req.params.id });
    }
    const updated = await Category.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!updated) throw fail(404, 'Subcategory not found.');
    res.json({ success: true, message: 'Subcategory updated.', data: updated });
  } catch (error) { sendError(res, error); }
});

// DELETE /subcategories/:id — legacy alias.
router.delete('/subcategories/:id', requireBranch, async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid subcategory id.');
    const productCount = await Product.countDocuments({ $or: [{ category: req.params.id }, { subcategory: req.params.id }] });
    if (productCount > 0) throw fail(400, `Cannot delete. ${productCount} product${productCount === 1 ? '' : 's'} use this subcategory.`);
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Category, req.params.id, {
      user: req.user, req, branch: req.branchId,
      module: 'subcategory', titleField: 'name', skipDependencyCheck: true,
    });
    res.status(result.status || 200).json(result);
  } catch (error) { sendError(res, error); }
});

export { slugify };
export default router;
