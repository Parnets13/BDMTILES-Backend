import mongoose from 'mongoose';

/**
 * "Shop Tiles by Size" card on the storefront home page.
 * Global content — not branch-scoped. Managed via CRM "Web Management".
 */
const tileSizeItemSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true }, // e.g. 600×600
    sub: { type: String, trim: true, default: 'mm' },    // e.g. mm / mm slab
    image: { type: String, trim: true, default: '' },
    query: { type: String, trim: true, default: '' },    // search term e.g. "600x600 tiles"
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('TileSizeItem', tileSizeItemSchema);
