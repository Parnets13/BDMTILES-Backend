import mongoose from 'mongoose';

/**
 * "Shop by Tile Type" card on the storefront home page.
 * Global content — not branch-scoped. Managed via CRM "Web Management".
 */
const tileTypeItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },   // e.g. Vitrified Tiles
    desc: { type: String, trim: true, default: '' },      // e.g. GVT / PGVT floor tiles
    image: { type: String, trim: true, default: '' },
    query: { type: String, trim: true, default: '' },     // search term
    badge: { type: String, trim: true, default: '' },     // optional badge e.g. Popular / New
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Avoid conflict with the backend Product model's `tileType` string field.
export default mongoose.model('TileTypeItem', tileTypeItemSchema);
