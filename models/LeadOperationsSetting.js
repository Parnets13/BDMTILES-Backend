import mongoose from 'mongoose';

const leadOperationsSettingSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true },
    acceptanceDeadlineMinutes: { type: Number, min: 5, max: 1440, default: 30 },
    maxActiveLeads: { type: Number, min: 1, max: 500, default: 10 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('LeadOperationsSetting', leadOperationsSettingSchema);
