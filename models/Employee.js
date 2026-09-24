import mongoose from 'mongoose';
import MasterSequence from './MasterSequence.js';

const employeeSchema = new mongoose.Schema(
  {
    empId: { type: String, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    fatherName: { type: String, trim: true, default: '' },
    designation: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    dateOfJoining: { type: Date, required: true },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: ['Male', 'Female', 'Other'], default: 'Male' },
    mobile: { type: String, required: true, trim: true },
    alternateMobile: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    emergencyContact: { type: String, trim: true, default: '' },

    // Identity
    aadhaar: { type: String, trim: true, default: '' },
    pan: { type: String, trim: true, uppercase: true, default: '' },
    uan: { type: String, trim: true, default: '' },
    esiNumber: { type: String, trim: true, default: '' },

    // Bank Details
    bankName: { type: String, trim: true, default: '' },
    accountNumber: { type: String, trim: true, default: '' },
    ifscCode: { type: String, trim: true, uppercase: true, default: '' },
    accountHolderName: { type: String, trim: true, default: '' },

    // Employment
    employmentType: { type: String, enum: ['Full Time', 'Part Time', 'Contract', 'Daily Wage'], default: 'Full Time' },
    probationEndDate: { type: Date },
    reportingManager: { type: String, trim: true, default: '' },
    // Legacy free-text branch label. Canonical ownership is branchId; existing text is never auto-converted.
    branch: { type: String, trim: true, default: '' },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    workLocation: { type: String, trim: true, default: '' },
    shift: { type: String, trim: true, default: 'General' },

    // Salary
    salaryType: { type: String, enum: ['Monthly', 'Daily'], default: 'Monthly' },
    basicSalary: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    conveyance: { type: Number, default: 0 },
    medicalAllowance: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },
    otherAllowance: { type: Number, default: 0 },
    pf: { type: Number, default: 0 },
    esi: { type: Number, default: 0 },
    professionalTax: { type: Number, default: 0 },
    tds: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    grossSalary: { type: Number, default: 0 },
    netSalary: { type: Number, default: 0 },
    dailyWageRate: { type: Number, default: 0 },

    // Attendance
    attendanceType: { type: String, enum: ['GPS', 'Biometric', 'Manual'], default: 'GPS' },

    // Leave
    leaveBalance: {
      casual: { type: Number, default: 12 },
      sick: { type: Number, default: 6 },
      earned: { type: Number, default: 0 },
      unpaid: { type: Number, default: 0 },
    },

    // Status
    status: { type: String, enum: ['Active', 'Inactive', 'On Notice', 'Terminated'], default: 'Active' },
    exitDate: { type: Date },
    exitReason: { type: String, default: '' },

    // Documents
    documents: [{ name: String, url: String, uploadDate: Date }],
    profileImage: { type: String, default: '' },

    // Linked user account (canonical app-access identity)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

// Auto-calculate gross and net salary
employeeSchema.pre('save', function (next) {
  const basic = this.basicSalary || 0;
  const allowances = (this.hra || 0) + (this.conveyance || 0) + (this.medicalAllowance || 0) + (this.specialAllowance || 0) + (this.otherAllowance || 0);
  const deductions = (this.pf || 0) + (this.esi || 0) + (this.professionalTax || 0) + (this.tds || 0) + (this.otherDeductions || 0);
  this.grossSalary = basic + allowances;
  this.netSalary = Math.max(0, this.grossSalary - deductions);
  next();
});

// Auto-generate empId using an atomic sequence counter so concurrent
// requests can never produce the same value (the old findOne+increment
// pattern was non-atomic and caused E11000 duplicate key errors).
employeeSchema.statics.generateEmpId = async function () {
  const seq = await MasterSequence.findOneAndUpdate(
    { key: 'empId' },
    { $inc: { value: 1 } },
    { upsert: true, new: true },
  );
  return `EMP${String(seq.value).padStart(4, '0')}`;
};

employeeSchema.index({ name: 'text', empId: 'text', mobile: 'text' });
employeeSchema.index({ branchId: 1, status: 1, department: 1 });

export default mongoose.model('Employee', employeeSchema);
