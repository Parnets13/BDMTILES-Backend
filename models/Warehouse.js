import mongoose from 'mongoose';

const warehouseSchema = new mongoose.Schema(
  {
    warehouseCode:  { type: String, trim: true },
    name:           { type: String, required: true, trim: true },
    branch:         { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
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

warehouseSchema.index({ branch: 1, warehouseCode: 1 }, { unique: true, sparse: true });
warehouseSchema.index({ branch: 1, name: 1 }, { unique: true });
warehouseSchema.index({ branch: 1, status: 1 });

export default mongoose.model('Warehouse', warehouseSchema);
