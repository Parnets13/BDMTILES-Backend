import mongoose from 'mongoose';

const tripOrderSchema = new mongoose.Schema({
  salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
  orderNumber: String,
  dealerName: String,
  dealerCode: String,
  deliveryAddress: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  totalBoxes: { type: Number, default: 0 },
  totalWeight: { type: Number, default: 0 },
  invoiceNumber: { type: String, default: '' },
  pickListNumber: { type: String, default: '' },
  // Loading verification
  loadingVerified: { type: Boolean, default: false },
  loadedBoxes: { type: Number, default: 0 },
  loadingRemarks: { type: String, default: '' },
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
    tripNumber: { type: String, unique: true, required: true },
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

    // Documents
    eWayBillNumber: { type: String, default: '' },
    lrNumber: { type: String, default: '' },

    // Notes
    remarks: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dispatchTripSchema.index({ tripNumber: 1 });
dispatchTripSchema.index({ status: 1 });
dispatchTripSchema.index({ tripDate: -1 });
dispatchTripSchema.index({ vehicle: 1 });

export default mongoose.model('DispatchTrip', dispatchTripSchema);
