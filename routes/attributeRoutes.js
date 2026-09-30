import { Router } from 'express';
import mongoose from 'mongoose';
import AttributeDefinition from '../models/AttributeDefinition.js';
import Category from '../models/Category.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { effectiveAttributes } from '../services/categoryTreeService.js';
import { assertValidKey } from '../services/attributeService.js';

const router = Router();
router.use(protect);

/**
 * Attribute definitions — the fields a category's products carry.
 *
 * Gated on `category.setup` rather than a new permission on purpose: defining a
 * category's attributes IS category setup, and a fresh permission would have to be
 * granted to every role that already holds `category.setup` or those admins would
 * silently lose access. Split it out later if the two ever need different owners.
 */
router.use(requirePermission('category.setup'));

const fail = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, error) => res
  .status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
  .json({ success: false, message: error.message });
const isId = (value) => mongoose.isValidObjectId(value);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shared field validation, so create and update cannot drift apart. */
function readDefinitionBody(body, { requireAll = true } = {}) {
  const out = {};
  const { key, label, type, options, unit, filterable, required, help, sortOrder, status } = body;

  if (key !== undefined || requireAll) out.key = assertValidKey(key);
  if (label !== undefined || requireAll) {
    const l = String(label || '').trim();
    if (!l) throw fail(422, 'Attribute label is required.');
    out.label = l;
  }
  if (type !== undefined || requireAll) {
    const t = String(type || 'text');
    if (!['select', 'multiselect', 'text', 'number', 'boolean'].includes(t)) {
      throw fail(422, 'Attribute type must be select, multiselect, text, number or boolean.');
    }
    out.type = t;
  }
  if (options !== undefined) {
    const list = Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean) : [];
    // A select with no options is unfillable, so reject it rather than save a dead field.
    const resolvedType = out.type ?? String(type || 'text');
    if (['select', 'multiselect'].includes(resolvedType) && !list.length) {
      throw fail(422, 'A select attribute needs at least one option.');
    }
    out.options = [...new Set(list)];
  }
  if (unit !== undefined) out.unit = String(unit || '').trim();
  if (filterable !== undefined) out.filterable = Boolean(filterable);
  if (required !== undefined) out.required = Boolean(required);
  if (help !== undefined) out.help = String(help || '').trim();
  if (sortOrder !== undefined) out.sortOrder = Number(sortOrder) || 0;
  if (status !== undefined) out.status = status === 'inactive' ? 'inactive' : 'active';

  return out;
}

// GET /?category=<id>&status= — definitions declared directly on a category.
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.category) {
      if (!isId(req.query.category)) throw fail(400, 'Invalid category id.');
      filter.category = req.query.category;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) filter.$or = [
      { label: new RegExp(escapeRegex(req.query.search), 'i') },
      { key: new RegExp(escapeRegex(req.query.search), 'i') },
    ];
    const rows = await AttributeDefinition.find(filter).sort({ category: 1, sortOrder: 1, label: 1 }).lean();
    res.json({ success: true, data: rows });
  } catch (error) { sendError(res, error); }
});

// GET /effective/:categoryId — everything that category inherits, ancestors included.
// This is what the Product Master form should render.
router.get('/effective/:categoryId', async (req, res) => {
  try {
    if (!isId(req.params.categoryId)) throw fail(400, 'Invalid category id.');
    const rows = await effectiveAttributes(req.params.categoryId, {
      filterableOnly: req.query.filterableOnly === 'true',
    });
    res.json({ success: true, data: rows });
  } catch (error) { sendError(res, error); }
});

