import mongoose from 'mongoose';

const availabilitySchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['available', 'busy', 'attending', 'travelling', 'on_break', 'offline'],
      default: 'offline',
    },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    currentLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    currentVisit: { type: mongoose.Schema.Types.ObjectId, ref: 'LeadVisit', default: null },
    lastSeenAt: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    statusUpdatedAt: { type: Date, default: Date.now },
    assignmentLoad: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

availabilitySchema.index({ branch: 1, user: 1 }, { unique: true });
availabilitySchema.index({ branch: 1, status: 1 });

export default mongoose.model('LeadExecutiveAvailability', availabilitySchema);
