import mongoose from 'mongoose';

// Public-facing job facts. Kept on the same document as the internal opening rather
// than a separate "public listing" model, so the careers site and the HR record can
// never drift apart — the page simply hides what it is not allowed to show.
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

    // ── Public careers-site fields ────────────────────────────────────────────
    // `location` is a display string ("Bengaluru, Karnataka") and deliberately
    // separate from `branch`, which is an internal label and may be blank.
    location: { type: String, trim: true, default: '' },
    jobMode: { type: String, enum: ['On-site', 'Hybrid', 'Remote'], default: 'On-site' },
    // Stored in rupees as plain numbers so salary-band matching in the ATS is a
    // numeric comparison rather than parsing a display string like "₹3.0L – ₹4.5L".
    salaryRange: {
      min: { type: Number, default: 0, min: 0 },
      max: { type: Number, default: 0, min: 0 },
      period: { type: String, enum: ['year', 'month'], default: 'year' },
    },
    // Short chips shown on the public card ("Field sales", "Tiles / Building materials").
    tags: [{ type: String, trim: true }],
    // Opt-in rather than opt-out: an opening stays internal until HR ticks this.
    // Existing documents have no stored value, so read it as `!== false` where the
    // distinction matters, or via the `publicVisible` default below.
    publicVisible: { type: Boolean, default: false },
    // Job-specific ATS keywords. Falls back to keywords mined from `requirements`
    // when empty — see services/atsScoring.js.
    keywords: [{ type: String, trim: true }],

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

/**
 * An opening is publicly listable when it is open, still within its closing date,
 * and HR has explicitly published it.
 *
 * `publicVisible !== false` is not used here: unlike the legacy-tolerant boolean
 * policies elsewhere in this codebase, a job being advertised on a public website is
 * a deliberate act, so absence of the flag must mean "not published". Defaults in the
 * schema cover new documents; this guard covers pre-existing ones that were created
 * before the field existed and therefore have no stored value at all.
 */
jobOpeningSchema.statics.publicFilter = function () {
  const now = new Date();
  return {
    status: 'open',
    publicVisible: true,
    $and: [
      { $or: [{ closingDate: { $exists: false } }, { closingDate: null }, { closingDate: { $gte: now } }] },
    ],
  };
};

jobOpeningSchema.index({ branchId: 1, status: 1 });
jobOpeningSchema.index({ status: 1, publicVisible: 1 });
jobOpeningSchema.index({ title: 'text', department: 'text', designation: 'text', tags: 'text' });

export default mongoose.model('JobOpening', jobOpeningSchema);
