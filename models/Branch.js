import mongoose from 'mongoose';

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
    gstin: { type: String, trim: true, uppercase: true, default: '' },
    pan: { type: String, trim: true, uppercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    stateCode: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
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
