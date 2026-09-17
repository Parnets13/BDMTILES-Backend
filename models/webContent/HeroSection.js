import mongoose from 'mongoose';

/**
 * Storefront hero/banner-carousel slide (BDM Tiles website home page).
 * Global content — not branch-scoped. Managed via the CRM "Web Management" module.
 */
const heroSectionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true, default: '' },
    image: { type: String, trim: true, default: '' }, // /uploads/web/<file> or external URL
    ctaLabel: { type: String, trim: true, default: '' },
    ctaLink: { type: String, trim: true, default: '' },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('HeroSection', heroSectionSchema);
