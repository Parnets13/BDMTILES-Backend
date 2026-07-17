import mongoose from 'mongoose';

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

// Category name unique per brand
categorySchema.index({ name: 1, brand: 1 }, { unique: true });
categorySchema.index({ name: 'text', description: 'text' });

export default mongoose.model('Category', categorySchema);
