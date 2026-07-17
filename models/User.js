import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength: 6, select: false },
    phone: { type: String, required: true, trim: true },
    role: {
      type: String,
      required: true,
      enum: ['super_admin','admin','sub_admin','owner','sales_manager','purchase_manager','warehouse_manager','finance_manager','hr_manager','sales_executive','delivery_executive','picking_staff','sorting_staff','dealer'],
      default: 'sales_executive',
    },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    permissions: [String],
    assignedBranch: String,
    assignedWarehouse: mongoose.Schema.Types.ObjectId,
    assignedRegions: [mongoose.Schema.Types.ObjectId],
    assignedDealers: [mongoose.Schema.Types.ObjectId],
    lastLogin: Date,
    joinDate: { type: Date, default: Date.now },
    fcmToken: String,
    createdBy: mongoose.Schema.Types.ObjectId,
  },
  { timestamps: true }
);

userSchema.index({ role: 1, status: 1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

export default mongoose.model('User', userSchema);
