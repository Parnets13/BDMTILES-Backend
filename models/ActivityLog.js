import mongoose from 'mongoose';

/**
 * ActivityLog — Complete audit trail for every action in the system.
 * Auto-deletes after 60 days via MongoDB TTL index.
 * Tracks: create, update, delete, restore, view, download, login, logout, access
 */
const activityLogSchema = new mongoose.Schema(
  {
    // Optional only for audit rows created before branch context was introduced.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String, default: '' },
    userRole: { type: String, default: '' },

    action: {
      type: String,
      enum: ['create', 'update', 'delete', 'restore', 'permanent_delete',
             'view', 'download', 'login', 'logout', 'access',
             'approve', 'reject', 'status_change', 'bulk_update'],
      required: true,
    },

    module: {
      type: String,
      required: true,
      // e.g. 'product', 'sales_order', 'purchase_order', 'payment',
      // 'dealer', 'supplier', 'employee', 'stock', 'quotation', etc.
    },

    // What was affected
    recordId: { type: mongoose.Schema.Types.ObjectId },
    recordTitle: { type: String, default: '' }, // e.g. "SO-00045", "Product: Milano 600x600"
    recordModel: { type: String, default: '' }, // e.g. 'SalesOrder', 'Product'

    // Details of what changed (for updates)
    changes: [{
      field: String,
      oldValue: mongoose.Schema.Types.Mixed,
      newValue: mongoose.Schema.Types.Mixed,
    }],

    // Additional context
    description: { type: String, default: '' }, // Human-readable: "Created sales order SO-00045"
    metadata: { type: mongoose.Schema.Types.Mixed }, // Any extra data

    // Request info
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    device: { type: String, default: '' }, // 'web', 'mobile', 'api'

    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false } // We use our own timestamp field
);

// TTL index: auto-delete logs older than 60 days
activityLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

// Branch-scoped query indexes. Keep the TTL index above single-field.
activityLogSchema.index({ branch: 1, timestamp: -1 });
activityLogSchema.index({ branch: 1, user: 1, timestamp: -1 });
activityLogSchema.index({ branch: 1, module: 1, timestamp: -1 });
activityLogSchema.index({ branch: 1, action: 1, timestamp: -1 });
activityLogSchema.index({ branch: 1, recordId: 1 });

export default mongoose.model('ActivityLog', activityLogSchema);
