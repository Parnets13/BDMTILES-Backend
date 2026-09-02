import mongoose from 'mongoose';

const POLICY_MODES = ['all_time', 'rolling_days', 'fixed_range'];

const policyRuleSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: POLICY_MODES, default: 'all_time' },
    rollingDays: { type: Number, min: 1 },
    startDate: Date,
    endDate: Date,
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const rolePolicySchema = new mongoose.Schema(
  {
    role: { type: String, required: true, trim: true },
    ...policyRuleSchema.obj,
  },
  { _id: false }
);

const accessPolicySchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    module: { type: String, required: true, trim: true, lowercase: true },
    resourceKey: { type: String, required: true, trim: true, lowercase: true, default: '*' },
    mode: { type: String, enum: POLICY_MODES, default: 'all_time' },
    rollingDays: { type: Number, min: 1 },
    startDate: Date,
    endDate: Date,
    exemptRoles: [{ type: String, trim: true }],
    rolePolicies: [rolePolicySchema],
    enabled: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

accessPolicySchema.index({ branch: 1, module: 1, resourceKey: 1 }, { unique: true });
accessPolicySchema.index({ branch: 1, updatedAt: -1 });

export { POLICY_MODES };
export default mongoose.model('AccessPolicy', accessPolicySchema);
