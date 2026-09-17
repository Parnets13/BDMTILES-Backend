import mongoose from 'mongoose';

/**
 * DealerVisit — a field visit an executive makes to an assigned dealer.
 * Lifecycle: checked_in -> completed (or cancelled). Mirrors the LeadVisit
 * pattern but scoped to dealers and their route-execution workflow (SOW 18.2).
 */
const locationSchema = new mongoose.Schema({
  address: { type: String, trim: true, default: '' },
  lat: { type: Number, min: -90, max: 90 },
  lng: { type: Number, min: -180, max: 180 },
}, { _id: false });

const transitionSchema = new mongoose.Schema({
  from: String,
  to: { type: String, required: true },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: String,
  remarks: String,
}, { _id: false });

const dealerVisitSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true },
    dealerName: { type: String, default: '' },
    salesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: ['checked_in', 'completed', 'cancelled'],
      default: 'checked_in',
    },

    // Purpose of the visit (order collection, follow-up, complaint, etc.)
    purpose: {
      type: String,
      enum: ['sales', 'collection', 'follow_up', 'complaint', 'relationship', 'new_business', 'other'],
      default: 'sales',
    },

    checkInAt: { type: Date, default: Date.now },
    checkOutAt: Date,
    cancelledAt: Date,
    checkInLocation: { type: locationSchema, default: () => ({}) },
    checkOutLocation: { type: locationSchema, default: () => ({}) },

    durationMinutes: { type: Number, default: 0 },
    notes: { type: String, trim: true, default: '' },
    outcome: { type: String, trim: true, default: '' },
    nextFollowUpDate: Date,
    attachments: [{ type: String, trim: true }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    transitions: { type: [transitionSchema], default: [] },
  },
  { timestamps: true }
);

dealerVisitSchema.index({ branch: 1, salesExecutive: 1, status: 1 });
dealerVisitSchema.index({ branch: 1, dealer: 1, checkInAt: -1 });
dealerVisitSchema.index({ salesExecutive: 1, checkInAt: -1 });
// Enforce at most one open (checked_in) visit per executive, even under
// concurrent check-ins. The route layer catches the resulting E11000 as a 409.
dealerVisitSchema.index(
  { salesExecutive: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'checked_in' } },
);

export default mongoose.model('DealerVisit', dealerVisitSchema);
