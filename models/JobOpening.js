import mongoose from 'mongoose';

const jobOpeningSchema = new mongoose.Schema(
  {
    jobCode: { type: String, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    designation: { type: String, required: true, trim: true },
    branch: { type: String, trim: true, default: '' }, // legacy free-text label, mirrors Employee.branch
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    positions: { type: Number, default: 1, min: 1 },
    employmentType: { type: String, enum: ['Full Time', 'Part Time', 'Contract', 'Daily Wage'], default: 'Full Time' },
    experienceRequired: { type: String, trim: true, default: '' }, // free text, e.g. "2-4 years"
    description: { type: String, trim: true, default: '' },
    requirements: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['open', 'on_hold', 'closed'], default: 'open' },
    postedDate: { type: Date, default: Date.now },
    closingDate: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

jobOpeningSchema.statics.generateJobCode = async function () {
  const last = await this.findOne().sort({ createdAt: -1 }).select('jobCode').lean();
  if (last?.jobCode) {
    const num = parseInt(last.jobCode.replace(/\D/g, '')) || 0;
    return `JOB${String(num + 1).padStart(4, '0')}`;
  }
  return 'JOB0001';
};

jobOpeningSchema.index({ branchId: 1, status: 1 });
jobOpeningSchema.index({ title: 'text', department: 'text', designation: 'text' });

export default mongoose.model('JobOpening', jobOpeningSchema);
