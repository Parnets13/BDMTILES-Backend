import mongoose from 'mongoose';

const loadingItemSchema = new mongoose.Schema({
  pickListItem: { type: mongoose.Schema.Types.ObjectId },
  salesOrderItem: { type: mongoose.Schema.Types.ObjectId },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productCode: { type: String, default: '' },
  productName: { type: String, default: '' },
  productImage: { type: String, default: '' },
  quantity: { type: Number, default: 0, min: 0 },
  unit: { type: String, default: 'Box' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  boxContext: { type: String, default: '' },
}, { _id: false });

const finalDispatchVerificationSchema = new mongoose.Schema({
  vehicleConfirmed: { type: Boolean, default: false },
  sealConfirmed: { type: Boolean, default: false },
  sealNumber: { type: String, default: '' },
  invoiceConfirmed: { type: Boolean, default: false },
  eWayBillConfirmed: { type: Boolean, default: false },
  lrDocumentConfirmed: { type: Boolean, default: false },
  finalOrderCount: { type: Number, default: 0, min: 0 },
  finalBoxCount: { type: Number, default: 0, min: 0 },
  remarks: { type: String, default: '' },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
  completed: { type: Boolean, default: false },
}, { _id: false });

const tripOrderSchema = new mongoose.Schema({
  pickList: { type: mongoose.Schema.Types.ObjectId, ref: 'PickList' },
  salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true },
  orderNumber: String,
  dealerName: String,
  dealerCode: String,
  deliveryAddress: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  totalBoxes: { type: Number, default: 0 },
  totalWeight: { type: Number, default: 0 },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  invoiceNumber: { type: String, default: '' },
  pickListNumber: { type: String, default: '' },
  // Loading verification
  loadingVerified: { type: Boolean, default: false },
  loadedBoxes: { type: Number, default: 0 },
  loadingRemarks: { type: String, default: '' },
  loadingItems: { type: [loadingItemSchema], default: [] },
  // Delivery sequence
  sequence: { type: Number, default: 0 },
  // Delivery status
  deliveryStatus: {
    type: String,
    enum: ['pending', 'in_transit', 'delivered', 'partially_delivered', 'failed', 'rescheduled'],
    default: 'pending',
  },
});

const dispatchTripSchema = new mongoose.Schema(
  {
    tripNumber: { type: String, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    tripDate: { type: Date, default: Date.now },

    // Vehicle
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    vehicleNumber: { type: String, default: '' },
    vehicleType: { type: String, default: '' },
    vehicleCapacity: { type: String, default: '' },

    // Driver
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },

    // Delivery executive
    deliveryExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deliveryExecutiveName: { type: String, default: '' },

    // Orders in this trip
    orders: [tripOrderSchema],

    // Route
    routeName: { type: String, default: '' },
    estimatedDistance: { type: Number, default: 0 },
    estimatedTime: { type: String, default: '' },

    // Status
    status: {
      type: String,
      enum: ['planning', 'loading', 'loaded', 'dispatched', 'in_transit', 'completed', 'cancelled'],
      default: 'planning',
    },

    // Timing
    loadingStartTime: Date,
    loadingEndTime: Date,
    dispatchTime: Date,
    completionTime: Date,

    // Loading verification
    totalOrders: { type: Number, default: 0 },
    totalBoxes: { type: Number, default: 0 },
    totalWeight: { type: Number, default: 0 },
    loadedBoxes: { type: Number, default: 0 },
    loadingSupervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    loadingVerified: { type: Boolean, default: false },

    // Separate gate completed after loading and before stock consumption
    finalDispatchVerification: { type: finalDispatchVerificationSchema, default: () => ({}) },

    // Prevent concurrent/retried dispatch from applying stock twice
    dispatchProcessing: { type: Boolean, default: false },
    stockDeductedAt: Date,

    // Documents
    eWayBillNumber: { type: String, default: '' },
    lrNumber: { type: String, default: '' },

    // Notes
    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dispatchTripSchema.index({ branch: 1, status: 1, tripDate: -1 });
dispatchTripSchema.index({ branch: 1, tripNumber: 1 }, { unique: true });
dispatchTripSchema.index({ status: 1 });
dispatchTripSchema.index({ tripDate: -1 });
dispatchTripSchema.index({ vehicle: 1 });

export default mongoose.model('DispatchTrip', dispatchTripSchema);
