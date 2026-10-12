import mongoose from 'mongoose';
import { PRODUCT_OPTION_FIELDS, MAX_OPTION_LENGTH } from '../config/productOptions.js';

/**
 * A value the admin has added to one of the Product Master specification dropdowns — a new
 * tile size, a finish the defaults did not cover, and so on.
 *
 * Only the ADDITIONS are stored. The built-in seeds live in config/productOptions.js, so a
 * default can be corrected in one place without leaving a stale copy per branch in the
 * database. `GET /products/options` merges the two.
 *
 * Scoped to a branch: two branches can sell different finishes, and one branch's addition
 * should not silently appear in another's form.
 */
const productOptionSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    /** Which dropdown this belongs to — must be one of PRODUCT_OPTION_FIELDS. */
    field: { type: String, required: true, trim: true, enum: PRODUCT_OPTION_FIELDS },
    value: { type: String, required: true, trim: true, maxlength: MAX_OPTION_LENGTH },
    /**
     * Lower-cased copy of `value`, used only for the unique index.
     *
     * Mongo's unique index is case-sensitive, so without this "White" and "white" would both be
     * insertable and the dropdown would show the same colour twice.
     */
    valueKey: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

productOptionSchema.index({ branch: 1, field: 1, valueKey: 1 }, { unique: true });

productOptionSchema.pre('validate', function setValueKey(next) {
  if (this.isModified('value') || !this.valueKey) {
    this.valueKey = String(this.value || '').trim().toLowerCase();
  }
  next();
});

export default mongoose.model('ProductOption', productOptionSchema);
