import mongoose from 'mongoose';

const dealerPricingScheduleSchema = new mongoose.Schema({
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  scope: { type: String, enum: ['dealer', 'dealer_type', 'walk_in'], required: true },
  dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
  dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true }],
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  expectedRates: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    oldRate: { type: Number, required: true },
    newRate: { type: Number, required: true },
  }],
  changeType: {
    type: String,
    enum: ['increase_percent', 'decrease_percent', 'increase_flat', 'decrease_flat', 'set_value'],
    required: true,
  },
  changeValue: { type: Number, required: true, min: 0 },
  quantity: { type: Number, min: 0.000001, default: 1 },
  validFrom: { type: Date, default: Date.now },
  validTo: { type: Date, default: null },
  applyAt: { type: Date, required: true, index: true },
  reason: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['pending', 'applied', 'cancelled', 'failed'], default: 'pending' },
  error: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  appliedAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancelledAt: Date,
}, { timestamps: true });

dealerPricingScheduleSchema.pre('validate', function validateSchedule(next) {
  if (this.scope === 'dealer' && !this.dealer) return next(new Error('dealer is required for dealer schedules.'));
  if (this.scope === 'dealer_type' && !this.dealerType) return next(new Error('dealerType is required for dealer_type schedules.'));
  if (this.scope === 'walk_in' && (this.dealer || this.dealerType)) return next(new Error('walk_in schedules cannot target a dealer or dealerType.'));
  if (!Array.isArray(this.products) || this.products.length === 0) return next(new Error('At least one product is required.'));
  if (this.validTo && this.validFrom && this.validTo < this.validFrom) return next(new Error('validTo must be on or after validFrom.'));
  return next();
});

dealerPricingScheduleSchema.index({ branch: 1, status: 1, applyAt: 1 });
dealerPricingScheduleSchema.index({ branch: 1, createdAt: -1 });

export default mongoose.model('DealerPricingSchedule', dealerPricingScheduleSchema);
