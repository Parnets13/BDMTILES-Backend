import mongoose from 'mongoose';

const subcategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

// Subcategory name unique per category
subcategorySchema.index({ name: 1, category: 1 }, { unique: true });
subcategorySchema.index({ name: 'text', description: 'text' });
subcategorySchema.index({ brand: 1 });

export default mongoose.model('Subcategory', subcategorySchema);
