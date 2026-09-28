import mongoose from 'mongoose';
import { normalizeDealerMobile } from './Dealer.js';

/**
 * DealerEmployee — an employee / salesperson created by a dealer, who signs in
 * to the Dealer App with their own mobile number.
 *
 * This is deliberately NOT the HRMS `Employee` model. An HRMS Employee is on the
 * BDMTILES payroll; a DealerEmployee belongs to a dealer and can only ever act
 * inside that dealer's account. Keeping them separate means a dealer creating
 * staff can never appear in payroll, attendance or salary runs.
 *
 * Login identity
 *   The employee's `mobileNormalized` is the Dealer App login key, exactly like
 *   `Dealer.mobileNormalized`. It is unique across the WHOLE system — not just
 *   across one dealer's employees — because the login screen only receives a
 *   mobile number and has to resolve it to exactly one principal. See
 *   services/mobileIdentityService.js, which is the guard that enforces this
 *   across Dealer, DealerEmployee, User and HRMS Employee.
 */

const appDeviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, trim: true },
    deviceName: { type: String, default: '', trim: true },
    platform: { type: String, default: '', trim: true },
    osVersion: { type: String, default: '', trim: true },
    appVersion: { type: String, default: '', trim: true },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const dealerEmployeeSchema = new mongoose.Schema(
  {
    // ── Ownership ────────────────────────────────────────────────────────────
    // The dealer account this employee belongs to. Every query in the dealer
    // app is scoped by this field, so it is the security boundary.
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true, index: true },

    // Dealer-scoped employee code (EMP-0001 within that dealer, not globally).
    employeeCode: { type: String, trim: true, default: '' },

    // ── Identity ─────────────────────────────────────────────────────────────
    name: { type: String, required: true, trim: true },
    mobile: { type: String, required: true, trim: true },
    // Digits-only last-10 login key. Globally unique — see the index below.
    mobileNormalized: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    designation: { type: String, trim: true, default: '' },
    joiningDate: { type: Date },
    profileImage: { type: String, default: '' },

    // ── Status ───────────────────────────────────────────────────────────────
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    // The dealer can create an employee record without letting them sign in yet.
    // Both this AND status must be active for a login to succeed.
    loginEnabled: { type: Boolean, default: false },

    // ── Access model ─────────────────────────────────────────────────────────
    role: {
      type: String,
      enum: ['manager', 'salesperson', 'accountant', 'viewer', 'custom'],
      default: 'salesperson',
    },
    // Mirrors User.permissionMode. `role_default` follows the live preset so
    // BDMTILES changing a preset updates every employee on it; `custom` uses the
    // stored list verbatim.
    permissionMode: { type: String, enum: ['role_default', 'custom'], default: 'role_default' },
    permissions: { type: [String], default: [] },

    // ── Assignment ───────────────────────────────────────────────────────────
    // The dealer's own words for the patch this employee covers ("Whitefield,
    // Sarjapur Road"). Free text on purpose: a dealer knows their area by name,
    // not by BDMTILES's internal taxonomy. Shown on the team list.
    assignedArea: { type: String, trim: true, default: '' },

    // RESERVED — not used by anything yet.
    //
    // These pointed at BDMTILES's Region/Route master data, which was the wrong
    // abstraction: a dealer employee works inside the dealer's own territory
    // (already recorded on the Dealer via `assignedRegion` / `assignedRoute`), so
    // asking the dealer to restate it per employee was redundant, and picking from
    // an internal taxonomy the dealer does not own produced data nothing read.
    // They were removed from the form. Kept on the schema so a future territory
    // feature can populate them without a migration — do not surface them in a UI
    // until something actually reads them.
    assignedRegion: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
    assignedRoute: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },

    // RESERVED — see the note on `assignedCustomers` above.
    assignedCustomers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],

    // ── App authentication (mirrors Dealer) ──────────────────────────────────
    pinHash: { type: String, default: null, select: false },
    biometricEnabled: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    appLastLoginAt: { type: Date },
    appDevices: { type: [appDeviceSchema], default: [] },

    // Bumped whenever the dealer resets access, so a "reset" is visible in audit.
    accessResetAt: { type: Date },
    accessResetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },

    notes: { type: String, trim: true, maxlength: 500, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
  },
  { timestamps: true },
);

// One employee code per dealer, and only when a code was actually supplied.
dealerEmployeeSchema.index(
  { dealer: 1, employeeCode: 1 },
  { unique: true, partialFilterExpression: { employeeCode: { $type: 'string', $gt: '' } } },
);
dealerEmployeeSchema.index({ dealer: 1, status: 1 });
dealerEmployeeSchema.index({ dealer: 1, createdAt: -1 });
dealerEmployeeSchema.index({ name: 'text', employeeCode: 'text', mobile: 'text' });

/**
 * The global login key.
 *
 * Unique across every dealer employee in the system, not per dealer. The login
 * screen resolves a bare mobile number to one principal, so two employees on two
 * different dealer accounts sharing a number would make that resolution
 * ambiguous — the exact conflict this index exists to prevent.
 */
dealerEmployeeSchema.index(
  { mobileNormalized: 1 },
  { unique: true, partialFilterExpression: { mobileNormalized: { $type: 'string', $gt: '' } } },
);

dealerEmployeeSchema.pre('save', function normalizeMobileHook(next) {
  if (this.isModified('mobile') || !this.mobileNormalized) {
    this.mobileNormalized = normalizeDealerMobile(this.mobile);
  }
  next();
});

/**
 * Next employee code for a dealer, e.g. `EMP-0001`.
 *
 * Scoped to the dealer so two dealers both start at EMP-0001 — the code is a
 * label the dealer recognises, not a global identifier.
 */
dealerEmployeeSchema.statics.generateEmployeeCode = async function (dealerId) {
  const prefix = 'EMP-';
  const last = await this.findOne({
    dealer: dealerId,
    employeeCode: { $regex: `^${prefix}\\d+$` },
  })
    .sort({ employeeCode: -1 })
    .select('employeeCode')
    .lean();

  const next = last?.employeeCode
    ? (Number.parseInt(last.employeeCode.slice(prefix.length), 10) || 0) + 1
    : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
};

export default mongoose.model('DealerEmployee', dealerEmployeeSchema);
