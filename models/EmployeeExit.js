import mongoose from 'mongoose';

/**
 * One separation case per exit event. The Employee record only ever holds the
 * *outcome* (`status`, `exitDate`, `exitReason`); everything about how the exit
 * was arrived at — notice period, approval, departmental clearance, the money
 * settled and the exit interview — lives here so it stays auditable after the
 * employee is terminated.
 *
 * Deliberately NOT a replacement for `POST /hrms/employees/:id/exit`. That call
 * is still the only thing that terminates an employee and revokes app access;
 * this document drives it and records why.
 */

export const EXIT_CLEARANCE_ITEMS = [
  { key: 'handover',      label: 'Work handover to reporting manager', owner: 'Reporting Manager' },
  { key: 'asset_return',  label: 'Company assets returned',            owner: 'Admin / Assets' },
  { key: 'finance_dues',  label: 'Loans, advances and dues recovered', owner: 'Finance' },
  { key: 'it_access',     label: 'System and app access removal',      owner: 'IT' },
  { key: 'hr_documents',  label: 'HR documents collected and issued',  owner: 'HR' },
  { key: 'exit_interview',label: 'Exit interview conducted',           owner: 'HR' },
];

const clearanceItemSchema = new mongoose.Schema({
  key:   { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },
  owner: { type: String, trim: true, default: '' },
  // `waived` exists because real exits are sometimes signed off with a known gap
  // (e.g. an asset written off); forcing it to "cleared" would hide that.
  status: { type: String, enum: ['pending', 'cleared', 'blocked', 'waived'], default: 'pending' },
  remarks:       { type: String, trim: true, default: '' },
  clearedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  clearedByName: { type: String, trim: true, default: '' },
  clearedAt:     { type: Date },
}, { _id: true, timestamps: false });

const employeeExitSchema = new mongoose.Schema(
  {
    branch:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    // Denormalised so a closed case still reads correctly in lists.
    employeeName: { type: String, trim: true, default: '' },
    empId:        { type: String, trim: true, default: '' },
    designation:  { type: String, trim: true, default: '' },
    department:   { type: String, trim: true, default: '' },
    dateOfJoining:{ type: Date },

    exitType: {
      type: String,
      enum: ['resignation', 'termination', 'retirement', 'absconding', 'contract_end'],
      default: 'resignation',
      required: true,
    },
    reason:       { type: String, trim: true, required: true },
    reasonCategory: {
      type: String,
      enum: ['better_opportunity', 'compensation', 'relocation', 'personal', 'health',
        'work_environment', 'career_change', 'performance', 'misconduct', 'other'],
      default: 'other',
    },

    // ── Notice period ────────────────────────────────────────────────
    resignationDate:        { type: Date, required: true },
    noticePeriodDays:       { type: Number, default: 30, min: 0 },
    requestedLastWorkingDay:{ type: Date },
    // What HR actually agreed to. Notice can be waived or shortened, so the
    // approved date is a separate fact from the requested one.
    approvedLastWorkingDay: { type: Date },
    noticeWaived:           { type: Boolean, default: false },
    noticeShortfallDays:    { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['pending_approval', 'approved', 'in_clearance', 'settled', 'completed', 'rejected', 'withdrawn'],
      default: 'pending_approval',
      index: true,
    },

    approval: {
      by:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byName:   { type: String, trim: true, default: '' },
      at:       { type: Date },
      remarks:  { type: String, trim: true, default: '' },
      decision: { type: String, enum: ['approved', 'rejected'], default: undefined },
    },

    clearance: [clearanceItemSchema],

    // ── Full and final settlement ────────────────────────────────────
    // Every figure is stored with the basis it was computed on, because a
    // settlement has to be defensible months later when the inputs have moved.
    settlement: {
      computedAt:   { type: Date },
      computedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      perDayBasis:  { type: String, trim: true, default: '' },
      perDayRate:   { type: Number, default: 0 },

      payableDays:        { type: Number, default: 0 },
      pendingSalary:      { type: Number, default: 0 },
      leaveEncashmentDays:{ type: Number, default: 0 },
      leaveEncashment:    { type: Number, default: 0 },
      pendingIncentive:   { type: Number, default: 0 },
      gratuity:           { type: Number, default: 0 },
      otherEarnings:      { type: Number, default: 0 },

      loanOutstanding:     { type: Number, default: 0 },
      advanceOutstanding:  { type: Number, default: 0 },
      noticeShortfallDeduction: { type: Number, default: 0 },
      unreturnedAssetValue:{ type: Number, default: 0 },
      otherDeductions:     { type: Number, default: 0 },

      totalEarnings:    { type: Number, default: 0 },
      totalDeductions:  { type: Number, default: 0 },
      netPayable:       { type: Number, default: 0 },

      notes:        { type: String, trim: true, default: '' },
      // Settlement is a two-step: computed, then approved, then paid.
      approvedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      approvedAt:   { type: Date },
      paymentStatus:{ type: String, enum: ['not_computed', 'computed', 'approved', 'paid'], default: 'not_computed' },
      paidAt:       { type: Date },
      paymentRef:   { type: String, trim: true, default: '' },
    },

    exitInterview: {
      conducted:      { type: Boolean, default: false },
      conductedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      conductedByName:{ type: String, trim: true, default: '' },
      date:           { type: Date },
      wouldRehire:    { type: Boolean },
      overallExperience: { type: Number, min: 1, max: 5 },
      feedback:       { type: String, trim: true, default: '' },
      improvementSuggestions: { type: String, trim: true, default: '' },
    },

    // Letters issued through the HR template engine, mirrored here so the case
    // shows what the employee actually walked away with.
    documentsIssued: [{
      documentType: { type: String, trim: true },
      fileName:     { type: String, trim: true },
      issuedAt:     { type: Date, default: Date.now },
      issuedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    }],

    accessRevokedAt: { type: Date },
    completedAt:     { type: Date },
    completedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

employeeExitSchema.index({ branch: 1, status: 1, resignationDate: -1 });
// An employee can exit, be rehired and exit again, so this is not unique — but
// only one case may be open at a time, which the route enforces.
employeeExitSchema.index({ branch: 1, employee: 1, createdAt: -1 });

export default mongoose.model('EmployeeExit', employeeExitSchema);
