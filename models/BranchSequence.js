import mongoose from 'mongoose';

const branchSequenceSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    documentType: { type: String, required: true, trim: true },
    fiscalYear: { type: String, required: true, trim: true },
    value: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

branchSequenceSchema.index(
  { branch: 1, documentType: 1, fiscalYear: 1 },
  { unique: true }
);

export default mongoose.model('BranchSequence', branchSequenceSchema);
