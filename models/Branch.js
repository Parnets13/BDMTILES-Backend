import mongoose from 'mongoose';
import { isValidGstin } from '../utils/gstin.js';

const branchSchema = new mongoose.Schema(
  {
    branchCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
    },
    name: { type: String, required: true, trim: true },
    legalName: { type: String, trim: true, default: '' },
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
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    stateCode: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    // Google Review link for incentive tracking
    googleReviewLink: { type: String, trim: true, default: '' },
    // Google Review Incentive Settings
    googleReviewIncentive: {
      enabled: { type: Boolean, default: false },
      amount: { type: Number, default: 0 }, // Incentive amount per review
      currency: { type: String, default: 'INR' },
      description: { type: String, trim: true, default: 'Incentive for collecting Google reviews' },
    },
    // ── Delivery coverage ──────────────────────────────────────────
    // Where the branch physically is, and how far from it the branch will deliver.
    // The storefront answers "do you deliver to me?" from these two numbers when
    // the customer shares a location, and falls back to the pincode whitelist when
    // they only type a pincode. Both are optional: a branch with no coordinates
    // simply never matches on distance, so it keeps whatever pincode coverage it
    // had instead of losing it.
    location: {
      latitude: { type: Number, min: -90, max: 90, default: null },
      longitude: { type: Number, min: -180, max: 180, default: null },
    },
    deliveryRadiusKm: { type: Number, min: 0, max: 500, default: 0 },
    // Companies (legal entities / GST registrations) that operate from this branch.
    // Many-to-many: one company can trade from several branches, and a branch can
    // be shared by more than one registered company.
    companies: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Company' }],
    defaultWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

branchSchema.index({ name: 1 });
branchSchema.index({ status: 1, name: 1 });

export default mongoose.model('Branch', branchSchema);
