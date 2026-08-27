import mongoose from 'mongoose';

const dealerPricingHistorySchema = new mongoose.Schema({
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  pricing: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerPricing' },
  schedule: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerPricingSchedule' },
  action: {
    type: String,
    enum: ['create', 'update', 'toggle', 'bulk', 'scheduled_application'],
    required: true,
  },
  scope: { type: String, enum: ['dealer', 'dealer_type', 'walk_in'], required: true },
  dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
  dealerType: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerType' },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  reason: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  effectiveAt: { type: Date, default: Date.now },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

dealerPricingHistorySchema.index({ branch: 1, createdAt: -1 });
dealerPricingHistorySchema.index({ branch: 1, product: 1, createdAt: -1 });
dealerPricingHistorySchema.index({ branch: 1, scope: 1, dealer: 1, dealerType: 1, createdAt: -1 });

export default mongoose.model('DealerPricingHistory', dealerPricingHistorySchema);
