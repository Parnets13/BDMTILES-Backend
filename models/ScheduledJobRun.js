import mongoose from 'mongoose';

const resultSchema = new mongoose.Schema({
  examined: { type: Number, min: 0, default: 0 },
  released: { type: Number, min: 0, default: 0 },
  skippedOwnedPick: { type: Number, min: 0, default: 0 },
  conflicts: { type: Number, min: 0, default: 0 },
  orderIds: { type: [String], default: [] },
  aborted: { type: Boolean, default: false },
}, { _id: false });

const scheduledJobRunSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, immutable: true, trim: true },
  owner: { type: String, required: true, trim: true },
  leaseUntil: { type: Date, required: true, index: true },
  heartbeatAt: { type: Date },
  lastRunStartedAt: { type: Date },
  lastRunFinishedAt: { type: Date },
  lastRunStatus: { type: String, enum: ['never', 'running', 'succeeded', 'failed'], default: 'never' },
  runCount: { type: Number, min: 0, default: 0 },
  successCount: { type: Number, min: 0, default: 0 },
  failureCount: { type: Number, min: 0, default: 0 },
  lastDurationMs: { type: Number, min: 0, default: 0 },
  lastResult: { type: resultSchema, default: () => ({}) },
  lastError: { type: String, trim: true, default: '', maxlength: 4000 },
}, { timestamps: true, minimize: false });

export default mongoose.model('ScheduledJobRun', scheduledJobRunSchema);
