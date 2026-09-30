import mongoose from 'mongoose';

/**
 * Declares one attribute that products in a category carry.
 *
 * Why this exists: a single Product schema cannot honestly describe tiles and cement
 * at once — tiles need size/finish/surface, cement needs grade/pack size/setting time.
 * Adding a column per vertical does not survive nineteen of them.
 *
 * So instead of columns, each category declares its own attributes here. One row per
 * attribute per category. The admin Product form renders exactly the fields a category
 * declares, and the storefront filter rail shows only the ones flagged `filterable`.
 * A new vertical is then data entry, not a schema change.
 *
 * Definitions on a parent category are inherited by its children, so "Tiles" declares
 * `finish` once and every tile subcategory picks it up.
 */
const attributeDefinitionSchema = new mongoose.Schema(
  {
    // The category (or department) this attribute belongs to. Children inherit it.
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },

    // `key` is the stable machine name stored on Product.attributes — never rename it
    // once products use it, or their values become unreachable. `label` is what the
    // admin and the storefront show, and is safe to reword at any time.
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },

    type: {
      type: String,
      enum: ['select', 'multiselect', 'text', 'number', 'boolean'],
      default: 'text',
    },
    // Allowed values for select / multiselect. Empty for free-entry types.
    options: [{ type: String, trim: true }],

    // Unit of measure for display only, e.g. 'mm', 'kg', 'sqft'. The stored value stays
    // a bare number so range filters and comparisons keep working.
    unit: { type: String, trim: true, default: '' },

    // Show this attribute as a filter on the storefront. Deliberately separate from
    // `required` — plenty of attributes are worth filling in but not worth filtering on.
    filterable: { type: Boolean, default: false },

    // Set when the value is produced by a calculation rather than typed (see the frontend's
    // utils/productCalculations.js). The product form renders these read-only and hides them
    // from the Specifications list, so they appear once, as the calculated result.
    // It exists mainly so the backend ACCEPTS the key: anything not declared here is dropped
    // on save, which would silently discard every computed value.
    calculated: { type: Boolean, default: false },
    required: { type: Boolean, default: false },

    // Shown under the field in the admin form.
    help: { type: String, trim: true, default: '' },

    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One definition per key per category. Guards against two "Finish" fields on one category,
// which would make the form ambiguous and the stored value unpredictable.
attributeDefinitionSchema.index({ category: 1, key: 1 }, { unique: true });
attributeDefinitionSchema.index({ category: 1, status: 1, sortOrder: 1 });
// The storefront asks "which filters apply to this category" on every category page.
attributeDefinitionSchema.index({ category: 1, filterable: 1 });

export default mongoose.model('AttributeDefinition', attributeDefinitionSchema);
