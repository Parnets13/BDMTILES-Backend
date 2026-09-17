import mongoose from 'mongoose';

const dealerSnapshotSchema = new mongoose.Schema({
  businessName: { type: String, required: true },
  dealerCode: { type: String, default: '' },
  ownerName: { type: String, default: '' },
  mobile: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
}, { _id: false });

const requestItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: { type: String, default: '' },
  productName: { type: String, required: true },
  productImage: { type: String, default: '' },
  unit: { type: String, default: 'Box' },
  tileSize: { type: String, default: '' },
  finish: { type: String, default: '' },
  colour: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 0.000001 },
  boxes: { type: Number, required: true, min: 0.000001 },
  pieces: { type: Number, required: true, min: 0.000001 },
  sqft: { type: Number, required: true, min: 0.000001 },
  piecesPerBox: { type: Number, required: true, min: 0.000001 },
  sqftPerBox: { type: Number, required: true, min: 0.000001 },
}, { _id: false });

const dealerOrderRequestSchema = new mongoose.Schema({
  requestNumber: { type: String, required: true, trim: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true },
  dealerSnapshot: { type: dealerSnapshotSchema, required: true },
  salesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  salesExecutiveName: { type: String, default: '' },
  items: {
    type: [requestItemSchema],
    validate: {
      validator: value => Array.isArray(value) && value.length > 0 && value.length <= 100,
      message: 'A request requires between 1 and 100 items.',
    },
  },
  remarks: { type: String, trim: true, maxlength: 2000, default: '' },
  // Dealer's delivery preference, captured in the app. Advisory only — the sales
  // executive confirms the final address and date when converting to a quotation.
  deliveryAddress: { type: String, trim: true, maxlength: 500, default: '' },
  expectedDeliveryDate: { type: Date, default: null },
  status: {
    type: String,
    enum: ['submitted', 'approved', 'rejected', 'quotation_linked', 'cancelled'],
    default: 'submitted',
  },
  revision: { type: Number, default: 0, min: 0 },
  submittedAt: { type: Date, default: Date.now },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  approvalRemarks: { type: String, trim: true, maxlength: 1000, default: '' },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: Date,
  rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
  sourceQuotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
  linkedAt: Date,
  linkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  sourceKey: { type: String, required: true },
  requestFingerprint: { type: String, required: true },
  approvedFingerprint: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

dealerOrderRequestSchema.index({ branch: 1, requestNumber: 1 }, { unique: true });
dealerOrderRequestSchema.index({ sourceKey: 1 }, { unique: true });
dealerOrderRequestSchema.index({ branch: 1, status: 1, createdAt: -1 });
dealerOrderRequestSchema.index({ branch: 1, salesExecutive: 1, createdAt: -1 });
dealerOrderRequestSchema.index({ branch: 1, dealer: 1, createdAt: -1 });
dealerOrderRequestSchema.index(
  { branch: 1, sourceQuotation: 1 },
  { unique: true, partialFilterExpression: { sourceQuotation: { $type: 'objectId' } } },
);

export default mongoose.model('DealerOrderRequest', dealerOrderRequestSchema);
