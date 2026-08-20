import mongoose from 'mongoose';

/**
 * Expense — Employee expense claims with approval workflow.
 * Categories: Travel, Fuel, Phone, Lodging, Food, Office, Loading, Unloading,
 * Vehicle Repair, Warehouse, Marketing, Staff Welfare, Courier, Misc
 */
const expenseSchema = new mongoose.Schema(
  {
    expenseNumber: { type: String, unique: true, required: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeName: String,
    department: String,

    // Expense details
    category: {
      type: String,
      enum: ['travel', 'fuel', 'phone', 'lodging', 'food', 'office', 'loading', 'unloading',
             'vehicle_repair', 'warehouse', 'marketing', 'staff_welfare', 'courier', 'miscellaneous'],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    expenseDate: { type: Date, required: true },
    description: { type: String, required: true },

    // Reference
    dealerRef: { type: String, default: '' },  // if expense is for a dealer visit
    tripRef: { type: String, default: '' },    // trip/dispatch reference

    // Evidence
    billUpload: [String],  // bill/receipt image URLs
    photoUpload: [String], // additional photos
    gpsLocation: { lat: Number, lng: Number },

    // Approval
    approvalManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'reimbursed', 'cancelled'],
      default: 'pending',
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    rejectionReason: String,
    reimbursementDate: Date,
    reimbursementRef: String, // payment reference

    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

expenseSchema.index({ expenseNumber: 1 });
expenseSchema.index({ employee: 1, status: 1 });
expenseSchema.index({ status: 1, expenseDate: -1 });

export default mongoose.model('Expense', expenseSchema);
