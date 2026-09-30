import Category from '../models/Category.js';
import AttributeDefinition from '../models/AttributeDefinition.js';
import { effectiveAttributes } from './categoryTreeService.js';

/**
 * Attribute handling for the flexible per-category fields on Product.
 *
 * `AttributeDefinition` says what a category's products may carry; this module enforces
 * it. Every product write goes through `normalizeAndValidateAttributes`, so a value can
 * never be stored under a key the category does not define, and a required field can
 * never be silently left blank.
 *
 * Values are stored on `Product.attributes` (a Map) with the definition `key`.
 */

const fail = (status, message) => Object.assign(new Error(message), { status });
const isBlank = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** Coerce one raw value to the type its definition declares. Throws on a bad value. */
function coerceValue(def, value) {
  const label = def.label || def.key;

  if (def.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw fail(422, `${label} must be a number.`);
    return n;
  }

  if (def.type === 'boolean') {
    // Accept the strings a form or query string actually produces, not just real booleans.
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
    throw fail(422, `${label} must be true or false.`);
  }

  if (def.type === 'multiselect') {
    const list = Array.isArray(value) ? value : String(value).split(',').map((v) => v.trim()).filter(Boolean);
    if (!def.options?.length) return list.map(String);
    const allowed = new Set(def.options.map((o) => o.toLowerCase()));
    const bad = list.filter((v) => !allowed.has(String(v).trim().toLowerCase()));
    if (bad.length) throw fail(422, `${label}: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not allowed options.`);
    return list.map(String);
  }

  if (def.type === 'select') {
    const s = String(value).trim();
    if (!def.options?.length) return s;
    // Matched case-insensitively but stored in the definition's own casing, so the
    // storefront filter rail never shows two spellings of the same option.
    const match = def.options.find((o) => o.toLowerCase() === s.toLowerCase());
    if (!match) throw fail(422, `${label}: "${s}" is not an allowed option.`);
    return match;
  }

  return String(value).trim();
}

/**
 * Validate and coerce a product's attributes against what its category declares.
 *
 * Returns `{ attributes, dropped, applied }`:
 *  - `attributes` — the clean map to store
 *  - `dropped`    — keys that were sent but the category does not define (ignored, not fatal)
 *  - `applied`    — definitions that were used, so a caller can report on them
 *
 * `partial: true` skips the required-field check, for a PUT that only touches some
 * fields. A full create should always use the default so required attributes are enforced.
 */
export async function normalizeAndValidateAttributes(categoryId, raw = {}, { partial = false } = {}) {
  if (!categoryId) {
    if (raw && Object.keys(raw).length) throw fail(422, 'A category is required before attributes can be set.');
    return { attributes: {}, dropped: [], applied: [] };
  }

  const defs = await effectiveAttributes(categoryId);
  if (!defs.length) {
    // The category declares nothing. Accepting arbitrary keys here is what would let the
    // tile-shaped columns leak back in through the side door, so they are dropped.
    return { attributes: {}, dropped: Object.keys(raw || {}), applied: [] };
  }

  const byKey = new Map(defs.map((d) => [d.key, d]));
  const attributes = {};
  const dropped = [];
  const applied = [];

  for (const [key, value] of Object.entries(raw || {})) {
    const def = byKey.get(key);
    if (!def) { dropped.push(key); continue; }
    if (isBlank(value)) continue;               // absent is handled by the required check
    attributes[key] = coerceValue(def, value);
    applied.push(key);
  }

  if (!partial) {
    const missing = defs
      .filter((d) => d.required && isBlank(attributes[d.key]))
      .map((d) => d.label || d.key);
    if (missing.length) {
      throw fail(422, `Missing required attribute${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
    }
  }

  return { attributes, dropped, applied };
}

/** The definitions for a category, for the admin form to render. */
export async function definitionsForCategory(categoryId, { filterableOnly = false } = {}) {
  if (!categoryId) return [];
  return effectiveAttributes(categoryId, { filterableOnly });
}

/**
 * Turn a `?attr.<key>=<value>` query into a Mongo filter on `attributes.<key>`.
 *
 * Deliberately additive and forgiving: an unknown key is ignored rather than rejected,
 * so a stale bookmarked filter URL degrades to "no filter" instead of an error page.
 * Multi-value keys become `$in`, which is what the storefront filter rail sends when a
 * customer ticks two options in the same group.
 */
export async function buildAttributeFilter(categoryId, query = {}) {
  const defs = await definitionsForCategory(categoryId);
  if (!defs.length) return {};

  const byKey = new Map(defs.map((d) => [d.key, d]));
  const filter = {};

  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (!rawKey.startsWith('attr.')) continue;
    const key = rawKey.slice(5);
    const def = byKey.get(key);
    if (!def || isBlank(rawValue)) continue;

    const values = String(rawValue).split(',').map((v) => v.trim()).filter(Boolean);
    if (def.type === 'number') {
      const nums = values.map(Number).filter(Number.isFinite);
      if (!nums.length) continue;
      filter[`attributes.${key}`] = nums.length === 1 ? nums[0] : { $in: nums };
    } else if (def.type === 'boolean') {
      filter[`attributes.${key}`] = values[0].toLowerCase() === 'true';
    } else if (values.length === 1) {
      filter[`attributes.${key}`] = values[0];
    } else {
      filter[`attributes.${key}`] = { $in: values };
    }
  }
  return filter;
}

/**
 * The option lists the storefront filter rail should show for a category, derived from
 * the definitions flagged `filterable`. Select options come from the definition itself;
 * free-entry types are not offered as filters because their values are unbounded.
 */
export async function filterableOptionsForCategory(categoryId) {
  const defs = await definitionsForCategory(categoryId, { filterableOnly: true });
  return defs
    .filter((d) => ['select', 'multiselect', 'boolean'].includes(d.type))
    .map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.options || [], unit: d.unit || '' }));
}

/** Guard used when creating a definition: the key must be a stable machine name. */
export function assertValidKey(key) {
  const k = String(key || '').trim();
  if (!k) throw fail(422, 'Attribute key is required.');
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(k)) {
    throw fail(422, 'Attribute key must start with a letter and contain only letters, numbers and underscores.');
  }
  // Reserved because they would collide with the real columns on Product.
  const reserved = ['_id', 'itemName', 'category', 'subcategory', 'brand', 'attributes', 'status'];
  if (reserved.includes(k)) throw fail(422, `"${k}" is reserved and cannot be used as an attribute key.`);
  return k;
}

export { Category, AttributeDefinition };
export default {
  normalizeAndValidateAttributes,
  definitionsForCategory,
  buildAttributeFilter,
  filterableOptionsForCategory,
  assertValidKey,
};
