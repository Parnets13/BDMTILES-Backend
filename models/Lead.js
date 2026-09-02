import mongoose from 'mongoose';

const followupSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  notes: String,
  nextFollowupDate: Date,
  outcome: { type: String, enum: ['interested', 'not_interested', 'callback', 'converted', 'no_response', 'visit_scheduled', 'quotation_sent'], default: 'callback' },
  doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  doneByName: String,
});

const assignmentHistorySchema = new mongoose.Schema({
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedToName: String,
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedByName: String,
  assignedAt: { type: Date, default: Date.now },
  response: { type: String, enum: ['pending', 'accepted', 'declined', 'reassigned', 'timeout'], default: 'pending' },
  respondedAt: Date,
  endedAt: Date,
  endReason: { type: String, enum: ['reassigned', 'declined', 'timeout', 'closed'] },
  declineReason: String,
  seStatus: String, // SE's status at time of assignment
});

const leadSchema = new mongoose.Schema(
  {
    leadNumber: { type: String, unique: true, required: true },
    // Optional for legacy records; all new writes set the selected branch server-side.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    // Customer Info
    name: { type: String, required: true },
    phone: { type: String, required: true },
    alternatePhone: String,
    email: String,
    businessName: String,
    city: String,
    state: String,
    address: String,
    pinCode: String,

    // Legacy capture value retained for backward compatibility.
    customerType: {
      type: String,
      enum: ['walk_in', 'phone_enquiry', 'referral', 'online_enquiry', 'whatsapp', 'exhibition', 'architect_referral', 'dealer_referral', 'google_ads', 'facebook', 'instagram', 'existing_customer', 'other'],
      default: 'walk_in',
    },
    leadSource: { type: String, trim: true, default: '' },
    leadChannel: {
      type: String,
      enum: ['', 'store_visit', 'phone', 'whatsapp', 'online', 'referral', 'exhibition', 'social', 'other'],
      default: '',
    },
    leadType: { type: String, trim: true, default: '' },
    campaign: { type: String, trim: true, default: '' },
    referredBy: String, // name of person who referred

    // Interest
    interestedIn: [String], // product categories/brands
    interestedProducts: [String], // specific product names/codes
    estimatedArea: { type: Number, default: 0 }, // sqft
    estimatedValue: { type: Number, default: 0 },
    projectType: { type: String, enum: ['residential', 'commercial', 'hospitality', 'industrial', 'renovation', 'other'], default: 'residential' },

    // Priority & Status
    priority: { type: String, enum: ['low', 'medium', 'high', 'hot'], default: 'medium' },
    status: {
      type: String,
      enum: ['new', 'assigned', 'accepted', 'contacted', 'qualified', 'proposal_sent', 'negotiation', 'site_visit', 'won', 'lost', 'on_hold'],
      default: 'new',
    },
    lostReason: String,

    // SE Assignment — current
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: String,
    assignmentStatus: { type: String, enum: ['unassigned', 'pending', 'accepted', 'declined', 'reassigned'], default: 'unassigned' },
    assignedAt: Date,
    acceptanceDeadlineAt: Date,
    assignmentVersion: { type: Number, default: 0, min: 0 },
    acceptedAt: Date,
    declinedAt: Date,
    declineReason: String,

    // Assignment History (tracks all assignments/reassignments)
    assignmentHistory: [assignmentHistorySchema],

    // Follow-ups
    followups: [followupSchema],
    nextFollowupDate: Date,
    lastContactDate: Date,
    totalFollowups: { type: Number, default: 0 },

    // Conversion
    convertedToDealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    convertedToCustomer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    convertedAt: Date,
    conversionValue: { type: Number, default: 0 }, // actual order value

    // Incentive Tracking
    incentiveEligible: { type: Boolean, default: false },
    incentiveAmount: { type: Number, default: 0 },
    incentiveStatus: { type: String, enum: ['pending', 'earned', 'no_rule'], default: 'pending' },
    incentiveEarning: { type: mongoose.Schema.Types.ObjectId, ref: 'IncentiveEarning' },
    incentivePaid: { type: Boolean, default: false },
    incentivePaidDate: Date,

    // Quotation linked
    quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
    quotationNumber: String,

    // Metadata
    remarks: String,
    tags: [String],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: String,
  },
  { timestamps: true }
);

leadSchema.index({ branch: 1, status: 1, nextFollowupDate: 1 });
leadSchema.index({ branch: 1, assignedTo: 1, assignmentStatus: 1 });
leadSchema.index({ branch: 1, customerType: 1 });
leadSchema.index({ branch: 1, createdAt: -1 });
leadSchema.index({ branch: 1, assignmentStatus: 1, createdAt: -1 }); // branch queue

export default mongoose.model('Lead', leadSchema);
