import mongoose from 'mongoose';

const salesOrderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  shade: { type: String, default: '' },        // Shade tracking (tile-specific)
  batch: { type: String, default: '' },        // Batch tracking (tile-specific)
  quantity: { type: Number, required: true, min: 1 },
  unit: { type: String, default: 'Box' },
  boxes: { type: Number, default: 0 },
  pieces: { type: Number, default: 0 },
  sqft: { type: Number, default: 0 },
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 },
  discountType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
  schemeDiscount: { type: Number, default: 0 },
  taxableAmount: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 18 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
});

const salesOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true, required: true },
    orderDate: { type: Date, default: Date.now },

    // Customer/Dealer
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerName: String,
    dealerCode: String,
    customerName: String,
    customerPhone: String,
    orderType: { type: String, enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', 'online', 'project'], default: 'dealer' },

    // Items with shade/batch
    items: [salesOrderItemSchema],

    // Totals
    subtotal: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    totalSchemeDiscount: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    freightCharges: { type: Number, default: 0 },
    loadingCharges: { type: Number, default: 0 },
    installationCharges: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    advanceAmount: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },

    // Delivery
    deliveryAddress: { type: String, default: '' },
    expectedDeliveryDate: Date,
    deliveryPriority: { type: String, enum: ['normal', 'urgent', 'vip'], default: 'normal' },

    // Status
    status: {
      type: String,
      enum: ['draft', 'confirmed', 'approved', 'processing', 'partial_dispatch', 'dispatched', 'delivered', 'cancelled', 'expired'],
      default: 'draft',
    },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid', 'overdue'], default: 'pending' },

    // Approval (if credit limit exceeded or rate below minimum)
    creditLimitExceeded: { type: Boolean, default: false },
    approvalStatus: { type: String, enum: ['not_required', 'pending', 'approved', 'rejected'], default: 'not_required' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: String,

    // References
    salesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    branch: { type: String, default: '' },
    remarks: { type: String, default: '' },
    internalNotes: { type: String, default: '' },
    cancellationReason: String,

    // Modification tracking (audit)
    modificationLogs: [{
      field: String,
      oldValue: mongoose.Schema.Types.Mixed,
      newValue: mongoose.Schema.Types.Mixed,
      changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      changedAt: { type: Date, default: Date.now },
      reason: String,
    }],

    // Tally Integration fields
    tallySyncStatus: { type: String, enum: ['not_synced', 'pending', 'synced', 'failed'], default: 'not_synced' },
    tallyVoucherNumber: String,
    tallyGUID: String,
    tallySyncDate: Date,
    tallySyncError: String,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Indexes
salesOrderSchema.index({ orderNumber: 1 });
salesOrderSchema.index({ dealer: 1, status: 1 });
salesOrderSchema.index({ status: 1, orderDate: -1 });
salesOrderSchema.index({ salesExecutive: 1 });
salesOrderSchema.index({ tallySyncStatus: 1 });
salesOrderSchema.index({ createdAt: -1 });

export default mongoose.model('SalesOrder', salesOrderSchema);
