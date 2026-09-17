import mongoose from 'mongoose';

/**
 * Storefront promotional home banner (BDM Tiles website).
 * Global content — not branch-scoped. Managed via the CRM "Web Management" module.
 */
const homeBannerSchema = new mongoose.Schema(
  {
    eyebrow: { type: String, trim: true, default: '' },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true, default: '' },
    image: { type: String, trim: true, default: '' },
    ctaLabel: { type: String, trim: true, default: 'Shop Now' }, // button text
    bgColor: { type: String, trim: true, default: '' },   // card background (hex)
    bgOpacity: { type: Number, min: 0, max: 1, default: 1 }, // background color opacity (0-1)
    textColor: { type: String, trim: true, default: '' }, // text color (hex)
    // Layout size on the website grid: small (1 col), wide (2 cols), full (whole row).
    size: { type: String, enum: ['small', 'wide', 'full'], default: 'small' },
    // Overlay style: 'solid' (flat color) or 'gradient' (color fades to transparent).
    overlayStyle: { type: String, enum: ['solid', 'gradient'], default: 'gradient' },
    // Gradient direction when overlayStyle is 'gradient'.
    gradientDirection: {
      type: String,
      enum: ['to right', 'to left', 'to top', 'to bottom', 'to bottom right', 'to top right'],
      default: 'to right',
    },
    link: { type: String, trim: true, default: '' },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('HomeBanner', homeBannerSchema);
