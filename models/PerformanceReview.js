import mongoose from 'mongoose';

/**
 * One appraisal per employee per review period.
 *
 * The automatic part of the score is always recomputed server-side from live
 * data when a review is created; the client never supplies the numbers. What the
 * client does supply is the manager's judgement (rating, narrative, PIP,
 * promotion), which no aggregation can produce.
 *
 * Each component is stored with `measurable` and, when false, `excludedReason`.
 * That matters: an employee with no linked app account has no sales attribution
 * at all, and scoring them zero on sales would read as poor performance rather
 * than as an absence of data. Unmeasurable components are dropped and the
 * remaining weights renormalised to 100.
 */

export const PERFORMANCE_COMPONENTS = [
  { key: 'attendance',    label: 'Attendance & Punctuality', weight: 25, source: 'Attendance records' },
  { key: 'sales',         label: 'Sales Target',             weight: 20, source: 'Sales orders vs target rule' },
  { key: 'collections',   label: 'Collection Target',        weight: 15, source: 'Confirmed receipts vs target rule' },
  { key: 'visits',        label: 'Visit Target',             weight: 10, source: 'Completed dealer visits vs target rule' },
  { key: 'tasks',         label: 'Task Completion',          weight: 10, source: 'Assigned tasks' },
  { key: 'managerRating', label: 'Manager Rating',           weight: 20, source: 'Manual, 1–10' },
];

const componentSchema = new mongoose.Schema({
  key:    { type: String, required: true },
  label:  { type: String, required: true },
  weight: { type: Number, required: true },
  measurable: { type: Boolean, default: true },
  excludedReason: { type: String, trim: true, default: '' },

  targetValue:   { type: Number, default: 0 },
  achievedValue: { type: Number, default: 0 },
  achievementPercent: { type: Number, default: 0 },
  // 0–1 before weighting, so the weighting maths is inspectable.
  ratio: { type: Number, default: 0 },
  // Weight after renormalising across the measurable components.
  effectiveWeight: { type: Number, default: 0 },
  points: { type: Number, default: 0 },
  detail: { type: String, trim: true, default: '' },
}, { _id: false, timestamps: false });

const performanceReviewSchema = new mongoose.Schema(
  {
    branch:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, trim: true, default: '' },
    empId:        { type: String, trim: true, default: '' },
    designation:  { type: String, trim: true, default: '' },
    department:   { type: String, trim: true, default: '' },

    periodFrom:  { type: Date, required: true },
    periodTo:    { type: Date, required: true },
    periodLabel: { type: String, trim: true, default: '' },

    components: [componentSchema],

    // Manager judgement
    managerRating: { type: Number, min: 1, max: 10 },
    strengths:     { type: String, trim: true, default: '' },
    improvements:  { type: String, trim: true, default: '' },
    managerRemarks:{ type: String, trim: true, default: '' },

    totalScore: { type: Number, default: 0, min: 0, max: 100 },
    grade:      { type: String, enum: ['A+', 'A', 'B', 'C', 'D', 'E', 'NA'], default: 'NA' },
    // Sum of the weights that actually counted, before renormalisation. A review
    // scored on 45 of 100 available weight is far weaker evidence than one scored
    // on all of it, and the UI has to be able to say so.
    measuredWeight: { type: Number, default: 0 },
    excludedComponents: [{ type: String }],

    performanceImprovementPlan: {
      required:   { type: Boolean, default: false },
      objectives: { type: String, trim: true, default: '' },
      reviewDate: { type: Date },
      closedAt:   { type: Date },
      outcome:    { type: String, enum: ['open', 'met', 'not_met', 'withdrawn'], default: 'open' },
    },

    promotionRecommended: { type: Boolean, default: false },
    promotionRemarks:     { type: String, trim: true, default: '' },
    incrementRecommended: { type: Number, default: 0 },   // percentage

    status: {
      type: String,
      enum: ['draft', 'submitted', 'acknowledged'],
      default: 'draft',
      index: true,
    },
    reviewedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByName: { type: String, trim: true, default: '' },
    submittedAt:    { type: Date },
    acknowledgedAt: { type: Date },
    acknowledgementRemarks: { type: String, trim: true, default: '' },

    computedAt: { type: Date },
    warnings:   [{ type: String }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

performanceReviewSchema.index({ branch: 1, employee: 1, periodFrom: -1 });
performanceReviewSchema.index({ branch: 1, status: 1, periodTo: -1 });

export default mongoose.model('PerformanceReview', performanceReviewSchema);
