import mongoose from 'mongoose';

/**
 * Incentive — Defines incentive rules for dealers and sales executives.
 * 
 * Types:
 *   - flat: Fixed amount per event (e.g., ₹500 per lead converted)
 *   - percentage: % of sales value (e.g., 1% of monthly sales)
 *   - slab: Tiered based on qty/value achieved
 *   - target: Bonus on reaching a target amount/qty
 *   - per_unit: Fixed amount per unit sold above threshold
 *   - milestone: One-time bonus on reaching milestones
 */

const slabSchema = new mongoose.Schema({
  minValue: { type: Number, default: 0 },
  maxValue: { type: Number, default: 0 }, // 0 = unlimited
  minQty: { type: Number, default: 0 },
  maxQty: { type: Number, default: 0 },
  incentiveAmount: { type: Number, default: 0 },
  incentivePercentage: { type: Number, default: 0 },
  description: String,
});

const incentiveSchema = new mongoose.Schema(
  {
    incentiveCode: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    incentiveName: { type: String, required: true },

    // Who is this for
    applicableTo: {
      type: String,
      enum: ['sales_executive', 'dealer', 'delivery_executive', 'team'],
      required: true,
    },
    // Specific users/dealers (empty = all)
    specificUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    specificDealers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' }],

    // Incentive type
    incentiveType: {
      type: String,
      enum: ['flat', 'percentage', 'slab', 'target', 'per_unit', 'milestone'],
      required: true,
    },

    // For which event/metric
    triggerEvent: {
      type: String,
      enum: [
        'lead_converted',       // SE converts a lead → gets incentive
        'order_created',        // SE creates order above threshold
        'monthly_sales',        // Based on total monthly sales value
        'quarterly_sales',      // Based on quarterly sales
        'annual_sales',         // Annual
        'collection_target',    // Payment collection target met
        'new_dealer_onboarded', // New dealer brought by SE
        'delivery_completed',   // Delivery executive completes on time
        'target_achieved',      // Generic target achievement
        'custom',               // Custom trigger
      ],
      required: true,
    },

    // Calculation parameters
    // For 'flat':
    flatAmount: { type: Number, default: 0 },

    // For 'percentage':
    percentage: { type: Number, default: 0 },
    maxCap: { type: Number, default: 0 }, // max incentive amount (0 = no cap)

    // For 'per_unit':
    perUnitAmount: { type: Number, default: 0 },
    thresholdQty: { type: Number, default: 0 }, // only kicks in above this qty

    // For 'target':
    targetValue: { type: Number, default: 0 }, // target amount to achieve
    targetQty: { type: Number, default: 0 },   // target qty to achieve
    bonusOnTarget: { type: Number, default: 0 }, // bonus amount when target met

    // For 'slab':
    slabs: [slabSchema],

    // For 'milestone':
    milestones: [{
      milestoneName: String,
      targetValue: Number,
      bonusAmount: Number,
      achieved: { type: Boolean, default: false },
    }],

    // Period
    period: { type: String, enum: ['monthly', 'quarterly', 'half_yearly', 'annual', 'one_time', 'per_event'], default: 'monthly' },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },

    // Status
    status: { type: String, enum: ['active', 'paused', 'expired', 'closed'], default: 'active' },

    // Tracking
    totalEarned: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    totalPending: { type: Number, default: 0 },

    remarks: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

incentiveSchema.index({ branch: 1, incentiveCode: 1 }, { unique: true });
incentiveSchema.index({ applicableTo: 1, status: 1 });
incentiveSchema.index({ triggerEvent: 1, status: 1 });

/**
 * Calculate incentive amount for a given value/qty
 */
incentiveSchema.methods.calculate = function (value = 0, qty = 0) {
  switch (this.incentiveType) {
    case 'flat':
      return this.flatAmount;

    case 'percentage': {
      const amt = (value * this.percentage) / 100;
      return this.maxCap > 0 ? Math.min(amt, this.maxCap) : amt;
    }

    case 'per_unit': {
      const excessQty = Math.max(0, qty - this.thresholdQty);
      return excessQty * this.perUnitAmount;
    }

    case 'target': {
      if (value >= this.targetValue || qty >= this.targetQty) return this.bonusOnTarget;
      return 0;
    }

    case 'slab': {
      // Find matching slab by value or qty
      const slab = (this.slabs || []).find(s => {
        if (s.minValue > 0 || s.maxValue > 0) {
          return value >= s.minValue && (s.maxValue === 0 || value <= s.maxValue);
        }
        return qty >= s.minQty && (s.maxQty === 0 || qty <= s.maxQty);
      });
      if (!slab) return 0;
      if (slab.incentiveAmount > 0) return slab.incentiveAmount;
      if (slab.incentivePercentage > 0) return (value * slab.incentivePercentage) / 100;
      return 0;
    }

    case 'milestone': {
      let total = 0;
      for (const m of (this.milestones || [])) {
        if (value >= m.targetValue && !m.achieved) total += m.bonusAmount;
      }
      return total;
    }

    default:
      return 0;
  }
};

export default mongoose.model('Incentive', incentiveSchema);
