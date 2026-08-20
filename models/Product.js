import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    productCode: { type: String, unique: true, sparse: true, trim: true },
    itemName: { type: String, required: true, trim: true },
    aliasName: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    hsnCode: { type: String, trim: true, default: '' },
    gst: { type: Number, required: true, min: 0, max: 28, default: 18 },

    // Hierarchy: Brand → Category → Subcategory
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', required: true },

    // Tile-specific fields
    tileSize: { type: String, trim: true, default: '' },
    thickness: { type: String, trim: true, default: '' },
    finish: { type: String, trim: true, default: '' },
    surface: { type: String, trim: true, default: '' },
    colour: { type: String, trim: true, default: '' },
    design: { type: String, trim: true, default: '' },
    grade: { type: String, enum: ['', 'A', 'B', 'C'], default: '' },
    collection: { type: String, trim: true, default: '' },

    // Additional tile-industry fields
    tileType: { type: String, trim: true, default: '' },  // Ceramic, Vitrified, GVT, PGVT, etc.
    applicationArea: { type: String, trim: true, default: '' }, // Floor, Wall, Bathroom, Parking, Elevation
    antiSkidRating: { type: String, trim: true, default: '' }, // R9, R10, R11
    waterAbsorption: { type: String, trim: true, default: '' }, // e.g. "<0.5%"
    breakingStrength: { type: String, trim: true, default: '' }, // e.g. "2000N"
    countryOfOrigin: { type: String, trim: true, default: 'India' },
    manufacturer: { type: String, trim: true, default: '' }, // Actual manufacturer if different from brand
    barcode: { type: String, trim: true, sparse: true },

    // Units
    unit: { type: String, required: true, default: 'Box' },
    piecesPerBox: { type: Number, min: 0, default: 0 },
    sqftPerBox: { type: Number, min: 0, default: 0 },
    weightPerBox: { type: Number, min: 0, default: 0 },

    // Pricing
    basicPrice: { type: Number, min: 0, default: 0 },       // Base purchase price
    excessPrice: { type: Number, min: 0, default: 0 },       // Max excess allowed above basic (margin cap)
    maxPurchaseRate: { type: Number, min: 0, default: 0 },   // Auto: basicPrice + excessPrice
    purchaseRate: { type: Number, min: 0, default: 0 },
    landingCost: { type: Number, min: 0, default: 0 },
    mrp: { type: Number, min: 0, default: 0 },
    retailRate: { type: Number, min: 0, default: 0 },
    dealerRate: { type: Number, min: 0, default: 0 },
    wholesaleRate: { type: Number, min: 0, default: 0 },
    distributorRate: { type: Number, min: 0, default: 0 },
    projectRate: { type: Number, min: 0, default: 0 },
    builderRate: { type: Number, min: 0, default: 0 },
    minimumSellingRate: { type: Number, min: 0, default: 0 },

    // Stock settings
    minStockLevel: { type: Number, min: 0, default: 0 },
    reorderLevel: { type: Number, min: 0, default: 0 },

    // Media
    images: [String],
    videos: [String],           // product video URLs
    images360: [String],        // 360-degree image URLs
    cataloguePdf: { type: String, default: '' }, // catalogue PDF URL

    // Flags
    status: { type: String, enum: ['active', 'inactive', 'draft'], default: 'active' },
    isNewArrival: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false },
    onlineVisible: { type: Boolean, default: true },
    dealerVisible: { type: Boolean, default: true },

    // Sales type
    salesType: { type: String, enum: ['Regular Sale', 'CD Sales'], default: 'Regular Sale' },
    productType: { type: String, enum: ['Regular Product', 'AO Product'], default: 'Regular Product' },

    // Tally Integration
    tallyStockItemName: { type: String, trim: true, default: '' },
    tallyGUID: { type: String, trim: true, default: '' },
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed', 'tally_created'], default: 'not_synced' },
    tallySyncDate: Date,

    createdBy: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

// Indexes for fast search/filter at 1 lakh products
productSchema.index({ itemName: 'text', productCode: 'text', aliasName: 'text' });
productSchema.index({ brand: 1, category: 1, subcategory: 1 });
productSchema.index({ status: 1 });
productSchema.index({ productCode: 1 });

// Auto-calculate maxPurchaseRate before save
productSchema.pre('save', function (next) {
  if (this.basicPrice !== undefined || this.excessPrice !== undefined) {
    this.maxPurchaseRate = (this.basicPrice || 0) + (this.excessPrice || 0);
  }
  next();
});

// Also handle findOneAndUpdate
productSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update.basicPrice !== undefined || update.excessPrice !== undefined) {
    const basic = update.basicPrice ?? update.$set?.basicPrice ?? 0;
    const excess = update.excessPrice ?? update.$set?.excessPrice ?? 0;
    if (update.$set) {
      update.$set.maxPurchaseRate = basic + excess;
    } else {
      update.maxPurchaseRate = (update.basicPrice || 0) + (update.excessPrice || 0);
    }
  }
  next();
});

export default mongoose.model('Product', productSchema);
