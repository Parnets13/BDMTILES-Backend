import mongoose from 'mongoose';

/**
 * Sample Management — Track product samples issued to customers/architects.
 * Issue → Track → Return/Damage/Deposit
 */
const sampleSchema = new mongoose.Schema(
  {
    sampleNumber: { type: String, unique: true, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: String,
    productCode: String,
    shade: { type: String, default: '' },
    batch: { type: String, default: '' },
    quantity: { type: Number, default: 1 },

    // Issued to
    issuedTo: { type: String, required: true }, // name of person/company
    issuedToType: { type: String, enum: ['dealer', 'architect', 'builder', 'customer', 'contractor', 'interior_designer'], default: 'customer' },
    issuedToContact: { type: String, default: '' },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },

    // Dates
    issueDate: { type: Date, default: Date.now },
    expectedReturnDate: Date,
    actualReturnDate: Date,

    // Deposit
    depositAmount: { type: Number, default: 0 },
    depositCollected: { type: Boolean, default: false },
    depositReturned: { type: Boolean, default: false },

    // Status
    status: {
      type: String,
      enum: ['issued', 'with_customer', 'returned', 'damaged', 'lost', 'converted_to_sale'],
      default: 'issued',
    },
    damageNotes: String,
    returnCondition: { type: String, enum: ['good', 'damaged', 'lost', ''], default: '' },

    // Tracking
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    remarks: { type: String, default: '' },
  },
  { timestamps: true }
);

sampleSchema.index({ status: 1 });
sampleSchema.index({ issuedTo: 'text' });

export default mongoose.model('Sample', sampleSchema);