// POST /bulk — declare several attributes on one category at once.
// Declared before /:id so "bulk" is never read as an id.
router.post('/bulk', async (req, res) => {
  try {
    const { category, attributes } = req.body;
    if (!isId(category)) throw fail(422, 'A valid category id is required.');
    if (!Array.isArray(attributes) || !attributes.length) throw fail(422, 'attributes must be a non-empty array.');

    const exists = await Category.findById(category).select('_id').lean();
    if (!exists) throw fail(404, 'Category not found.');

    // Reject duplicates inside the payload itself, before hitting the unique index,
    // so the error names the offending key instead of a raw Mongo E11000.
    const seen = new Set();
    const prepared = attributes.map((a, i) => {
      const clean = readDefinitionBody(a);
      if (seen.has(clean.key)) throw fail(422, `Duplicate attribute key "${clean.key}" at position ${i + 1}.`);
      seen.add(clean.key);
      return clean;
    });

    const existingKeys = new Set(
      (await AttributeDefinition.find({ category }).select('key').lean()).map((d) => d.key),
    );
    const clashes = prepared.filter((p) => existingKeys.has(p.key)).map((p) => p.key);
    if (clashes.length) throw fail(422, `These keys already exist on this category: ${clashes.join(', ')}.`);

    const created = await AttributeDefinition.insertMany(
      prepared.map((p) => ({ ...p, category, createdBy: req.user._id })),
    );
    res.status(201).json({ success: true, message: `${created.length} attributes created.`, data: created });
  } catch (error) { sendError(res, error); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid attribute id.');
    const row = await AttributeDefinition.findById(req.params.id).lean();
    if (!row) throw fail(404, 'Attribute not found.');
    res.json({ success: true, data: row });
  } catch (error) { sendError(res, error); }
});

router.post('/', async (req, res) => {
  try {
    const { category } = req.body;
    if (!isId(category)) throw fail(422, 'A valid category id is required.');
    const exists = await Category.findById(category).select('_id').lean();
    if (!exists) throw fail(404, 'Category not found.');

    const payload = readDefinitionBody(req.body);
    const row = await AttributeDefinition.create({ ...payload, category, createdBy: req.user._id });
    res.status(201).json({ success: true, message: 'Attribute created.', data: row });
  } catch (error) {
    if (error.code === 11000) return sendError(res, fail(400, 'That attribute key already exists on this category.'));
    sendError(res, error);
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid attribute id.');
    const existing = await AttributeDefinition.findById(req.params.id);
    if (!existing) throw fail(404, 'Attribute not found.');

    const updates = readDefinitionBody(req.body, { requireAll: false });

    // Renaming the key would orphan every value already stored under the old one, so it
    // is allowed only while no product uses it. Otherwise the field must be retired and
    // a new one created.
    if (updates.key && updates.key !== existing.key) {
      const inUse = await Product.countDocuments({ [`attributes.${existing.key}`]: { $exists: true } });
      if (inUse > 0) {
        throw fail(409, `Cannot rename the key: ${inUse} product${inUse === 1 ? '' : 's'} already store a value under "${existing.key}". Create a new attribute instead.`);
      }
    }

    // Changing a select's options can strand values that are no longer offered.
    if (updates.options && ['select', 'multiselect'].includes(updates.type || existing.type)) {
      const dropped = (existing.options || []).filter((o) => !updates.options.includes(o));
      if (dropped.length) {
        const stranded = await Product.countDocuments({
          $or: dropped.map((o) => ({ [`attributes.${existing.key}`]: o })),
        });
        if (stranded > 0) {
          throw fail(409, `Cannot remove option(s) ${dropped.join(', ')}: ${stranded} product${stranded === 1 ? '' : 's'} still use them.`);
        }
      }
    }

    const row = await AttributeDefinition.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json({ success: true, message: 'Attribute updated.', data: row });
  } catch (error) {
    if (error.code === 11000) return sendError(res, fail(400, 'That attribute key already exists on this category.'));
    sendError(res, error);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) throw fail(400, 'Invalid attribute id.');
    const row = await AttributeDefinition.findById(req.params.id).lean();
    if (!row) throw fail(404, 'Attribute not found.');

    // Deleting the definition does not delete the stored values, so refuse while any
    // product would be left holding an attribute nothing describes.
    const inUse = await Product.countDocuments({ [`attributes.${row.key}`]: { $exists: true } });
    if (inUse > 0) {
      throw fail(409, `Cannot delete: ${inUse} product${inUse === 1 ? '' : 's'} still store a value for "${row.label}". Set it inactive instead.`);
    }

    await AttributeDefinition.deleteOne({ _id: row._id });
    res.json({ success: true, message: 'Attribute deleted.' });
  } catch (error) { sendError(res, error); }
});

export default router;
