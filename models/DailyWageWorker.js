import mongoose from 'mongoose';

/**
 * Daily Wage Worker — tracks casual/contractual labour per day
 */
const dailyWageWorkerSchema = new mongoose.Schema(
  {
    workerName:   { type: String, required: true, trim: true },
    workerPhone:  { type: String, default: '' },
    category:     { type: String, default: 'general', trim: true }, // general, loader, carpenter, etc.
    wagePerDay:   { type: Number, default: 0 },
    department:   { type: String, default: '' },
    isActive:     { type: Boolean, default: true },
    createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

/**
 * Daily Wage Attendance — one record per worker per date
 */
const dailyWageAttendanceSchema = new mongoose.Schema(
  {
    worker:      { type: mongoose.Schema.Types.ObjectId, ref: 'DailyWageWorker', required: true },
    workerName:  { type: String },
    date:        { type: Date, required: true },
    present:     { type: Boolean, default: true },
    hoursWorked: { type: Number, default: 8 },
    wageEarned:  { type: Number, default: 0 },
    remarks:     { type: String, default: '' },
    markedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dailyWageAttendanceSchema.index({ worker: 1, date: 1 }, { unique: true });
dailyWageWorkerSchema.index({ isActive: 1, workerName: 1 });

export const DailyWageWorker     = mongoose.model('DailyWageWorker',     dailyWageWorkerSchema);
export const DailyWageAttendance = mongoose.model('DailyWageAttendance', dailyWageAttendanceSchema);
