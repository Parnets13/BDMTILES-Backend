import mongoose from 'mongoose';

const poItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  quantity: { type: Number, required: true, min: 1 },
  unit: { type: String, default: 'Box' },
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 18 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  receivedQty: { type: Number, default: 0 },
  pendingQty: { type: Number, default: 0 },
});

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    receivingWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    poDate: { type: Date, default: Date.now },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: String,

    items: [poItemSchema],

    subtotal: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    freight: { type: Number, default: 0 },
    loading: { type: Number, default: 0 },
    insurance: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    paymentTerms: { type: String, default: '' },
    expectedDeliveryDate: Date,
    deliveryAddress: { type: String, default: '' },
    remarks: { type: String, default: '' },

    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'approved', 'sent', 'partial_received', 'received', 'cancelled'],
      default: 'draft',
    },

    approvalWorkflow: [{
      level: Number,
      approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      status: { type: String, enum: ['pending', 'approved', 'rejected'] },
      date: Date,
      remarks: String,
    }],

    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,
    tallyGUID: String,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

purchaseOrderSchema.index({ branch: 1, status: 1, poDate: -1 });
purchaseOrderSchema.index({ branch: 1, supplier: 1, status: 1 });
purchaseOrderSchema.index({ branch: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ supplier: 1, status: 1 });
purchaseOrderSchema.index({ status: 1, poDate: -1 });

export default mongoose.model('PurchaseOrder', purchaseOrderSchema);
