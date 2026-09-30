import mongoose from 'mongoose';

/**
 * DEPRECATED — superseded by the self-referencing tree on `Category`.
 *
 * A subcategory is now simply a level-3 `Category` node. Keeping it in one collection
 * means the admin tree, the storefront navigation and the attribute inheritance all walk
 * the same structure, instead of two collections that have to be joined by hand.
 *
 * This model is left in place, unremoved, so nothing that still imports it breaks during
 * the migration. Do not create new documents here. The migration script
 * (`scripts/migrateCategoryTree.js`) copies every row into `Category` as level 3 and
 * repoints `Product.subcategory` at the new node.
 *
 * `brand` is relaxed to optional in the meantime, because a subcategory that belongs to
 * one brand is the same defect that produced the legacy "KAJARIA CATEGORY" row.
 */
const subcategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    // Legacy: no longer required, and no longer how brands relate to taxonomy.
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

subcategorySchema.index({ name: 1, category: 1 }, { unique: true });
subcategorySchema.index({ name: 'text', description: 'text' });
subcategorySchema.index({ brand: 1 });

export const DEPRECATED = true;
export default mongoose.model('Subcategory', subcategorySchema);
