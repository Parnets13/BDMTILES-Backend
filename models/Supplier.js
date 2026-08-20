import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema(
  {
    supplierCode: { type: String, unique: true, trim: true },
    companyName: { type: String, required: true, trim: true },
    contactPerson: { type: String, required: true, trim: true },
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

    // Bank Details
    bankName: { type: String, trim: true, default: '' },
    accountNumber: { type: String, trim: true, default: '' },
    ifscCode: { type: String, trim: true, default: '' },
    accountHolderName: { type: String, trim: true, default: '' },

    // Financial
    paymentTerms: { type: String, trim: true, default: '' },
    creditDays: { type: Number, default: 30 },
    openingBalance: { type: Number, default: 0 },
    currentOutstanding: { type: Number, default: 0 },

    // Scheme
    schemeType: { type: String, trim: true, default: '' },
    schemeDetails: { type: String, trim: true, default: '' },
    schemeValidity: { type: Date },
    schemeAmountDue: { type: Number, default: 0 },

    // Classification
    productCategories: [String],
    transportDetails: { type: String, trim: true, default: '' },
    performanceRating: { type: Number, min: 0, max: 5, default: 0 },

    // Status
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },

    // Tally mapping
    tallyLedgerName: { type: String, trim: true, default: '' },
    tallyGUID: { type: String, trim: true, default: '' },
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed', 'tally_created'], default: 'not_synced' },
    tallySyncDate: Date,

    // Documents
    documents: [{ type: { type: String }, url: String }],

    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

supplierSchema.index({ companyName: 'text', contactPerson: 'text', mobile: 'text', supplierCode: 'text' });

export default mongoose.model('Supplier', supplierSchema);
