import mongoose from 'mongoose';

const dealerSchema = new mongoose.Schema(
  {
    dealerCode: { type: String, unique: true, trim: true },
    businessName: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    mobile: { type: String, required: true, trim: true },
    // Normalized (digits-only, last 10) form of `mobile` used as the unique login
    // key for the Dealer App. Auto-maintained by a pre-save hook below.
    mobileNormalized: { type: String, trim: true, default: '' },
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
    // Who handled this dealer before, and why it changed. Reassignment moves
    // commission, visits and the chat thread, so the trail matters.
    assignmentHistory: {
      type: [{
        _id: false,
        at: { type: Date, default: Date.now },
        from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        fromName: { type: String, default: '' },
        to: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        toName: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: { type: String, default: '' },
        reason: { type: String, default: '', maxlength: 500 },
      }],
      default: [],
    },

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

    // Dealer App sub-accounts.
    // Whether this dealer may let its own employees sign in to the Dealer App.
    // On by default: an "approved" dealer — active status plus app access, both
    // already enforced by protectDealer — is exactly who this feature is for.
    // BDMTILES can turn it OFF for a specific dealer as a kill switch.
    //
    // Read as `!== false` everywhere, never as a truthy check: dealers created
    // before this field existed have no value stored, and a truthy check would
    // read that absence as "disabled" and lock them all out.
    employeeAccessEnabled: { type: Boolean, default: true },
    // Whether the dealer may grant an employee access to sensitive finance data
    // (ledger, outstanding, credit limit). BDMTILES can switch this off for a
    // dealer, which revokes any finance permission previously granted — see
    // resolveDealerEmployeePermissions in config/dealerPermissions.js.
    allowEmployeeFinanceAccess: { type: Boolean, default: true },

    // Dealer App authentication (separate from staff User accounts)
    pinHash: { type: String, default: null, select: false },
    biometricEnabled: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    appLastLoginAt: { type: Date },

    // Registered app devices (SOW 17.1 "Device registration"). Recorded on each
    // login so the dealer — and support — can see where the account is signed in.
    // Revoking every device is done by bumping tokenVersion (logout from all).
    appDevices: {
      type: [{
        deviceId: { type: String, required: true, trim: true },
        deviceName: { type: String, default: '', trim: true },
        platform: { type: String, default: '', trim: true },
        osVersion: { type: String, default: '', trim: true },
        appVersion: { type: String, default: '', trim: true },
        firstSeenAt: { type: Date, default: Date.now },
        lastSeenAt: { type: Date, default: Date.now },
      }],
      default: [],
    },

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
dealerSchema.index({ assignedSalesExecutive: 1 });
// Unique login key for the Dealer App. Partial so legacy rows without a
// normalized number don't collide until they are saved/backfilled.
dealerSchema.index(
  { mobileNormalized: 1 },
  { unique: true, partialFilterExpression: { mobileNormalized: { $type: 'string', $gt: '' } } }
);

// Digits-only, last-10 normalization keeps "+91 98765 43210", "098765 43210"
// and "9876543210" all resolving to the same login key.
export const normalizeDealerMobile = (value) => String(value || '').replace(/[^\d]/g, '').slice(-10);

dealerSchema.pre('save', function normalizeMobileHook(next) {
  if (this.isModified('mobile') || !this.mobileNormalized) {
    this.mobileNormalized = normalizeDealerMobile(this.mobile);
  }
  next();
});

export default mongoose.model('Dealer', dealerSchema);
