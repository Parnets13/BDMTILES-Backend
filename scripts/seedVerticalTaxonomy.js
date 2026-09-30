/**
 * Seed the 19-vertical taxonomy: departments, categories, subcategories and attributes.
 *
 * Without this the catalogue only knows about tiles. With it, every department the client
 * sells has a home for a product, and each declares the attributes its products carry —
 * which is what drives both the admin Product form and the storefront filter rail.
 *
 * SAFE BY DEFAULT — validates and prints the plan, changes nothing. Pass `--apply` to run.
 *   node scripts/seedVerticalTaxonomy.js            # dry run
 *   node scripts/seedVerticalTaxonomy.js --apply    # actually seed
 *
 * Idempotent: matched by name within a parent, so re-running never duplicates a node or
 * an attribute. Safe to run again after adding a new department to the data file.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ensureSrvResolvable } from '../config/db.js';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const log = (...a) => console.log(...a);
const act = (msg) => log(`${APPLY ? '[apply]' : '[dry]  '} ${msg}`);

const Category = (await import('../models/Category.js')).default;
const AttributeDefinition = (await import('../models/AttributeDefinition.js')).default;
const User = (await import('../models/User.js')).default;
const { VERTICAL_TAXONOMY } = await import('../data/verticalTaxonomy.js');
const { slugify } = await import('../services/categoryTreeService.js');

const VALID_TYPES = ['select', 'multiselect', 'text', 'number', 'boolean'];
const RESERVED_KEYS = ['_id', 'itemName', 'category', 'subcategory', 'brand', 'attributes', 'status', 'name'];

/**
 * Validate the whole data file before touching the database.
 *
 * Catches the mistakes that would otherwise surface as a broken admin form: a select with
 * no options, a duplicate key in one scope, a reserved key that would shadow a real column.
 * Returns a list of problems rather than throwing, so every issue is reported at once.
 */
function validate(taxonomy) {
  const problems = [];
  const deptNames = new Set();

  for (const dept of taxonomy) {
    if (!dept.name?.trim()) { problems.push('a department has no name'); continue; }
    if (deptNames.has(dept.name)) problems.push(`duplicate department name: ${dept.name}`);
    deptNames.add(dept.name);

    const checkAttrs = (attrs, scope) => {
      const seen = new Set();
      for (const a of attrs || []) {
        if (!a.key?.trim()) { problems.push(`${scope}: attribute with no key`); continue; }
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(a.key)) problems.push(`${scope}: bad key "${a.key}"`);
        if (RESERVED_KEYS.includes(a.key)) problems.push(`${scope}: reserved key "${a.key}"`);
        if (seen.has(a.key)) problems.push(`${scope}: duplicate key "${a.key}"`);
        seen.add(a.key);
        if (!a.label?.trim()) problems.push(`${scope}.${a.key}: missing label`);
        if (!VALID_TYPES.includes(a.type)) problems.push(`${scope}.${a.key}: bad type "${a.type}"`);
        if (['select', 'multiselect'].includes(a.type) && !(a.options || []).length) {
          problems.push(`${scope}.${a.key}: ${a.type} needs options`);
        }
        if ((a.options || []).length && new Set(a.options).size !== a.options.length) {
          problems.push(`${scope}.${a.key}: duplicate options`);
        }
      }
    };

    checkAttrs(dept.attributes, dept.name);

    const catNames = new Set();
    for (const cat of dept.categories || []) {
      if (!cat.name?.trim()) { problems.push(`${dept.name}: a category has no name`); continue; }
      if (catNames.has(cat.name)) problems.push(`${dept.name}: duplicate category "${cat.name}"`);
      catNames.add(cat.name);
      checkAttrs(cat.attributes, `${dept.name} > ${cat.name}`);

      const subNames = new Set();
      for (const sub of cat.subcategories || []) {
        if (!sub?.trim()) { problems.push(`${dept.name} > ${cat.name}: empty subcategory`); continue; }
        if (subNames.has(sub)) problems.push(`${dept.name} > ${cat.name}: duplicate subcategory "${sub}"`);
        subNames.add(sub);
      }
    }
  }
  return problems;
}

log(`\n=== seedVerticalTaxonomy ${APPLY ? '(APPLYING)' : '(DRY RUN — nothing will change)'} ===\n`);

// ── 1. Validate ──────────────────────────────────────────────────────────────
const problems = validate(VERTICAL_TAXONOMY);
if (problems.length) {
  log(`VALIDATION FAILED — ${problems.length} problem(s):`);
  for (const p of problems) log('  · ' + p);
  log('\nNothing was written. Fix the data file and run again.');
  process.exit(1);
}

