import mongoose from 'mongoose';

const quotationItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 1 },
  unit: { type: String, default: 'Box' },
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 },
  discountType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
  discountRuleName: { type: String, default: '' },
  taxableAmount: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 18 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
});

const quotationSchema = new mongoose.Schema(
  {
    quotationNumber: { type: String, unique: true, required: true },
    quotationDate: { type: Date, default: Date.now },
    validUntil: { type: Date },

    // Customer / Dealer
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerName: String,
    dealerCode: String,
    customerType: { type: String, enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', ''], default: '' },
    // For non-dealer / walk-in customers
    customerName: String,
    customerPhone: String,
    customerAddress: String,

    items: [quotationItemSchema],

    // Totals
    subtotal: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    freightCharges: { type: Number, default: 0 },
    loadingCharges: { type: Number, default: 0 },
    installationCharges: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    // Status
    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'converted', 'expired', 'cancelled'],
      default: 'draft',
    },

    // Approval
    approvalRequired: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: String,

    // Versioning
    version: { type: Number, default: 1 },
    previousVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },

    // Conversion to SO
    convertedToSO: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    convertedAt: Date,

    remarks: { type: String, default: '' },
    termsAndConditions: { type: String, default: '' },

    // Tally
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

quotationSchema.index({ quotationNumber: 1 });
quotationSchema.index({ dealer: 1, status: 1 });
quotationSchema.index({ status: 1, quotationDate: -1 });

export default mongoose.model('Quotation', quotationSchema);
