import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { ROLE_INFO } from '../config/permissions.js';
import { canonicalPhone } from '../utils/phone.js';

const ASSIGNMENT_SCOPE_VALUES = ['all', 'selected', 'none'];
const assignmentScopesSchema = new mongoose.Schema(
  {
    warehouses: { type: String, enum: ASSIGNMENT_SCOPE_VALUES, default: 'none' },
    regions: { type: String, enum: ASSIGNMENT_SCOPE_VALUES, default: 'none' },
    dealers: { type: String, enum: ASSIGNMENT_SCOPE_VALUES, default: 'none' },
    departments: { type: String, enum: ASSIGNMENT_SCOPE_VALUES, default: 'none' },
    reports: { type: String, enum: ASSIGNMENT_SCOPE_VALUES, default: 'none' },
    employees: { type: String, enum: ASSIGNMENT_SCOPE_VALUES, default: 'none' },
  },
  { _id: false }
);

const refreshSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    jtiHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, required: true, default: Date.now },
    lastUsedAt: { type: Date, required: true, default: Date.now },
    userAgent: { type: String, default: '', maxlength: 500 },
    ip: { type: String, default: '', maxlength: 100 },
  },
  { _id: false }
);

const deactivationSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, trim: true, maxlength: 500, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    dependencySnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const reactivationSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength: 6, select: false },
    phone: { type: String, required: true, trim: true },
    phoneNormalized: { type: String, required: true, select: false },
    role: {
      type: String,
      required: true,
      enum: Object.keys(ROLE_INFO),
      default: 'sales_executive',
    },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    permissions: [String],
    // Legacy users predate permissionMode; treating them as custom preserves stored grants.
    permissionMode: { type: String, enum: ['role_default', 'custom'], default: 'custom' },
    // assignedBranch and assignedWarehouse are retained for compatibility with legacy clients/data.
    assignedBranch: { type: String, trim: true, default: '' },
    assignedBranches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
    defaultBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    assignedWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    assignedWarehouses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' }],
    assignedRegions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Region' }],
    assignedDealers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' }],
    assignedDepartments: [{ type: String, trim: true, maxlength: 100 }],
    assignedReports: [{ type: String, trim: true }],
    assignedEmployees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
    assignmentScopes: { type: assignmentScopesSchema, default: () => ({}) },
    lastLogin: Date,
    joinDate: { type: Date, default: Date.now },
    fcmToken: String,
    passwordChangedAt: Date,
    tokenVersion: { type: Number, default: 0, min: 0 },
    failedLoginAttempts: { type: Number, default: 0, min: 0 },
    loginLockedUntil: Date,
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    refreshSessions: { type: [refreshSessionSchema], select: false, default: [] },
    mustChangePassword: { type: Boolean, default: false },
    deactivation: { type: deactivationSchema, default: undefined },
    lastReactivation: { type: reactivationSchema, default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

userSchema.index({ role: 1, status: 1 });
userSchema.index({ assignedBranches: 1, status: 1 });
userSchema.index({ assignedWarehouses: 1, status: 1 });
userSchema.index({ defaultBranch: 1 });
userSchema.index(
  { phoneNormalized: 1 },
  {
    unique: true,
    name: 'unique_normalized_user_phone',
    partialFilterExpression: { phoneNormalized: { $type: 'string' } },
  }
);

userSchema.pre('validate', function (next) {
  if (!this.isModified('phone') && this.phoneNormalized) return next();
  const normalized = canonicalPhone(this.phone);
  if (!normalized) return next(new Error('Enter a valid phone number using digits and standard phone formatting.'));
  this.phoneNormalized = normalized;
  return next();
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordChangedAt = new Date();
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

export default mongoose.model('User', userSchema);
