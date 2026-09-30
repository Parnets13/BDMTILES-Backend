import mongoose from 'mongoose';
import Category from '../models/Category.js';
import AttributeDefinition from '../models/AttributeDefinition.js';

/**
 * Tree operations for the product taxonomy.
 *
 * The taxonomy is a self-referencing tree on `Category`: level 1 is a department (Tiles,
 * Cement, Sanitaryware …), level 2 a category, level 3 a subcategory. Every route that
 * needs to walk it goes through here, so the traversal rules — depth, cycle safety,
 * inheritance — exist in exactly one place.
 *
 * `MAX_LEVEL` is a guard, not a limit to design around: it exists so a bad parent
 * assignment can never create an infinite loop in a recursive walk.
 */
export const MAX_LEVEL = 3;

export const DEPARTMENT = 1;
export const CATEGORY = 2;
export const SUBCATEGORY = 3;

const fail = (status, message) => Object.assign(new Error(message), { status });

const isId = (value) => mongoose.isValidObjectId(value);

export const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// ─────────────────────────────────────────────────────────────────────────────
// Reading the tree
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every node, flat, ordered so parents always precede their children.
 * Callers that need a nested shape build it from this rather than re-querying.
 */
export async function listNodes({ status, level, parent } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (level) filter.level = Number(level);
  if (parent !== undefined) filter.parent = parent ? new mongoose.Types.ObjectId(parent) : null;
  return Category.find(filter).sort({ level: 1, sortOrder: 1, name: 1 }).lean();
}

/**
 * The same rows as `listNodes`, assembled into a nested tree for the admin UI.
 * Built in memory from one query — a recursive database walk would be N+1 round trips.
 */
export function nestTree(nodes) {
  const byId = new Map();
  const roots = [];
  for (const node of nodes) {
    byId.set(String(node._id), { ...node, children: [] });
  }
  for (const node of byId.values()) {
    const parentId = node.parent ? String(node.parent) : null;
    if (parentId && byId.has(parentId)) byId.get(parentId).children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The node itself plus every ancestor, nearest first. */
export async function ancestorChain(categoryId, { includeSelf = true } = {}) {
  if (!isId(categoryId)) throw fail(422, 'A valid category id is required.');
  const chain = [];
  let current = includeSelf ? await Category.findById(categoryId).lean() : null;
  if (includeSelf && !current) throw fail(404, 'Category not found.');

  // Walk up from the parent. Bounded by MAX_LEVEL so a corrupt parent pointer
  // (or a cycle introduced by a bad edit) cannot spin forever.
  let parentId = current ? current.parent : categoryId;
  const seen = new Set(current ? [String(current._id)] : []);
  while (parentId && chain.length < MAX_LEVEL) {
    const key = String(parentId);
    if (seen.has(key)) break;
    seen.add(key);
    const node = await Category.findById(parentId).lean();
    if (!node) break;
    chain.push(node);
    parentId = node.parent;
  }
  return current ? [current, ...chain] : chain;
}

/** Names from the root down to this node, for a breadcrumb. */
export async function breadcrumb(categoryId) {
  const chain = await ancestorChain(categoryId);
  return chain.slice().reverse().map((n) => ({ _id: n._id, name: n.name, slug: n.slug, level: n.level }));
}

/**
 * Every id at or beneath `rootId`, including the root.
 *
 * This is what lets a department page show products from all of its categories, and
 * what replaces the old brand-scoped category lookups. Two queries at most, because
 * the tree is only three levels deep.
 */
export async function descendantIds(rootId) {
  if (!isId(rootId)) throw fail(422, 'A valid category id is required.');
  const ids = [new mongoose.Types.ObjectId(rootId)];
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_LEVEL - 1 && frontier.length; depth += 1) {
    const children = await Category.find({ parent: { $in: frontier } }).select('_id').lean();
    if (!children.length) break;
    const childIds = children.map((c) => c._id);
    ids.push(...childIds);
    frontier = childIds;
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attributes (inherited down the tree)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The attribute definitions that apply to a category: its own, plus everything it
 * inherits from its ancestors.
 *
 * A child wins on a key clash, so "Tiles" can declare `finish` once and a subcategory
 * can override just that one field without redeclaring the rest. Returned ordered by
 * the defining node's depth then sortOrder, so the form reads top-down from general
 * to specific.
 */
export async function effectiveAttributes(categoryId, { filterableOnly = false } = {}) {
  const chain = await ancestorChain(categoryId);           // self first
  const ids = chain.map((n) => n._id);
  if (!ids.length) return [];

  const filter = { category: { $in: ids }, status: 'active' };
  if (filterableOnly) filter.filterable = true;
  const defs = await AttributeDefinition.find(filter).lean();

  const depthOf = new Map(chain.map((n, i) => [String(n._id), i]));
  // Shallowest ancestor first, so a deeper (more specific) definition overwrites it.
  defs.sort((a, b) => {
    const da = depthOf.get(String(a.category)) ?? 0;
    const db = depthOf.get(String(b.category)) ?? 0;
    return db - da || (a.sortOrder || 0) - (b.sortOrder || 0);
  });

  const merged = new Map();
  for (const def of defs) merged.set(def.key, def);
  return [...merged.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing safely
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a proposed parent and returns the level the node would sit at.
 * Rejects an unknown parent, an over-deep node, and — importantly — a cycle, which
 * would otherwise detach a whole branch from the root and make it invisible.
 */
export async function resolveParent(parentId, { selfId = null } = {}) {
  if (parentId === undefined || parentId === null || parentId === '') {
    return { parent: null, level: DEPARTMENT };
  }
  if (!isId(parentId)) throw fail(422, 'A valid parent category id is required.');
  if (selfId && String(parentId) === String(selfId)) throw fail(422, 'A category cannot be its own parent.');

  const parent = await Category.findById(parentId).lean();
  if (!parent) throw fail(404, 'Parent category not found.');
  const level = (parent.level || DEPARTMENT) + 1;
  if (level > MAX_LEVEL) throw fail(422, `The taxonomy is limited to ${MAX_LEVEL} levels.`);

  if (selfId) {
    // Walk up from the proposed parent; meeting ourselves means this would form a cycle.
    const subtree = await descendantIds(selfId);
    if (subtree.some((id) => String(id) === String(parentId))) {
      throw fail(422, 'That would move a category inside itself.');
    }
  }
  return { parent: parent._id, level };
}

/**
 * A slug unique among siblings. Falls back to the id suffix when the name alone is
 * taken, so two sibling "Others" never collide on one URL.
 */
export async function makeSlug(name, parent, { excludeId = null } = {}) {
  const base = slugify(name) || 'category';
  let candidate = base;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const clash = await Category.findOne({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    }).select('_id').lean();
    if (!clash) return candidate;
    candidate = `${base}-${attempt + 2}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export default {
  MAX_LEVEL,
  DEPARTMENT,
  CATEGORY,
  SUBCATEGORY,
  slugify,
  listNodes,
  nestTree,
  ancestorChain,
  breadcrumb,
  descendantIds,
  effectiveAttributes,
  resolveParent,
  makeSlug,
};
