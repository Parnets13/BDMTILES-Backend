import mongoose from 'mongoose';

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
    name: { type: String, required: true, trim: true },
    contactNumber: { type: String, required: true, trim: true },
    whatsappNumber: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },

    // GST (optional for retail, required for builders)
    gstin: { type: String, trim: true, uppercase: true, default: '' },
    pan: { type: String, trim: true, uppercase: true, default: '' },

    // Addresses
    billingAddress: { type: String, trim: true, default: '' },
    deliveryAddress: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },

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
customerSchema.index({ assignedSalesExecutive: 1 });

export default mongoose.model('Customer', customerSchema);
