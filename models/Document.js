import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema(
  {
    documentCode: { type: String, unique: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    // Classification
    category: { type: String, enum: ['dealer', 'supplier', 'employee', 'vehicle', 'asset', 'agreement', 'invoice', 'pod', 'expense', 'hr', 'legal', 'other'], default: 'other' },
    tags: [String],

    // File
    fileUrl: { type: String, required: true },
    fileName: { type: String, default: '' },
    fileType: { type: String, default: '' },
    fileSize: { type: Number, default: 0 },

    // Linked entity
    linkedTo: { type: String, enum: ['dealer', 'supplier', 'employee', 'vehicle', 'asset', 'customer', 'order', 'none'], default: 'none' },
    linkedEntityId: { type: mongoose.Schema.Types.ObjectId },
    linkedEntityName: { type: String, default: '' },

    // Expiry tracking
    hasExpiry: { type: Boolean, default: false },
    expiryDate: Date,
    expiryAlertDays: { type: Number, default: 30 },
    expiryAlerted: { type: Boolean, default: false },

    // Version control
    version: { type: Number, default: 1 },
    previousVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },

    // Access control
    accessLevel: { type: String, enum: ['public', 'internal', 'restricted', 'confidential'], default: 'internal' },
    allowedRoles: [String],

    // Status
    status: { type: String, enum: ['active', 'archived', 'expired'], default: 'active' },

    // Audit
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastAccessedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastAccessedAt: Date,
    downloadCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

documentSchema.index({ category: 1, status: 1 });
documentSchema.index({ linkedTo: 1, linkedEntityId: 1 });
documentSchema.index({ expiryDate: 1, hasExpiry: 1 });
documentSchema.index({ tags: 1 });

export default mongoose.model('Document', documentSchema);
