import mongoose from 'mongoose';

const followupSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  notes: String,
  nextFollowupDate: Date,
  outcome: { type: String, enum: ['interested', 'not_interested', 'callback', 'converted', 'no_response'], default: 'callback' },
  doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

const leadSchema = new mongoose.Schema(
  {
    leadNumber: { type: String, unique: true, required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: String,
    businessName: String,
    city: String,
    address: String,
    source: { type: String, enum: ['walk_in', 'referral', 'online', 'cold_call', 'exhibition', 'social_media', 'other'], default: 'other' },
    interestedIn: [String], // product categories
    estimatedValue: { type: Number, default: 0 },
    priority: { type: String, enum: ['low', 'medium', 'high', 'hot'], default: 'medium' },
    status: {
      type: String,
      enum: ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'won', 'lost', 'on_hold'],
      default: 'new',
    },
    lostReason: String,
    followups: [followupSchema],
    nextFollowupDate: Date,
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    convertedToDealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    convertedAt: Date,
    remarks: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

leadSchema.index({ leadNumber: 1 });
leadSchema.index({ status: 1, nextFollowupDate: 1 });
leadSchema.index({ assignedTo: 1 });

export default mongoose.model('Lead', leadSchema);
