/**
 * One-off: fold the three per-vertical calculated outputs into the single `areaPerUnit` key.
 *
 * They were created as sqftPerSlab / sqftPerSheet / sqftPerUnit — three names for the same idea,
 * and a fourth would have appeared with every new vertical. `areaPerUnit` means "the area of one
 * selling unit", with the per-category label carrying the wording.
 *
 * Refuses to delete a definition any product has actually stored a value under.
 *
 *   node scripts/migrateAreaPerUnit.js            # report only
 *   node scripts/migrateAreaPerUnit.js --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ensureSrvResolvable } from '../config/db.js';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log(...a);

const AttributeDefinition = (await import('../models/AttributeDefinition.js')).default;
const Category = (await import('../models/Category.js')).default;
const Product = (await import('../models/Product.js')).default;

const OLD_KEYS = ['sqftPerSlab', 'sqftPerSheet', 'sqftPerUnit'];
const NEW_KEY = 'areaPerUnit';

// A network that refuses SRV queries cannot resolve mongodb+srv://, which would

// stop this script with a confusing ECONNREFUSED. Same fallback the server uses.

await ensureSrvResolvable(process.env.MONGODB_URI);

await mongoose.connect(process.env.MONGODB_URI);

log(`\n=== migrateAreaPerUnit ${APPLY ? '(APPLYING)' : '(DRY RUN)'} ===\n`);

const old = await AttributeDefinition.find({ key: { $in: OLD_KEYS } }).lean();
log(`Found ${old.length} definition(s) under the old keys:`);
for (const d of old) {
  const cat = await Category.findById(d.category).select('name').lean();
  log(`  · ${d.key.padEnd(16)} ${String(cat?.name || '?').padEnd(22)} ${d.label}`);
}

if (!old.length) {
  log('\nNothing to migrate.');
  await mongoose.disconnect();
  process.exit(0);
}

// Never remove a field a product is actually using.
const inUse = await Product.countDocuments({
  $or: old.map((d) => ({ [`attributes.${d.key}`]: { $exists: true } })),
});
log(`\nProducts storing a value under an old key: ${inUse}`);
if (inUse > 0) {
  log('Refusing — migrate those product values first.');
  await mongoose.disconnect();
  process.exit(1);
}

// The new key must not already exist on the same category, or the seed would skip it and
// the category would end up with the label of whichever landed first.
const existingNew = await AttributeDefinition.find({ key: NEW_KEY }).select('category').lean();
const newOn = new Set(existingNew.map((d) => String(d.category)));
const clashes = old.filter((d) => newOn.has(String(d.category)));
log(`Categories that already have ${NEW_KEY}: ${clashes.length}`);
for (const c of clashes) {
  const cat = await Category.findById(c.category).select('name').lean();
  log(`  · ${cat?.name} (already has ${NEW_KEY}; the old "${c.key}" will just be dropped)`);
}

if (!APPLY) {
  log('\nDry run only. Re-run with --apply, then run the taxonomy seed to create the new key.');
  await mongoose.disconnect();
  process.exit(0);
}

const res = await AttributeDefinition.deleteMany({ _id: { $in: old.map((d) => d._id) } });
log(`\nRemoved ${res.deletedCount} old definition(s).`);
log(`Definitions now: ${await AttributeDefinition.countDocuments()}`);
log(`\nNext: node scripts/seedVerticalTaxonomy.js --apply   (creates ${NEW_KEY})`);

await mongoose.disconnect();