const totals = VERTICAL_TAXONOMY.reduce((acc, d) => ({
  depts: acc.depts + 1,
  cats: acc.cats + (d.categories || []).length,
  subs: acc.subs + (d.categories || []).reduce((n, c) => n + (c.subcategories || []).length, 0),
  attrs: acc.attrs + (d.attributes || []).length
    + (d.categories || []).reduce((n, c) => n + (c.attributes || []).length, 0),
}), { depts: 0, cats: 0, subs: 0, attrs: 0 });

log('VALIDATION PASSED\n');
log('Plan:');
log(`  departments            ${totals.depts}`);
log(`  categories             ${totals.cats}`);
log(`  subcategories          ${totals.subs}`);
log(`  attribute definitions  ${totals.attrs}`);
log(`  total tree nodes       ${totals.depts + totals.cats + totals.subs}\n`);

// ── Rollback ─────────────────────────────────────────────────────────────────
// Removes exactly the nodes this data file declares, deepest first, so a seed can be
// undone without touching anything an admin created by hand. Only runs with --rollback.
if (ROLLBACK) {
  // A network that refuses SRV queries cannot resolve mongodb+srv://, which would
  // stop this script with a confusing ECONNREFUSED. Same fallback the server uses.
  await ensureSrvResolvable(process.env.MONGODB_URI);
  await mongoose.connect(process.env.MONGODB_URI);
  log('\n=== ROLLING BACK the seeded taxonomy ===\n');
  let removedNodes = 0;
  let removedAttrs = 0;

  for (const dept of VERTICAL_TAXONOMY) {
    const deptDoc = await Category.findOne({ name: dept.name, parent: null });
    if (!deptDoc) continue;

    for (const cat of dept.categories || []) {
      const catDoc = await Category.findOne({ name: cat.name, parent: deptDoc._id });
      if (!catDoc) continue;

      for (const sub of cat.subcategories || []) {
        const subDoc = await Category.findOne({ name: sub, parent: catDoc._id });
        if (subDoc) {
          removedAttrs += (await AttributeDefinition.deleteMany({ category: subDoc._id })).deletedCount;
          await Category.deleteOne({ _id: subDoc._id });
          removedNodes += 1;
        }
      }
      removedAttrs += (await AttributeDefinition.deleteMany({ category: catDoc._id })).deletedCount;
      await Category.deleteOne({ _id: catDoc._id });
      removedNodes += 1;
    }
    removedAttrs += (await AttributeDefinition.deleteMany({ category: deptDoc._id })).deletedCount;
    await Category.deleteOne({ _id: deptDoc._id });
    removedNodes += 1;
  }

  log(`  nodes removed      ${removedNodes}`);
  log(`  attributes removed ${removedAttrs}`);
  log(`\n  remaining categories: ${await Category.countDocuments()}`);
  log(`  remaining attributes: ${await AttributeDefinition.countDocuments()}`);
  await mongoose.disconnect();
  process.exit(0);
}

if (!APPLY) {
  log('Departments that would be created or reused:');
  for (const d of VERTICAL_TAXONOMY) {
    const catCount = (d.categories || []).length;
    const subCount = (d.categories || []).reduce((n, c) => n + (c.subcategories || []).length, 0);
    const attrCount = (d.attributes || []).length
      + (d.categories || []).reduce((n, c) => n + (c.attributes || []).length, 0);
    log(`  · ${d.name.padEnd(26)} ${String(catCount).padStart(2)} cat  ${String(subCount).padStart(3)} sub  ${String(attrCount).padStart(3)} attrs`);
  }
  log('\nDry run only. Re-run with --apply to seed.');
  process.exit(0);
}

// ── 2. Apply ─────────────────────────────────────────────────────────────────
// A network that refuses SRV queries cannot resolve mongodb+srv://, which
// would stop this script with a confusing ECONNREFUSED. Same fallback the server uses.
await ensureSrvResolvable(process.env.MONGODB_URI);
await mongoose.connect(process.env.MONGODB_URI);

const admin = await User.findOne({ role: { $in: ['super_admin', 'owner', 'admin'] } }).select('_id').lean();
if (!admin) {
  log('No admin user found to attribute the seed to. Create one first.');
  process.exit(1);
}

const stats = { depts: 0, cats: 0, subs: 0, attrs: 0, reused: 0 };

/**
 * Find a node by name within a parent, or create it.
 * Returns `{ doc, created }` so the caller can report what was genuinely new rather than
 * counting every node it touched.
 */
async function upsertNode({ name, parent, level, extra = {} }) {
  const existing = await Category.findOne({ name, parent: parent || null });
  if (existing) {
    // Refresh the display fields from the data file without disturbing anything else.
    const patch = {};
    for (const k of ['image', 'badge', 'sortOrder', 'showOnHome']) {
      if (extra[k] !== undefined && existing[k] !== extra[k]) patch[k] = extra[k];
    }
    // Backfill a missing systemKey (rows seeded before it existed). Never overwrite one
    // that is already set — it is the stable identifier and must not drift.
    if (extra.systemKey && !existing.systemKey) patch.systemKey = extra.systemKey;
    if (Object.keys(patch).length) await Category.updateOne({ _id: existing._id }, { $set: patch });
    return { doc: existing, created: false };
  }
  const created = await Category.create({
    name,
    slug: await uniqueSlug(name, parent),
    parent: parent || null,
    level,
    brands: [],
    status: 'active',
    createdBy: admin._id,
    ...extra,
  });
  return { doc: created, created: true };
}

