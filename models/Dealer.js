import mongoose from 'mongoose';

const dealerSchema = new mongoose.Schema(
  {
    dealerCode: { type: String, unique: true, trim: true },
    businessName: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    mobile: { type: String, required: true, trim: true },
    alternateMobile: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    gstin: { type: String, trim: true, uppercase: true, default: '' },
    pan: { type: String, trim: true, uppercase: true, default: '' },

    // Address
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    deliveryAddress: { type: String, trim: true, default: '' },

    // Classification
    dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },
    dealerCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerCategory' },
    assignedRegion: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
    assignedRoute: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
    assignedSalesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Financial
    creditLimit: { type: Number, default: 0 },
    creditDays: { type: Number, default: 30 },
    openingBalance: { type: Number, default: 0 },
    currentOutstanding: { type: Number, default: 0 },
    paymentTerms: { type: String, trim: true, default: '' },
    priceTier: { type: String, trim: true, default: 'Dealer' },

    // Security
    securityChequeNo: { type: String, trim: true, default: '' },
    securityChequeBank: { type: String, trim: true, default: '' },
    securityChequeAmount: { type: Number, default: 0 },

    // Eligibility
    schemeEligible: { type: Boolean, default: true },
    discountEligible: { type: Boolean, default: true },

    // Documents
    documents: [{ type: { type: String }, url: String, uploadDate: Date }],

    // Status & Tracking
    status: { type: String, enum: ['active', 'inactive', 'blocked'], default: 'active' },
    appAccess: { type: Boolean, default: false },
    lastPurchaseDate: { type: Date },
    lastPaymentDate: { type: Date },
    visitFrequency: { type: String, default: '' },
    geoLocation: { lat: Number, lng: Number },

    // Tally mapping
    tallyLedgerName: { type: String, trim: true, default: '' },
    tallyGUID: { type: String, trim: true, default: '' },
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed', 'tally_created'], default: 'not_synced' },
    tallySyncDate: Date,

    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

dealerSchema.index({ businessName: 'text', ownerName: 'text', mobile: 'text', dealerCode: 'text' });
dealerSchema.index({ status: 1 });
dealerSchema.index({ assignedRegion: 1 });

export default mongoose.model('Dealer', dealerSchema);
