import mongoose from 'mongoose';

/**
 * Customer request for delivery to an unserviceable pincode.
 * Stored globally (not branch-scoped). Visible in CRM Web Management → Delivery Pincodes.
 */
const pincodeRequestSchema = new mongoose.Schema(
  {
    pincode: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['pending', 'acknowledged', 'added'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

pincodeRequestSchema.index({ pincode: 1 });

export default mongoose.model('PincodeRequest', pincodeRequestSchema);
