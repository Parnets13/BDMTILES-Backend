import mongoose from 'mongoose';

/**
 * Singleton storefront header/site settings (BDM Tiles website).
 * Global content — not branch-scoped. One document only (enforced by `key`).
 * Managed via the CRM "Web Management → Site Settings" page.
 */
const siteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true }, // singleton guard
    logo: { type: String, trim: true, default: '' },          // /uploads/web/<file> or URL
    brandName: { type: String, trim: true, default: 'BDM TILES' },
    brandTagline: { type: String, trim: true, default: 'BISHNOI CERAMICS' },
    phoneNumber: { type: String, trim: true, default: '' },
    phoneLabel: { type: String, trim: true, default: 'Call us' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('SiteSettings', siteSettingsSchema);
