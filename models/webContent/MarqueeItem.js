import mongoose from 'mongoose';

/**
 * Scrolling top-bar (marquee) item on the storefront — the right-to-left strip
 * with "Pay on Delivery", "Free Delivery", etc.
 * Global content — not branch-scoped. Managed via the CRM "Web Management" module.
 */
const marqueeItemSchema = new mongoose.Schema(
  {
    icon: { type: String, trim: true, default: 'fa-circle-check' }, // Font Awesome icon name
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true, default: '' },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('MarqueeItem', marqueeItemSchema);
