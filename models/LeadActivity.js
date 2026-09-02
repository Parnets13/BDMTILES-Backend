import mongoose from 'mongoose';

const leadActivitySchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    type: {
      type: String,
      enum: ['created', 'assigned', 'accepted', 'declined', 'assignment_timeout', 'updated', 'status_changed', 'followup', 'visit_created', 'visit_transition', 'converted', 'deleted'],
      required: true,
    },
    summary: { type: String, required: true, trim: true },
    fromStatus: String,
    toStatus: String,
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorName: String,
    visit: { type: mongoose.Schema.Types.ObjectId, ref: 'LeadVisit' },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

leadActivitySchema.index({ branch: 1, lead: 1, createdAt: -1 });

const immutable = (next) => next(new Error('Lead activity history is immutable.'));
leadActivitySchema.pre('findOneAndUpdate', immutable);
leadActivitySchema.pre('updateOne', immutable);
leadActivitySchema.pre('updateMany', immutable);
leadActivitySchema.pre('deleteOne', immutable);
leadActivitySchema.pre('deleteMany', immutable);
leadActivitySchema.pre('findOneAndDelete', immutable);

export default mongoose.model('LeadActivity', leadActivitySchema);
