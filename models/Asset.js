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

/**
 * Append-only custody and condition trail for an asset. The asset document holds
 * only its *current* assignment, so without this there is no way to answer "who
 * had this before?" or "what has this employee ever held?". Each entry records
 * the before and after state so the history reads as a sequence of changes.
 */
const assetMovementSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['assigned', 'returned', 'transferred', 'damaged', 'repaired', 'status_change', 'disposed', 'lost'],
    required: true,
  },
  date: { type: Date, required: true, default: Date.now },

  fromEmployee:     { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  fromEmployeeName: { type: String, trim: true, default: '' },
  toEmployee:       { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  toEmployeeName:   { type: String, trim: true, default: '' },

  fromLocation:   { type: String, trim: true, default: '' },
  toLocation:     { type: String, trim: true, default: '' },
  fromDepartment: { type: String, trim: true, default: '' },
  toDepartment:   { type: String, trim: true, default: '' },

  statusBefore:    { type: String, default: '' },
  statusAfter:     { type: String, default: '' },
  conditionBefore: { type: String, default: '' },
  conditionAfter:  { type: String, default: '' },

  reason:         { type: String, trim: true, default: '' },
  remarks:        { type: String, trim: true, default: '' },
  recordedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recordedByName: { type: String, trim: true, default: '' },
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

    // ── Custody / condition trail (assign, return, transfer, damage) ──
    movements: [assetMovementSchema],

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
// Custody history lookups: "what has this employee ever held?" scans movements
// by employee on both sides of a handover, newest first.
assetSchema.index({ 'movements.toEmployee': 1, 'movements.date': -1 });
assetSchema.index({ 'movements.fromEmployee': 1, 'movements.date': -1 });

export default mongoose.model('Asset', assetSchema);
