import mongoose from 'mongoose';

/**
 * "Shop Tiles by Room" card on the storefront home page.
 * Global content — not branch-scoped. Managed via CRM "Web Management".
 */
const tileRoomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },     // e.g. Living Room
    icon: { type: String, trim: true, default: 'fa-couch' }, // Font Awesome icon name
    image: { type: String, trim: true, default: '' },
    query: { type: String, trim: true, default: '' },        // search term e.g. "floor tiles"
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('TileRoom', tileRoomSchema);
