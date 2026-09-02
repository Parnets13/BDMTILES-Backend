import mongoose from 'mongoose';

const slabSchema = new mongoose.Schema({
  from: { type: Number, required: true, min: 0 },
  to: { type: Number, default: null, min: 0 },
  rate: { type: Number, default: 0, min: 0 },
  fixedAmount: { type: Number, default: 0, min: 0 },
}, { _id: false });

const supplierSchemeSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
    schemeNumber: { type: String, required: true },
    schemeName: { type: String, required: true, trim: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, default: '' },
    basis: {
      type: String,
      enum: ['purchase_value', 'purchase_quantity', 'confirmed_payment'],
      required: true,
    },
    calculationType: {
      type: String,
      enum: ['fixed', 'percentage', 'per_unit', 'highest_slab', 'progressive_slab'],
      required: true,
    },
    targetAmount: { type: Number, default: 0, min: 0 },
    targetQuantity: { type: Number, default: 0, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    fixedAmount: { type: Number, default: 0, min: 0 },
    paymentWithinDays: { type: Number, default: 0, min: 0, max: 365 },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    slabs: { type: [slabSchema], default: [] },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'expired', 'closed'],
      default: 'draft',
    },
    version: { type: Number, default: 1, min: 1 },
    remarks: { type: String, default: '', trim: true },
    termsAndConditions: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supplierSchemeSchema.index({ branch: 1, schemeNumber: 1 }, { unique: true });
supplierSchemeSchema.index({ branch: 1, supplier: 1, status: 1, startDate: -1 });

export default mongoose.model('SupplierScheme', supplierSchemeSchema);
