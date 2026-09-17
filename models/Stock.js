import mongoose from 'mongoose';

/**
 * Stock tracked at Product → Warehouse → Shade → Batch level
 * This is the CRITICAL tile-industry model (Section 5 of requirements)
 */
const stockSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    shade: { type: String, default: '' },
    batch: { type: String, default: '' },

    // Quantities
    totalQty: { type: Number, default: 0 },
    availableQty: { type: Number, default: 0 },
    reservedQty: { type: Number, default: 0 },
    blockedQty: { type: Number, default: 0 },
    damagedQty: { type: Number, default: 0 },
    sampleQty: { type: Number, default: 0 },
    transitQty: { type: Number, default: 0 },
    shortQty: { type: Number, default: 0 },

    // Stable inventory-UOM snapshot. These fields are deliberately excluded from
    // the unique key and do not reinterpret or multiply legacy balances.
    baseUnit: { type: String, trim: true, default: 'Unit' },
    uomVersion: { type: Number, min: 1, default: 1 },

    // Location within warehouse
    zone: { type: String, default: '' },
    rack: { type: String, default: '' },
    bin: { type: String, default: '' },

    // Valuation
    purchaseRate: { type: Number, default: 0 },
    landingCost: { type: Number, default: 0 },

    // Tracking
    lastGRNDate: Date,
    lastSaleDate: Date,

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
  },
  { timestamps: true }
);

// CRITICAL: Compound unique index — one row per product+warehouse+shade+batch
stockSchema.index({ branch: 1, product: 1, warehouse: 1, shade: 1, batch: 1 }, { unique: true });
stockSchema.index({ branch: 1, product: 1, availableQty: 1 });
stockSchema.index({ branch: 1, warehouse: 1 });

export default mongoose.model('Stock', stockSchema);
