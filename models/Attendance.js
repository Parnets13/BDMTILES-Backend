import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: Date, required: true },
    
    // Punch
    punchIn: { type: Date },
    punchOut: { type: Date },
    punchInLocation: { lat: Number, lng: Number, accuracy: Number },
    punchOutLocation: { lat: Number, lng: Number, accuracy: Number },
    punchInSelfie: String,
    punchOutSelfie: String,

    // Status
    status: {
      type: String,
      enum: ['Present', 'Absent', 'Half Day', 'Late', 'Week Off', 'Holiday', 'Leave', 'On Duty'],
      default: 'Absent',
    },
    
    // Calculated
    totalHours: { type: Number, default: 0 },
    overtimeHours: { type: Number, default: 0 },
    lateMinutes: { type: Number, default: 0 },
    earlyExitMinutes: { type: Number, default: 0 },

    // Leave details
    leaveType: String,
    leaveReason: String,

    // Reason captured when the employee punches in past the grace period
    lateReason: { type: String, default: '' },

    // Remarks
    remarks: { type: String, default: '' },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, enum: ['GPS', 'Biometric', 'Manual', 'App'], default: 'Manual' },
  },
  { timestamps: true }
);

attendanceSchema.index({ branch: 1, employee: 1, date: 1 }, { unique: true });
attendanceSchema.index({ branch: 1, date: 1, status: 1 });

export default mongoose.model('Attendance', attendanceSchema);
