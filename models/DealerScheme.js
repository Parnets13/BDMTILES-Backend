import mongoose from 'mongoose';

const slabSchema = new mongoose.Schema({
  from: { type: Number, required: true, min: 0 },
  to: { type: Number, default: null, min: 0 },
  rate: { type: Number, default: 0, min: 0 },
  fixedAmount: { type: Number, default: 0, min: 0 },
}, { _id: false });

const dealerSchemeSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
    schemeNumber: { type: String, required: true },
    schemeName: { type: String, required: true, trim: true },
    applicableTo: {
      type: String,
      enum: ['all', 'specific_dealers', 'dealer_category', 'dealer_type'],
      default: 'all',
    },
    dealers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' }],
    dealerCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerCategory' },
    dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },
    basis: {
      type: String,
      enum: ['invoice_value', 'invoice_quantity', 'confirmed_payment'],
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
    description: { type: String, default: '', trim: true },
    termsAndConditions: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dealerSchemeSchema.index({ branch: 1, schemeNumber: 1 }, { unique: true });
dealerSchemeSchema.index({ branch: 1, status: 1, startDate: -1 });
dealerSchemeSchema.index({ branch: 1, dealers: 1, status: 1 });

export default mongoose.model('DealerScheme', dealerSchemeSchema);
