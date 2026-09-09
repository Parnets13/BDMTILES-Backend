import mongoose from 'mongoose';

const pickItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  hsnCode: { type: String, default: '' },
  barcode: { type: String, default: '' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  salesOrderItem: { type: mongoose.Schema.Types.ObjectId },
  allocatedQty: { type: Number, default: 0, min: 0 },
  requestedQty: { type: Number, required: true, min: 0.000001 },
  pickedQty: { type: Number, default: 0 },
  dispatchedQty: { type: Number, default: 0 },
  packedQty: { type: Number, default: 0 },
  shortQty: { type: Number, default: 0 },
  shortReason: { type: String, default: '' },
  damagedQty: { type: Number, default: 0 },
  unit: { type: String, default: 'Box' },
  warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
  warehouseName: { type: String, default: '' },
  rackLocation: { type: String, default: '' },
  // Verification
  barcodeVerified: { type: Boolean, default: false },
  shadeConfirmed: { type: Boolean, default: false },
  batchConfirmed: { type: Boolean, default: false },
  // Sorting verification (evidence only; sorting never moves stock)
  sortedQty: { type: Number, default: 0, min: 0 },
  sortingShortQty: { type: Number, default: 0, min: 0 },
  sortingDamagedQty: { type: Number, default: 0, min: 0 },
  sortingBarcodeConfirmed: { type: Boolean, default: false },
  sortingShadeConfirmed: { type: Boolean, default: false },
  sortingBatchConfirmed: { type: Boolean, default: false },
  sortingRemarks: { type: String, default: '' },
  sortingVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  sortingVerifiedAt: Date,
  // Loading verification (vehicle loading; evidence only, does not move stock)
  loadingBarcodeConfirmed: { type: Boolean, default: false },
  loadingVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  loadingVerifiedAt: Date,
  loadingRemarks: { type: String, default: '' },
  // Status per item
  status: { type: String, enum: ['pending', 'picked', 'short', 'damaged', 'substituted'], default: 'pending' },
  remarks: { type: String, default: '' },
});

const pickListSchema = new mongoose.Schema(
  {
    pickListNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    pickDate: { type: Date, default: Date.now },

    // Source: Sales Order
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true },
    orderNumber: String,
    dealerName: String,
    dealerCode: String,

    // Assignment
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: { type: String, default: '' },
    assignedAt: Date,

    // Items
    items: [pickItemSchema],

    // Status
    status: {
      type: String,
      enum: ['generated', 'assigned', 'in_progress', 'picked', 'verified', 'sorted', 'packed', 'ready_for_dispatch', 'loaded', 'cancelled'],
      default: 'generated',
    },

    // Priority
    priority: { type: String, enum: ['normal', 'urgent', 'vip'], default: 'normal' },

    // Timing
    pickingStartTime: Date,
    pickingEndTime: Date,
    sortingStartTime: Date,
    sortingEndTime: Date,
    packingEndTime: Date,
    loadingEndTime: Date,

    // Sorting & Packing
    sortedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    packedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    loadingVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    totalBoxes: { type: Number, default: 0 },
    totalWeight: { type: Number, default: 0 },

    // Delivery route grouping
    deliveryRoute: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },

    // Notes
    remarks: { type: String, default: '' },
    supervisorRemarks: { type: String, default: '' },

    // Totals
    totalItems: { type: Number, default: 0 },
    totalRequestedQty: { type: Number, default: 0 },
    totalPickedQty: { type: Number, default: 0 },
    totalShortQty: { type: Number, default: 0 },

    // Stock reservation lifecycle
    fulfillmentKey: { type: String, unique: true, sparse: true },
    stockReserved: { type: Boolean, default: false },
    reservationState: { type: String, enum: ['none', 'pending', 'reserved', 'adjusting', 'adjusted', 'consuming', 'consumed', 'released'], default: 'none' },
    reservedAt: Date,
    reservationAdjustedAt: Date,
    reservationReleasedAt: Date,
    stockConsumedAt: Date,
    pickingCompletionProcessing: { type: Boolean, default: false },
    sortingVerificationProcessing: { type: Boolean, default: false },
    loadingVerificationProcessing: { type: Boolean, default: false },
    cancellationProcessing: { type: Boolean, default: false },
    stockConsumptionProcessing: { type: Boolean, default: false },

    // Exclusive dispatch-trip ownership
    dispatchTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'DispatchTrip' },
    dispatchTripNumber: { type: String, default: '' },
    tripClaimedAt: Date,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

pickListSchema.index({ branch: 1, status: 1, priority: -1, createdAt: -1 });
pickListSchema.index({ branch: 1, salesOrder: 1 });
pickListSchema.index({ branch: 1, pickListNumber: 1 }, { unique: true });
pickListSchema.index({ salesOrder: 1 });
pickListSchema.index({ status: 1 });
pickListSchema.index({ assignedTo: 1 });
pickListSchema.index({ priority: -1, createdAt: -1 });

export default mongoose.model('PickList', pickListSchema);
