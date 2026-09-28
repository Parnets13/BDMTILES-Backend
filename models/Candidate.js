import mongoose from 'mongoose';

const interviewSchema = new mongoose.Schema(
  {
    scheduledAt: { type: Date, required: true },
    mode: { type: String, enum: ['in_person', 'phone', 'video'], default: 'in_person' },
    location: { type: String, trim: true, default: '' }, // address, or meeting link for phone/video
    interviewer: { type: String, trim: true, default: '' },
    round: { type: String, trim: true, default: 'Round 1' },
    status: { type: String, enum: ['scheduled', 'completed', 'cancelled', 'no_show'], default: 'scheduled' },
    feedback: { type: String, trim: true, default: '' },
    rating: { type: Number, min: 1, max: 5 },
    scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const candidateSchema = new mongoose.Schema(
  {
    candidateCode: { type: String, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    mobile: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },

    qualification: { type: String, trim: true, default: '' },
    experience: { type: String, trim: true, default: '' }, // free text, e.g. "3 years"
    currentEmployer: { type: String, trim: true, default: '' },
    expectedSalary: { type: Number, default: 0 },
    source: { type: String, enum: ['referral', 'job_portal', 'walk_in', 'social_media', 'consultancy', 'other'], default: 'other' },

    jobOpening: { type: mongoose.Schema.Types.ObjectId, ref: 'JobOpening' },
    branch: { type: String, trim: true, default: '' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    resume: {
      name: { type: String, default: '' },
      url: { type: String, default: '' },
      uploadDate: { type: Date },
    },

    status: {
      type: String,
      enum: ['Applied', 'Shortlisted', 'Interview', 'Selected', 'Rejected'],
      default: 'Applied',
    },
    rejectionReason: { type: String, trim: true, default: '' },

    interviews: [interviewSchema],

    // Talent pool: candidates worth keeping on file for future openings,
    // independent of their pipeline status (e.g. a good-but-not-right-now Rejected
    // candidate, or a Selected one who declined the offer).
    talentPool: { type: Boolean, default: false },
    tags: [{ type: String, trim: true }], // skills/keywords for talent-pool search

    notes: { type: String, trim: true, default: '' },

    convertedToEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    convertedAt: { type: Date },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

candidateSchema.statics.generateCandidateCode = async function () {
  const last = await this.findOne().sort({ createdAt: -1 }).select('candidateCode').lean();
  if (last?.candidateCode) {
    const num = parseInt(last.candidateCode.replace(/\D/g, '')) || 0;
    return `CAND${String(num + 1).padStart(4, '0')}`;
  }
  return 'CAND0001';
};

candidateSchema.index({ branchId: 1, status: 1 });
candidateSchema.index({ branchId: 1, talentPool: 1 });
candidateSchema.index({ jobOpening: 1 });
candidateSchema.index({ name: 'text', mobile: 'text', email: 'text', qualification: 'text', tags: 'text' });

export default mongoose.model('Candidate', candidateSchema);
