/**
 * Link the existing products into the new taxonomy, and clear out the legacy rows.
 *
 * After the migration the ten pre-existing categories were promoted to level-1 departments,
 * sitting alongside the nineteen real ones. Three of them still hold products, so the
 * taxonomy currently looks like it has 29 departments when it should have 19.
 *
 * This script reports exactly where every product sits, proposes a home in the real
 * taxonomy, and — only with `--apply` — moves them and removes the emptied legacy rows.
 *
 * SAFE BY DEFAULT:
 *   node scripts/linkProductsToTaxonomy.js                    # report only
 *   node scripts/linkProductsToTaxonomy.js --apply            # move products per MAPPING
 *   node scripts/linkProductsToTaxonomy.js --remove-strays    # delete empty legacy departments
 *   node scripts/linkProductsToTaxonomy.js --apply --remove-strays
 *
 * Removing strays is deliberately a separate flag from moving products, so the two can be
 * done and verified one at a time.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ensureSrvResolvable } from '../config/db.js';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const REMOVE_STRAYS = process.argv.includes('--remove-strays');
const log = (...a) => console.log(...a);
const tag = APPLY || REMOVE_STRAYS ? '[apply]' : '[dry]  ';

const Category = (await import('../models/Category.js')).default;
const Product = (await import('../models/Product.js')).default;
const AttributeDefinition = (await import('../models/AttributeDefinition.js')).default;
const { VERTICAL_TAXONOMY } = await import('../data/verticalTaxonomy.js');

/**
 * REVIEW THIS TABLE.
 *
 * Where each existing product should be filed, as `department > category > subcategory`.
 * The four products are test rows, so these are sensible guesses rather than known-correct
 * placements — confirm them before running with --apply. A name that cannot be resolved is
 * reported and skipped, never guessed at.
 */
const MAPPING = {
  'Ivory Glossy Floor Tile_1785484216394': { department: 'Tiles', category: 'Floor Tiles', subcategory: 'Vitrified' },
  'Ceramic White and Gold Highlighter Walls': { department: 'Tiles', category: 'Wall Tiles', subcategory: 'Highlighter' },
  'product221': { department: 'Tiles', category: 'Floor Tiles', subcategory: 'Ceramic' },
  'Test pp': { department: 'Tiles', category: 'Floor Tiles', subcategory: 'Vitrified' },
};

// A network that refuses SRV queries cannot resolve mongodb+srv://, which would

// stop this script with a confusing ECONNREFUSED. Same fallback the server uses.

await ensureSrvResolvable(process.env.MONGODB_URI);

await mongoose.connect(process.env.MONGODB_URI);

const seededNames = new Set(VERTICAL_TAXONOMY.map((d) => d.name));

// ── 1. Where does everything sit right now? ──────────────────────────────────
log(`\n=== linkProductsToTaxonomy ${APPLY || REMOVE_STRAYS ? '(APPLYING)' : '(DRY RUN)'} ===\n`);

const products = await Product.find({}).select('itemName productCode category subcategory brand').lean();
log(`Products: ${products.length}\n`);

const placement = [];
for (const p of products) {
  const cat = p.category ? await Category.findById(p.category).select('name level parent').lean() : null;
  placement.push({ product: p, cat });
  log(`  ${String(p.itemName).slice(0, 38).padEnd(40)} ${String(p.productCode || '').padEnd(12)}`);
  log(`     currently: ${cat ? `${cat.name} (level ${cat.level})` : '(none)'}`);
  const target = MAPPING[p.itemName];
  log(`     proposed : ${target ? `${target.department} › ${target.category} › ${target.subcategory}` : '(not in MAPPING — left alone)'}`);
}

// ── 2. Which legacy departments are safe to remove? ──────────────────────────
const allDepts = await Category.find({ level: 1 }).select('name').lean();
const strays = allDepts.filter((d) => !seededNames.has(d.name));

