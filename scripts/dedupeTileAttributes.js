/**
 * Remove the Tiles attribute definitions that duplicate the dedicated tile block.
 *
 * The Product form has a purpose-built Tiles section (Tile Size, Finish, Surface, Pcs/Box,
 * the SqFt/Box auto-calculation …). The taxonomy seed ALSO declared the same fields as
 * attributes on Tiles, so selecting Tiles rendered every one of them twice — once in the
 * tile block and once in the Specifications card.
 *
 * Checked before writing this: all 11 Tiles attributes overlap the legacy block exactly,
 * and NONE of them is unique to the attribute set. So removing them loses nothing —
 * the tile block still collects the same values, and the storefront still filters on them
 * via the legacy tile arrays in /shop/products/filter-options.
 *
 * Tiles therefore keeps its dedicated block; every OTHER vertical uses attribute definitions,
 * which is the split the form now enforces.
 *
 * SAFE BY DEFAULT:
 *   node scripts/dedupeTileAttributes.js            # report only
 *   node scripts/dedupeTileAttributes.js --apply    # remove them
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ensureSrvResolvable } from '../config/db.js';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log(...a);

const Category = (await import('../models/Category.js')).default;
const AttributeDefinition = (await import('../models/AttributeDefinition.js')).default;
const Product = (await import('../models/Product.js')).default;

/** Keys the dedicated tile block on the form already collects. */
const LEGACY_TILE_KEYS = [
  'tileSize', 'finish', 'colour', 'surface', 'thickness', 'grade', 'tileType',
  'applicationArea', 'antiSkidRating', 'countryOfOrigin', 'waterAbsorption',
  'breakingStrength', 'manufacturer', 'barcode', 'design', 'collection',
  'piecesPerBox', 'sqftPerBox', 'weightPerBox',
  // The seeded attribute is called `size`; the legacy column is `tileSize`. Same thing.
  'size',
];

// A network that refuses SRV queries cannot resolve mongodb+srv://, which would

// stop this script with a confusing ECONNREFUSED. Same fallback the server uses.

await ensureSrvResolvable(process.env.MONGODB_URI);

await mongoose.connect(process.env.MONGODB_URI);

log(`\n=== dedupeTileAttributes ${APPLY ? '(APPLYING)' : '(DRY RUN)'} ===\n`);

const tiles = await Category.findOne({ name: 'Tiles', level: 1 }).select('_id name').lean();
if (!tiles) {
  log('No "Tiles" category found. Nothing to do.');
  await mongoose.disconnect();
  process.exit(0);
}

const defs = await AttributeDefinition.find({ category: tiles._id }).lean();
log(`Tiles declares ${defs.length} attribute definition(s).`);

const toRemove = defs.filter((d) => LEGACY_TILE_KEYS.includes(d.key));
const toKeep = defs.filter((d) => !LEGACY_TILE_KEYS.includes(d.key));

log(`\nDuplicating the tile block (${toRemove.length}):`);
for (const d of toRemove) log(`  · ${d.key.padEnd(20)} ${d.label}`);
log(`\nUnique to the attribute set (${toKeep.length}):`);
for (const d of toKeep) log(`  · ${d.key.padEnd(20)} ${d.label}`);
if (!toKeep.length) log('  (none — removing these loses no field the tile block does not already cover)');

// A stored value would be orphaned if any product already used one of these keys.
const inUse = await Product.countDocuments({ $or: toRemove.map((d) => ({ [`attributes.${d.key}`]: { $exists: true } })) });
log(`\nProducts storing a value under one of these keys: ${inUse}`);
if (inUse > 0) {
  log('  Those values would be orphaned. Re-run after checking, or keep the definitions.');
}

if (!APPLY) {
  log('\nDry run only. Re-run with --apply to remove them.');
  await mongoose.disconnect();
  process.exit(0);
}

if (inUse > 0) {
  log('\nRefusing to remove: products still store values under these keys.');
  await mongoose.disconnect();
  process.exit(1);
}

const res = await AttributeDefinition.deleteMany({ _id: { $in: toRemove.map((d) => d._id) } });
log(`\nRemoved ${res.deletedCount} duplicate definition(s).`);
log(`Tiles now declares ${await AttributeDefinition.countDocuments({ category: tiles._id })} — its fields come from the tile block.`);
log(`Total attribute definitions remaining: ${await AttributeDefinition.countDocuments()}`);

await mongoose.disconnect();
