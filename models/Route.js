import mongoose from 'mongoose';

const routeSchema = new mongoose.Schema(
  {
    name:            { type: String, required: true, trim: true, unique: true },
    description:     { type: String, trim: true, default: '' },
    region:          { type: mongoose.Schema.Types.ObjectId, ref: 'Region' },
    assignedSE:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    citiesCovered:   [{ type: String, trim: true }],
    visitFrequency:  { type: String, enum: ['daily', 'weekly', 'fortnightly', 'monthly'], default: 'weekly' },
    dayOfWeek:       { type: String, enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', ''], default: '' },
    status:          { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy:       { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

export default mongoose.model('Route', routeSchema);
