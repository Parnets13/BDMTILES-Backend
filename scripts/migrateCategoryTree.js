/**
 * Migration: fold the three category vocabularies into one tree.
 *
 * Before this runs there are three unrelated lists that all mean "category":
 *   1. `HomeCategory`   — flat storefront cards (Cement, Tiling, Painting …)
 *   2. `Category`       — hung off a Brand (KAJARIA CATEGORY, Dal Kichadi …)
 *   3. `Subcategory`    — hung off a Category
 * After it runs there is one self-referencing `Category` tree:
 *   level 1 = department, level 2 = category, level 3 = subcategory.
 *
 * SAFE BY DEFAULT — prints what it would do and changes nothing. Pass `--apply` to run.
 *   node scripts/migrateCategoryTree.js            # dry run
 *   node scripts/migrateCategoryTree.js --apply    # actually migrate
 *
 * Every step is idempotent, so a re-run after a partial failure is harmless.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ensureSrvResolvable } from '../config/db.js';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log(...a);
const act = (msg) => log(`${APPLY ? '[apply]' : '[dry]  '} ${msg}`);

const Category = (await import('../models/Category.js')).default;
const Subcategory = (await import('../models/Subcategory.js')).default;
const HomeCategory = (await import('../models/webContent/HomeCategory.js')).default;
const { slugify } = await import('../services/categoryTreeService.js');

// A network that refuses SRV queries cannot resolve mongodb+srv://, which would

// stop this script with a confusing ECONNREFUSED. Same fallback the server uses.

await ensureSrvResolvable(process.env.MONGODB_URI);

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

log(`\n=== migrateCategoryTree ${APPLY ? '(APPLYING)' : '(DRY RUN — nothing will change)'} ===\n`);

// ── 1. Backfill level + brands on existing categories ────────────────────────
// The schema default only applies to NEW documents, so rows written before today have
// no `level` at all. Without this they read as level undefined and sort to the top.
const missingLevel = await Category.countDocuments({ level: { $exists: false } });
act(`backfill level:1 on ${missingLevel} categor${missingLevel === 1 ? 'y' : 'ies'}`);
if (APPLY && missingLevel) {
  await Category.updateMany({ level: { $exists: false } }, { $set: { level: 1 } });
}

const missingBrands = await Category.countDocuments({ brands: { $exists: false } });
act(`backfill brands:[] on ${missingBrands} categor${missingBrands === 1 ? 'y' : 'ies'}`);
if (APPLY && missingBrands) {
  await Category.updateMany({ brands: { $exists: false } }, { $set: { brands: [] } });
}

// ── 2. Carry the legacy single brand into the brands[] link ──────────────────
// Not a copy of the category — just moving the one existing brand reference into the
// new many-to-many field so nothing is lost.
const withLegacyBrand = await Category.find({ brand: { $ne: null }, $or: [{ brands: { $size: 0 } }, { brands: { $exists: false } }] }).select('_id name brand').lean();
act(`link legacy brand -> brands[] on ${withLegacyBrand.length} categor${withLegacyBrand.length === 1 ? 'y' : 'ies'}`);
for (const c of withLegacyBrand) log(`         · ${c.name}`);
if (APPLY) {
  for (const c of withLegacyBrand) {
    await Category.updateOne({ _id: c._id }, { $addToSet: { brands: c.brand } });
  }
}

// ── 3. Fold HomeCategory into the tree as level-1 departments ────────────────
// Matched by name so an existing "Painting" is reused rather than duplicated — which
// is exactly the collision that produced three vocabularies in the first place.
const homeCats = await HomeCategory.find({}).lean();
log(`\nHomeCategory rows to fold in: ${homeCats.length}`);
for (const hc of homeCats) {
  const existing = await Category.findOne({ name: hc.name, parent: null }).select('_id').lean();
  if (existing) {
    act(`reuse existing "${hc.name}" — copy display fields (image/badge/sortOrder)`);
    if (APPLY) {
      await Category.updateOne({ _id: existing._id }, {
        $set: {
          image: hc.image || '',
          badge: hc.badge || '',
          sortOrder: hc.sortOrder || 0,
          showOnHome: true,
          ...(hc.slug ? { slug: hc.slug } : {}),
        },
      });
    }
  } else {
    act(`create department "${hc.name}" (level 1, showOnHome)`);
    if (APPLY) {
      await Category.create({
        name: hc.name,
        slug: hc.slug || slugify(hc.name),
        parent: null,
        level: 1,
        brands: [],
        image: hc.image || '',
        badge: hc.badge || '',
        sortOrder: hc.sortOrder || 0,
        showOnHome: true,
        status: hc.status || 'active',
        createdBy: hc.createdBy,
      });
    }
  }
}

// ── 4. Fold Subcategory into the tree as level-3 nodes ───────────────────────
// A subcategory is now just a Category with a parent. Copied rather than moved so the
// old collection stays intact until the routes have been switched over and verified.
const subs = await Subcategory.find({}).populate('category', 'name').lean();
log(`\nSubcategory rows to fold in: ${subs.length}`);
for (const s of subs) {
  if (!s.category) {
    act(`skip "${s.name}" — its parent category no longer exists`);
    continue;
  }
  const existing = await Category.findOne({ name: s.name, parent: s.category._id }).select('_id').lean();
  if (existing) {
    act(`skip "${s.name}" — already present under ${s.category.name}`);
    continue;
  }
  act(`create subcategory "${s.name}" under "${s.category.name}" (level 3)`);
  if (APPLY) {
    await Category.create({
      name: s.name,
      slug: slugify(s.name),
      description: s.description || '',
      parent: s.category._id,
      level: 3,
      brands: s.brand ? [s.brand] : [],
      status: s.status || 'active',
      createdBy: s.createdBy,
    });
  }
}

// ── 5. Backfill slugs ────────────────────────────────────────────────────────
const noSlug = await Category.find({ $or: [{ slug: '' }, { slug: null }, { slug: { $exists: false } }] }).select('_id name').lean();
act(`\nbackfill slug on ${noSlug.length} categor${noSlug.length === 1 ? 'y' : 'ies'}`);
if (APPLY) {
  for (const c of noSlug) {
    await Category.updateOne({ _id: c._id }, { $set: { slug: slugify(c.name) } });
  }
}

// ── 6. Drop the legacy unique index ──────────────────────────────────────────
// `{ name, brand }` unique treats a null brand as a value, so once brand is optional it
// allows only ONE brand-less category per name. That would block legitimate siblings —
// "Others" under Tiles and under Paints could not coexist. Must go.
const idx = (await db.collection('categories').indexes()).find((i) => i.name === 'name_1_brand_1');
log('');
if (idx) {
  act('drop legacy unique index name_1_brand_1 (replaced by parent_1_name_1)');
  if (APPLY) {
    try {
      await db.collection('categories').dropIndex('name_1_brand_1');
      log('         dropped');
    } catch (e) {
      log('         could not drop: ' + e.message);
    }
  }
} else {
  log('[skip]  legacy index already gone');
}

// ── Summary ──────────────────────────────────────────────────────────────────
log('\n=== resulting tree ===');
const all = await Category.find({}).sort({ level: 1, sortOrder: 1, name: 1 }).lean();
const byId = new Map(all.map((c) => [String(c._id), c]));
const childrenOf = (pid) => all.filter((c) => String(c.parent || '') === String(pid || ''));
const walk = (pid, depth) => {
  for (const n of childrenOf(pid)) {
    log('  ' + '    '.repeat(depth) + '- ' + n.name + '  (L' + (n.level ?? '?') + ')');
    walk(n._id, depth + 1);
  }
};
walk(null, 0);
log(`\ntotal Category nodes: ${all.length}`);
log(`HomeCategory still intact: ${await HomeCategory.countDocuments()}   (kept until routes are switched)`);
log(`Subcategory still intact:  ${await Subcategory.countDocuments()}   (kept until routes are switched)`);
if (!APPLY) log('\nDry run only. Re-run with --apply to migrate.');

await mongoose.disconnect();
