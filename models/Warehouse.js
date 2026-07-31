import mongoose from 'mongoose';

const warehouseSchema = new mongoose.Schema(
  {
    warehouseCode:  { type: String, unique: true, sparse: true, trim: true },
    name:           { type: String, required: true, trim: true, unique: true },
    type:           { type: String, enum: ['main', 'branch', 'transit', 'godown'], default: 'main' },
    address:        { type: String, trim: true, default: '' },
    city:           { type: String, trim: true, default: '' },
    state:          { type: String, trim: true, default: '' },
    pinCode:        { type: String, trim: true, default: '' },
    region:         { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
    managerName:    { type: String, trim: true, default: '' },
    managerPhone:   { type: String, trim: true, default: '' },
    email:          { type: String, trim: true, default: '' },
    capacity:       { type: String, trim: true, default: '' },
    zones:          [String],
    status:         { type: String, enum: ['active', 'inactive', 'maintenance'], default: 'active' },
    createdBy:      { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

export default mongoose.model('Warehouse', warehouseSchema);
