import mongoose from 'mongoose';

const hrmsSettingsSchema = new mongoose.Schema(
  {
    // Shift timing
    defaultShiftStart: { type: String, default: '09:00' },
    defaultShiftEnd: { type: String, default: '18:00' },
    lunchBreakMinutes: { type: Number, default: 60 },
    graceMinutes: { type: Number, default: 15 },

    // Late mark rules
    lateMarkAfterMinutes: { type: Number, default: 15 },
    halfDayAfterMinutes: { type: Number, default: 120 },
    lateMarksForHalfDay: { type: Number, default: 3 },

    // Overtime rules
    overtimeAfterHours: { type: Number, default: 9 },
    overtimeRateMultiplier: { type: Number, default: 1.5 },
    overtimeEnabled: { type: Boolean, default: true },

    // Week offs
    weeklyOffs: { type: [String], default: ['Sunday'] },

    // Geofencing
    officeLocation: { lat: Number, lng: Number },
    geofenceRadius: { type: Number, default: 200 }, // meters

    // Leave settings
    casualLeavePerYear: { type: Number, default: 12 },
    sickLeavePerYear: { type: Number, default: 6 },
    earnedLeavePerYear: { type: Number, default: 15 },
    leaveAccrualDay: { type: Number, default: 1 }, // day of month

    // Salary settings
    salaryProcessingDay: { type: Number, default: 1 },
    pfPercentage: { type: Number, default: 12 },
    esiPercentage: { type: Number, default: 0.75 },
    esiThreshold: { type: Number, default: 21000 },

    // Alerts
    noPunchAlertTime: { type: String, default: '10:00' },
    sendLateAlerts: { type: Boolean, default: true },
    sendAbsentAlerts: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('HrmsSettings', hrmsSettingsSchema);
