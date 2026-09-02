import mongoose from 'mongoose';

const offerItemSchema = new mongoose.Schema({
  requisitionItem: { type: mongoose.Schema.Types.ObjectId },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  quantity: { type: Number, required: true, min: 0.0001 },
  unit: { type: String, default: 'Box' },
  offeredRate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0, min: 0 },
  schemeDiscount: { type: Number, default: 0, min: 0 },
  scheme: { type: String, default: '' },
  gstPercentage: { type: Number, default: 18, min: 0, max: 100 },
  taxableAmount: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  lineTotal: { type: Number, default: 0 },
  normalizedLandedAmount: { type: Number, default: 0 },
}, { _id: true });

const supplierOfferSchema = new mongoose.Schema({
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  supplierSnapshot: {
    supplierCode: String,
    companyName: String,
    contactPerson: String,
    mobile: String,
    email: String,
    gstin: String,
  },
  supplierRating: { type: Number, min: 0, max: 5, default: 0 },
  items: { type: [offerItemSchema], validate: value => Array.isArray(value) && value.length > 0 },
  freight: { type: Number, default: 0, min: 0 },
  loading: { type: Number, default: 0, min: 0 },
  insurance: { type: Number, default: 0, min: 0 },
  creditDays: { type: Number, default: 0, min: 0 },
  paymentTerms: { type: String, default: '' },
  promisedDeliveryDate: Date,
  deliveryTimeline: { type: String, default: '' },
  totalLandedAmount: { type: Number, default: 0 },
  remarks: { type: String, default: '' },
  documents: [{ name: String, type: String, url: String, reference: String }],
  rank: Number,
}, { _id: true });

const supplierQuotationSchema = new mongoose.Schema({
  quotationNumber: { type: String, required: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
  purchaseRequisition: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseRequisition', required: true, immutable: true },
  prNumber: { type: String, required: true },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  offers: { type: [supplierOfferSchema], validate: value => Array.isArray(value) && value.length > 0 },
  status: {
    type: String,
    enum: ['draft', 'submitted', 'compared', 'selected', 'po_created', 'cancelled'],
    default: 'draft',
  },
  comparison: [{
    offer: mongoose.Schema.Types.ObjectId,
    supplier: mongoose.Schema.Types.ObjectId,
    supplierName: String,
    totalLandedAmount: Number,
    normalizedUnitCost: Number,
    supplierRating: Number,
    creditDays: Number,
    promisedDeliveryDate: Date,
    rank: Number,
  }],
  selectedOffer: { type: mongoose.Schema.Types.ObjectId },
  selectedSupplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
  selectedAt: Date,
  selectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  selectionRemarks: { type: String, default: '' },
  linkedPO: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
  submittedAt: Date,
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

supplierQuotationSchema.index({ branch: 1, quotationNumber: 1 }, { unique: true });
supplierQuotationSchema.index({ branch: 1, purchaseRequisition: 1 }, { unique: true });
supplierQuotationSchema.index({ branch: 1, status: 1, createdAt: -1 });
supplierQuotationSchema.index({ branch: 1, selectedSupplier: 1, status: 1 });

export default mongoose.model('SupplierQuotation', supplierQuotationSchema);
