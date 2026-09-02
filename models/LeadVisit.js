import mongoose from 'mongoose';

const locationSchema = new mongoose.Schema({
  address: { type: String, trim: true, default: '' },
  latitude: { type: Number, min: -90, max: 90 },
  longitude: { type: Number, min: -180, max: 180 },
}, { _id: false });

const transitionSchema = new mongoose.Schema({
  from: String,
  to: { type: String, required: true },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: String,
  remarks: String,
}, { _id: false });

const leadVisitSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['scheduled', 'travelling', 'arrived', 'attending', 'completed', 'cancelled', 'no_show'],
      default: 'scheduled',
    },
    scheduledAt: { type: Date, required: true },
    startedTravellingAt: Date,
    arrivedAt: Date,
    attendingAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    noShowAt: Date,
    location: { type: locationSchema, default: () => ({}) },
    remarks: { type: String, trim: true, default: '' },
    attachments: [{ type: String, trim: true }],
    outcome: { type: String, trim: true, default: '' },
    nextAction: { type: String, trim: true, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    transitions: { type: [transitionSchema], default: [] },
  },
  { timestamps: true }
);

leadVisitSchema.index({ branch: 1, lead: 1, scheduledAt: -1 });
leadVisitSchema.index({ branch: 1, assignedTo: 1, status: 1 });

export default mongoose.model('LeadVisit', leadVisitSchema);
