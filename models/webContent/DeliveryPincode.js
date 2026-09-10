import mongoose from 'mongoose';

/**
 * Serviceable delivery pincode for the storefront (BDM Tiles website).
 * Global content — not branch-scoped. Managed via the CRM "Web Management" module.
 * The storefront checks a customer pincode against active entries here.
 */
const deliveryPincodeSchema = new mongoose.Schema(
  {
    pincode: { type: String, required: true, trim: true, unique: true },
    area: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    deliveryDays: { type: Number, min: 0, default: 3 }, // estimated days to deliver
    codAvailable: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

deliveryPincodeSchema.index({ pincode: 1 });

export default mongoose.model('DeliveryPincode', deliveryPincodeSchema);
