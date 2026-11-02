import mongoose from 'mongoose';

/**
 * Company Master — the legal entities BDM trades under.
 *
 * A legal entity can hold one GST registration per state, so `gstin` is the unique
 * key and `legalName` deliberately is not: "BDM Tiles Pvt Ltd" appears once for
 * Karnataka (29…) and once for Maharashtra (27…). Trade name is the brand the
 * company is known by and may differ from, or match, the legal name.
 *
 * GST number, PAN and state are all typed by hand. Nothing is validated or derived
 * here — the operator enters exactly what is on the registration certificate.
 */
const companySchema = new mongoose.Schema(
  {
    legalName: {
      type: String,
      required: [true, 'Company legal name is required.'],
      trim: true,
      maxlength: [200, 'Legal name cannot exceed 200 characters.'],
    },
    tradeName: {
      type: String,
      trim: true,
      default: '',
      maxlength: [200, 'Trade name cannot exceed 200 characters.'],
    },
    // No format check: the GST number is taken exactly as entered.
    gstin: {
      type: String,
      required: [true, 'GST number is required.'],
      trim: true,
      uppercase: true,
      unique: true,
    },
    // PAN and state are typed by hand — no derivation, no format check.
    pan: { type: String, trim: true, uppercase: true, default: '' },
    stateCode: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    // Exactly one company is the primary identity printed on documents.
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

companySchema.index({ legalName: 1 });
companySchema.index({ status: 1, legalName: 1 });

export default mongoose.model('Company', companySchema);
