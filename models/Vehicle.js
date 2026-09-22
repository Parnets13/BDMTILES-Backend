import mongoose from 'mongoose';

const vehicleSchema = new mongoose.Schema(
  {
    vehicleNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    vehicleType: {
      type: String,
      enum: ['truck', 'mini_truck', 'tempo', 'van', 'auto', 'bike', 'other'],
      default: 'truck',
    },
    make: { type: String, default: '' },
    model: { type: String, default: '' },
    year: { type: String, default: '' },
    capacity: { type: String, default: '' },
    capacityUnit: { type: String, enum: ['tons', 'kg', 'boxes'], default: 'tons' },
    ownerName: { type: String, default: '' },
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },
    // Optional authenticated account used by assignment/tracking. Driver details
    // remain separate because the person driving need not be the app account.
    deliveryExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    insuranceExpiry: { type: Date },
    fitnessExpiry: { type: Date },
    isActive: { type: Boolean, default: true },
    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

vehicleSchema.index({ isActive: 1 });
vehicleSchema.index({ deliveryExecutive: 1, isActive: 1 });

const Vehicle = mongoose.model('Vehicle', vehicleSchema);
export default Vehicle;