async function uniqueSlug(name, parent) {
  const base = slugify(name) || 'category';
  let candidate = base;
  for (let i = 0; i < 50; i += 1) {
    const clash = await Category.findOne({ slug: candidate, parent: parent || null }).select('_id').lean();
    if (!clash) return candidate;
    candidate = `${base}-${i + 2}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ── Filterability default ────────────────────────────────────────────────────
// Only BOUNDED types can be offered as a storefront filter. A free-text field has unbounded
// values and a bare number is not usefully filtered by equality, so both default to false —
// otherwise the filter rail fills with fields nobody can tick. The data file can still opt
// one in explicitly with `filterable: true`.
const FILTERABLE_TYPES = ['select', 'multiselect', 'boolean'];

/** Create any attribute definition that does not already exist on this node. */
async function seedAttributes(categoryId, attrs, scopeLabel) {
  if (!attrs?.length) return;
  const existing = new Set(
    (await AttributeDefinition.find({ category: categoryId }).select('key').lean()).map((d) => d.key),
  );
  let order = existing.size;
  for (const a of attrs) {
    if (existing.has(a.key)) continue;
    await AttributeDefinition.create({
      category: categoryId,
      key: a.key,
      label: a.label,
      type: a.type,
      options: a.options || [],
      unit: a.unit || '',
      filterable: a.filterable !== undefined ? a.filterable : FILTERABLE_TYPES.includes(a.type),
      // Calculated outputs are produced by the form, not typed, and never filtered on.
      calculated: Boolean(a.calculated),
      required: Boolean(a.required),
      help: a.help || '',
      sortOrder: order,
      status: 'active',
      createdBy: admin._id,
    });
    order += 1;
    stats.attrs += 1;
  }
}

for (const dept of VERTICAL_TAXONOMY) {
  const deptResult = await upsertNode({
    name: dept.name,
    parent: null,
    level: 1,
    extra: {
      systemKey: dept.systemKey,
      badge: dept.badge || '',
      showOnHome: Boolean(dept.showOnHome),
      sortOrder: VERTICAL_TAXONOMY.indexOf(dept),
    },
  });
  const deptDoc = deptResult.doc;
  if (deptResult.created) stats.depts += 1; else stats.reused += 1;
  log(`[apply] ${dept.name}`);
  await seedAttributes(deptDoc._id, dept.attributes, dept.name);

  for (const cat of dept.categories || []) {
    const catResult = await upsertNode({ name: cat.name, parent: deptDoc._id, level: 2 });
    const catDoc = catResult.doc;
    if (catResult.created) stats.cats += 1; else stats.reused += 1;
    await seedAttributes(catDoc._id, cat.attributes, `${dept.name} > ${cat.name}`);

    for (const sub of cat.subcategories || []) {
      const subResult = await upsertNode({ name: sub, parent: catDoc._id, level: 3 });
      if (subResult.created) stats.subs += 1; else stats.reused += 1;
    }
  }
}

// ── 3. Summary ───────────────────────────────────────────────────────────────
log('\n=== result ===');
log(`  departments created   ${stats.depts}`);
log(`  categories created    ${stats.cats}`);
log(`  subcategories created ${stats.subs}`);
log(`  attributes created    ${stats.attrs}`);
log(`  nodes reused          ${stats.reused}  (already present, not duplicated)`);

const counts = await Promise.all([
  Category.countDocuments({ level: 1 }),
  Category.countDocuments({ level: 2 }),
  Category.countDocuments({ level: 3 }),
  AttributeDefinition.countDocuments(),
]);
log('\n  live totals now: departments=' + counts[0] + ' categories=' + counts[1]
  + ' subcategories=' + counts[2] + ' attributes=' + counts[3]);

log('\n  system keys (the stable identifiers the app matches on):');
const keyed = await Category.find({ systemKey: { $exists: true, $ne: null } }).select('name systemKey').sort({ sortOrder: 1 }).lean();
for (const d of keyed) log('    · ' + d.systemKey.padEnd(24) + d.name);
log('  ' + keyed.length + ' of ' + VERTICAL_TAXONOMY.length + ' departments have one');

log('\n  storefront-facing departments (showOnHome):');
const homeDepts = await Category.find({ level: 1, showOnHome: true }).select('name').sort({ sortOrder: 1 }).lean();
for (const d of homeDepts) log('    · ' + d.name);

await mongoose.disconnect();
