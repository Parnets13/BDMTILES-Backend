import mongoose from 'mongoose';

/**
 * Storefront customer testimonial (BDM Tiles website home page).
 * Global content — not branch-scoped. Managed via the CRM "Web Management" module.
 */
const testimonialSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    image: { type: String, trim: true, default: '' },
    videoUrl: { type: String, trim: true, default: '' }, // optional video shown behind the play button
    badge: { type: String, trim: true, default: '' },
    badgeColor: { type: String, trim: true, default: '' }, // hex background for the badge
    quote: { type: String, required: true, trim: true },
    caption: { type: String, trim: true, default: '' },
    rating: { type: Number, min: 0, max: 5, default: 5 },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('Testimonial', testimonialSchema);
