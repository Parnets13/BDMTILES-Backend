import mongoose from 'mongoose';

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * One node of the product taxonomy.
 *
 * Shape: Department -> Category -> Subcategory, expressed as a self-referencing tree
 * rather than three collections. A department (the nineteen verticals — Tiles, Cement,
 * Paints & Coatings, Sanitaryware …) is simply a node with no parent. That means adding
 * a fourth level later needs no schema change.
 *
 * Brand is deliberately NOT the parent. It used to be, which forced every brand to own
 * its own copy of "Tiles" — visible in the legacy data as a category literally named
 * "KAJARIA CATEGORY", and "Painting" filed under the brand Kajaria. Instead a category
 * lists the `brands` that carry it, so one "Tiles" record serves Kajaria, Somany and AGL
 * while the attribute definitions and calculation rules are written once.
 *
 * This also carries the storefront card fields (image, badge, sortOrder) that used to live
 * on the separate HomeCategory collection, so there is one vocabulary instead of three.
 */
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, default: '' },

    /**
     * A permanent machine name for categories the system itself depends on — the nineteen
     * verticals seeded by `seedVerticalTaxonomy.js`. Examples: `tiles`, `cement`, `hardware`.
     *
     * Why it exists: the Product form gives Tiles a dedicated field block (with the
     * Pcs/Box → SqFt/Box auto-calculation), and it used to decide that by matching the
     * category NAME. Rename "Tiles" and the block silently disappeared; delete and re-create
     * it and it never came back. A name is a label the admin owns — it is the wrong thing to
     * branch on.
     *
     * Rules:
     *  - Set once, never changed. Not editable in the UI.
     *  - Only system rows have it, so the index is sparse.
     *  - A row carrying one cannot be deleted through the API, so the verticals cannot be
     *    removed by a mis-click. Retiring one is a deliberate scripted operation.
     */
    systemKey: { type: String, trim: true, lowercase: true },

    description: { type: String, trim: true, default: '' },

    // ── The tree ──────────────────────────────────────────────────────────
    // null parent = a department. `level` is denormalised so a query can ask for
    // "only departments" or "only categories" without a recursive walk.
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    level: { type: Number, min: 1, max: 3, default: 1 },

    // ── Brand (many-to-many, not ownership) ───────────────────────────────
    // Which brands carry this category. A link, never a copy.
    brands: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Brand' }],
    // Legacy single-brand field. Retained so existing documents keep loading; the
    // migration folds any value here into `brands` and then stops writing it.
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand' },

    // ── Storefront display (previously on HomeCategory) ───────────────────
    image: { type: String, trim: true, default: '' },
    badge: { type: String, trim: true, default: '' },
    sortOrder: { type: Number, default: 0 },
    // Whether this node appears as a card on the storefront home page.
    showOnHome: { type: Boolean, default: false },

    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

// A name is unique among siblings, not globally — "Others" may exist under both
// Tiles and Paints. Uniqueness on `parent` is what makes that safe.
categorySchema.index({ parent: 1, name: 1 }, { unique: true });
categorySchema.index({ parent: 1, status: 1, sortOrder: 1 });
categorySchema.index({ level: 1, status: 1 });
// Storefront routing resolves a URL slug; sparse because legacy rows have none yet.
categorySchema.index({ slug: 1 }, { sparse: true });
categorySchema.index({ name: 'text', description: 'text' });
// Only the seeded system rows carry a systemKey, so this is sparse. Unique so two rows can
// never claim the same machine name — that would make "which one is Tiles?" ambiguous.
categorySchema.index({ systemKey: 1 }, { unique: true, sparse: true });

/**
 * NOTE FOR THE MIGRATION — the legacy unique index `{ name: 1, brand: 1 }` must be
 * dropped. Once `brand` is optional it treats null as a value, so it would allow only
 * ONE brand-less category per name and block legitimate siblings such as "Others"
 * appearing under two different departments.
 * Mongoose creates new indexes automatically but never drops old ones, so this needs
 * an explicit `db.categories.dropIndex('name_1_brand_1')`.
 */
export const LEGACY_CATEGORY_INDEX = 'name_1_brand_1';

export { slugify as slugifyCategory };
export default mongoose.model('Category', categorySchema);
