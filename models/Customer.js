import mongoose from 'mongoose';
import { isValidGstin } from '../utils/gstin.js';

/**
 * Customer Master — for retail, builder, architect, contractor customers
 * Separate from Dealer (dealers have credit, pricing tiers, schemes).
 * Customers are typically walk-in, one-time, or project-based.
 */
const customerSchema = new mongoose.Schema(
  {
    customerCode: { type: String, unique: true, sparse: true, trim: true },
    customerType: {
      type: String,
      enum: ['retail', 'builder', 'architect', 'contractor', 'interior_designer', 'other'],
      default: 'retail',
    },
    // Customer category (Silver/Gold for loyalty/incentive tier)
    customerCategory: {
      type: String,
      enum: ['silver', 'gold', 'platinum'],
      default: 'silver',
    },
    name: { type: String, required: true, trim: true },
    contactNumber: { type: String, required: true, trim: true },
    whatsappNumber: { type: String, trim: true, default: '' },
    // Auto-fill WhatsApp from contactNumber when checkbox is selected
    useContactAsWhatsapp: { type: Boolean, default: false },
    email: { type: String, trim: true, lowercase: true, default: '' },

    // Company details (optional - for business customers)
    companyName: { type: String, trim: true, default: '' },
    companyRegistrationNumber: { type: String, trim: true, default: '' },

    // GST (optional for retail, required for builders)
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      // Optional, but must be a real GSTIN when present — the same rule the
      // Company master uses, so every GST entry point agrees.
      validate: {
        validator: (value) => !value || isValidGstin(value),
        message: 'Enter a valid GST number — 15 characters, e.g. 29ABCDE1234F1Z5.',
      },
    },
    pan: { type: String, trim: true, uppercase: true, default: '' },

    // Addresses with Google Maps location
    billingAddress: { type: String, trim: true, default: '' },
    billingLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: undefined,
      },
    },
    deliveryAddress: { type: String, trim: true, default: '' },
    deliveryLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: undefined,
      },
    },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },

    // Location: Google Maps pin drop for customer location (latitude, longitude)
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: undefined,
      },
      address: { type: String, trim: true, default: '' }, // formatted address from pin
    },

    // Source & Assignment
    source: { type: String, enum: ['walk_in', 'referral', 'online', 'phone', 'whatsapp', 'google_ads', 'facebook', 'exhibition', 'architect_referral', 'other'], default: 'walk_in' },
    assignedSalesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Credit (limited for non-dealers)
    creditLimit: { type: Number, default: 0 },
    creditDays: { type: Number, default: 0 },
    currentOutstanding: { type: Number, default: 0 },

    // Project (for builders/architects)
    projectName: { type: String, trim: true, default: '' },
    projectLocation: { type: String, trim: true, default: '' },
    projectDetails: { type: String, trim: true, default: '' },

    // History tracking
    totalPurchases: { type: Number, default: 0 },
    totalPayments: { type: Number, default: 0 },
    lastPurchaseDate: Date,
    lastPaymentDate: Date,

    // Follow-up
    nextFollowupDate: Date,
    followupNotes: { type: String, default: '' },

    // Visitor tracking: for walk-in customers
    isVisitor: { type: Boolean, default: false },
    visitDate: Date,
    visitNotes: { type: String, trim: true, default: '' },

    // Google Review tracking (incentive for SE/Staff)
    googleReviewLink: { type: String, trim: true, default: '' }, // specific branch review link
    googleReviewSubmitted: { type: Boolean, default: false },
    googleReviewSubmittedDate: Date,
    reviewCollectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // SE/Staff who got the review
    reviewIncentivePaid: { type: Boolean, default: false }, // Whether incentive was paid
    reviewIncentiveAmount: { type: Number, default: 0 }, // Amount paid
    reviewIncentivePaidDate: Date,
    reviewIncentivePaidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Who approved/paid

    // Status
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },

    // Documents
    documents: [{ type: { type: String }, url: String, uploadDate: Date }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

customerSchema.index({ name: 'text', contactNumber: 'text', customerCode: 'text', email: 'text' });
customerSchema.index({ customerType: 1, status: 1 });
customerSchema.index({ customerCategory: 1 });
customerSchema.index({ assignedSalesExecutive: 1 });
customerSchema.index({ 'location.coordinates': '2dsphere' }); // for geo-queries
customerSchema.index({ 'billingLocation.coordinates': '2dsphere' }); // for billing address geo-queries
customerSchema.index({ 'deliveryLocation.coordinates': '2dsphere' }); // for delivery address geo-queries
customerSchema.index({ googleReviewSubmitted: 1, reviewCollectedBy: 1 });

export default mongoose.model('Customer', customerSchema);
