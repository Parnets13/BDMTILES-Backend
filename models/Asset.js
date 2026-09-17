import mongoose from 'mongoose';

const maintenanceLogSchema = new mongoose.Schema({
  date:        { type: Date, required: true },
  type:        { type: String, enum: ['preventive', 'corrective', 'inspection', 'repair'], default: 'preventive' },
  description: { type: String, required: true, trim: true },
  cost:        { type: Number, default: 0 },
  doneBy:      { type: String, trim: true, default: '' },  // vendor or employee name
  nextDueDate: { type: Date },
  status:      { type: String, enum: ['completed', 'pending', 'in_progress'], default: 'completed' },
  remarks:     { type: String, trim: true, default: '' },
}, { _id: true, timestamps: false });

const assetSchema = new mongoose.Schema(
  {
    // ── Identification ──────────────────────────────────────────
    assetCode:    { type: String, unique: true, required: true, trim: true },   // AST-00001
    name:         { type: String, required: true, trim: true },
    description:  { type: String, trim: true, default: '' },
    category:     {
      type: String,
      enum: ['IT Equipment', 'Vehicle', 'Furniture', 'Machinery', 'Tools', 'Office Equipment', 'Building', 'Other'],
      required: true,
    },

    // ── Purchase Info ────────────────────────────────────────────
    vendor:           { type: String, trim: true, default: '' },
    purchaseDate:     { type: Date },
    purchaseCost:     { type: Number, default: 0 },
    invoiceNumber:    { type: String, trim: true, default: '' },
    serialNumber:     { type: String, trim: true, default: '' },
    modelNumber:      { type: String, trim: true, default: '' },
    brand:            { type: String, trim: true, default: '' },

    // ── Warranty & AMC ───────────────────────────────────────────
    warrantyExpiry:   { type: Date },
    amcExpiry:        { type: Date },
    amcVendor:        { type: String, trim: true, default: '' },

    // ── Location ─────────────────────────────────────────────────
    location:         { type: String, trim: true, default: '' },   // e.g. "Warehouse A / Floor 2"
    department:       { type: String, trim: true, default: '' },

    // ── Assignment ───────────────────────────────────────────────
    assignedTo:       { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    assignedToName:   { type: String, trim: true, default: '' },   // denormalized for speed
    assignedDate:     { type: Date },
    returnDate:       { type: Date },

    // ── Status & Condition ───────────────────────────────────────
    status: {
      type: String,
      enum: ['active', 'in_use', 'under_maintenance', 'disposed', 'lost', 'returned'],
      default: 'active',
    },
    condition: {
      type: String,
      enum: ['excellent', 'good', 'fair', 'poor', 'damaged'],
      default: 'good',
    },

    // ── Depreciation ─────────────────────────────────────────────
    usefulLifeYears:      { type: Number, default: 5 },
    depreciationMethod:   { type: String, enum: ['straight_line', 'written_down_value'], default: 'straight_line' },
    depreciationRate:     { type: Number, default: 20 },   // % per year
    currentValue:         { type: Number, default: 0 },

    // ── Maintenance History ──────────────────────────────────────
    maintenanceLogs: [maintenanceLogSchema],
    lastMaintenanceDate: { type: Date },
    nextMaintenanceDue:  { type: Date },

    // ── Miscellaneous ─────────────────────────────────────────────
    notes:     { type: String, trim: true, default: '' },
    imageUrl:  { type: String, trim: true, default: '' },
    isActive:  { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Indexes
assetSchema.index({ status: 1 });
assetSchema.index({ category: 1 });
assetSchema.index({ assignedTo: 1 });
assetSchema.index({ nextMaintenanceDue: 1 });

export default mongoose.model('Asset', assetSchema);
