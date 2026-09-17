import mongoose from 'mongoose';

/**
 * Storefront "Shop by Category" tile shown on the home page (BDM Tiles website).
 * Global content — not branch-scoped. Managed via the CRM "Web Management" module.
 * `slug` links the card to a storefront category route (/category/:slug).
 */
const homeCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, default: '' },
    image: { type: String, trim: true, default: '' },
    badge: { type: String, trim: true, default: '' },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('HomeCategory', homeCategorySchema);