log(`\n=== legacy departments (${strays.length}) ===`);
const removable = [];
for (const s of strays) {
  const kids = await Category.find({ parent: s._id }).select('_id name').lean();
  const grandkids = kids.length
    ? await Category.find({ parent: { $in: kids.map((k) => k._id) } }).select('_id').lean()
    : [];
  const ids = [s._id, ...kids.map((k) => k._id), ...grandkids.map((g) => g._id)];
  const held = await Product.countDocuments({ $or: [{ category: { $in: ids } }, { subcategory: { $in: ids } }] });

  const safe = held === 0;
  if (safe) removable.push(s);
  log(`  ${s.name.padEnd(32)} children=${kids.length} grandchildren=${grandkids.length} products=${held}  ${safe ? 'REMOVABLE' : 'kept — holds products'}`);
}

// ── 3. Apply ─────────────────────────────────────────────────────────────────
if (APPLY) {
  log('\n=== moving products ===');
  let moved = 0, skipped = 0;
  for (const { product } of placement) {
    const target = MAPPING[product.itemName];
    if (!target) { skipped += 1; continue; }

    const dept = await Category.findOne({ name: target.department, parent: null }).select('_id').lean();
    const cat = dept ? await Category.findOne({ name: target.category, parent: dept._id }).select('_id').lean() : null;
    const sub = cat && target.subcategory
      ? await Category.findOne({ name: target.subcategory, parent: cat._id }).select('_id').lean()
      : null;

    if (!dept || !cat) {
      log(`  SKIP  ${product.itemName} — could not resolve ${!dept ? target.department : target.category}`);
      skipped += 1;
      continue;
    }

    const update = { category: cat._id };
    // Only set a subcategory when it actually resolved, so a wrong name in the MAPPING
    // leaves the field alone rather than pointing it at nothing.
    if (sub) update.subcategory = sub._id;
    else if (target.subcategory) log(`  NOTE  ${product.itemName} — subcategory "${target.subcategory}" not found, left unset`);

    await Product.updateOne({ _id: product._id }, { $set: update });
    log(`  moved ${product.itemName} -> ${target.department} › ${target.category}${sub ? ' › ' + target.subcategory : ''}`);
    moved += 1;
  }
  log(`  ${moved} moved, ${skipped} skipped`);
}

if (REMOVE_STRAYS) {
  log('\n=== removing empty legacy departments ===');
  let removed = 0;
  for (const s of removable) {
    // Deepest first, so a parent is never blocked by a child that is about to go.
    const kids = await Category.find({ parent: s._id }).select('_id').lean();
    for (const k of kids) {
      const grandkids = await Category.find({ parent: k._id }).select('_id').lean();
      for (const g of grandkids) {
        await AttributeDefinition.deleteMany({ category: g._id });
        await Category.deleteOne({ _id: g._id });
      }
      await AttributeDefinition.deleteMany({ category: k._id });
      await Category.deleteOne({ _id: k._id });
    }
    await AttributeDefinition.deleteMany({ category: s._id });
    await Category.deleteOne({ _id: s._id });
    log(`  removed ${s.name}`);
    removed += 1;
  }
  log(`  ${removed} removed`);
}

// ── 4. Result ────────────────────────────────────────────────────────────────
log('\n=== result ===');
const counts = await Promise.all([
  Category.countDocuments({ level: 1 }),
  Category.countDocuments({ level: 2 }),
  Category.countDocuments({ level: 3 }),
  AttributeDefinition.countDocuments(),
  Product.countDocuments({ category: { $ne: null } }),
]);
log(`  departments ${counts[0]} · categories ${counts[1]} · subcategories ${counts[2]} · attributes ${counts[3]}`);
log(`  products with a category: ${counts[4]} of ${products.length}`);

const deptNames = await Category.find({ level: 1 }).select('name').sort({ name: 1 }).lean();
const stillLegacy = deptNames.filter((d) => !seededNames.has(d.name)).map((d) => d.name);
log(`  legacy departments remaining: ${stillLegacy.length ? stillLegacy.join(', ') : 'none'}`);

if (!APPLY && !REMOVE_STRAYS) log('\nDry run only. Use --apply to move products, --remove-strays to clear the empties.');

await mongoose.disconnect();
