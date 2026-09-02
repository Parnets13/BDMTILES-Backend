import mongoose from 'mongoose';

const complaintEvidenceSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    url: { type: String, required: true, unique: true },
    originalName: { type: String, default: '' },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['uploaded', 'attached'], default: 'uploaded', index: true },
    complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint' },
    attachedAt: Date,
  },
  { timestamps: true }
);

complaintEvidenceSchema.index({ branch: 1, uploadedBy: 1, status: 1, createdAt: -1 });
complaintEvidenceSchema.index({ branch: 1, complaint: 1 });

export default mongoose.model('ComplaintEvidence', complaintEvidenceSchema);
