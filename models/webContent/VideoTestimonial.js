import mongoose from 'mongoose';

/**
 * Video testimonial card on the storefront "Customers love BDM TILES" section.
 * Separate from the photo testimonial (Testimonial model) so each can be
 * managed independently. Global content — not branch-scoped.
 */
const videoTestimonialSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    badge: { type: String, trim: true, default: '' },
    badgeColor: { type: String, trim: true, default: '' }, // hex bg for badge pill
    quote: { type: String, required: true, trim: true },   // short text shown on the card
    caption: { type: String, trim: true, default: '' },    // text shown below the card
    thumbnail: { type: String, trim: true, default: '' },  // poster image shown behind the play button
    videoUrl: { type: String, required: true, trim: true },// YouTube / Vimeo / direct URL
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('VideoTestimonial', videoTestimonialSchema);
