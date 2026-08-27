import mongoose from 'mongoose';

/**
 * RecycleBin — stores deleted records for 30 days.
 * User can restore or permanently delete.
 * Auto-deletes after 30 days via TTL index.
 */
const recycleBinSchema = new mongoose.Schema(
  {
    // Optional only for recycle rows created before branch context was introduced.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    // What was deleted
    originalModel: { type: String, required: true }, // 'Product', 'SalesOrder', 'Dealer', etc.
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    recordTitle: { type: String, default: '' }, // Display name: "SO-00045", "Product: XYZ"
    recordCode: { type: String, default: '' }, // Code: "SO-00045", "BDM000123"

    // Full snapshot of the deleted document
    data: { type: mongoose.Schema.Types.Mixed, required: true },

    // Who deleted it
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedByName: { type: String, default: '' },
    deleteReason: { type: String, default: '' },

    // Module/category for filtering
    module: { type: String, default: '' }, // 'product', 'sales_order', 'dealer', etc.

    deletedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// TTL: auto-permanently-delete after 30 days
recycleBinSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Branch-scoped query indexes. Keep the TTL index above single-field.
recycleBinSchema.index({ branch: 1, deletedAt: -1 });
recycleBinSchema.index({ branch: 1, module: 1, deletedAt: -1 });
recycleBinSchema.index({ branch: 1, originalModel: 1, deletedAt: -1 });
recycleBinSchema.index({ branch: 1, deletedBy: 1, deletedAt: -1 });

export default mongoose.model('RecycleBin', recycleBinSchema);
