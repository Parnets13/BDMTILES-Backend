import mongoose from 'mongoose';

const warehouseSchema = new mongoose.Schema(
  {
    warehouseCode: { type: String, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    manager: { type: String, trim: true, default: '' },
    contactNumber: { type: String, trim: true, default: '' },
    capacity: { type: String, trim: true, default: '' },
    zones: [String],
    racks: [String],
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

export default mongoose.model('Warehouse', warehouseSchema);
