import mongoose from 'mongoose';

const dispatchItemSchema = new mongoose.Schema({
  salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
  orderNumber: String,
  dealerName: String,
  deliveryAddress: String,
  items: [{ productName: String, quantity: Number, unit: String }],
  estimatedWeight: { type: Number, default: 0 },
});

const dispatchSchema = new mongoose.Schema(
  {
    dispatchNumber: { type: String, unique: true, required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    dispatchDate: { type: Date, default: Date.now },
    // `vehicle` predates Vehicle Master and holds the registration number as text.
    // Existing documents rely on it, so it stays as the display value while
    // vehicleRef carries the actual master link for new records.
    vehicle: { type: String, default: '' },
    vehicleRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    vehicleType: { type: String, default: '' },
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },
    // User Management account linked through Vehicle Master at assignment time.
    deliveryExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deliveryExecutiveName: { type: String, default: '' },
    route: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
    routeName: String,
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' },
    orders: [dispatchItemSchema],
    totalOrders: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['planned', 'loaded', 'in_transit', 'partially_delivered', 'completed', 'cancelled'],
      default: 'planned',
    },
    departureTime: Date,
    estimatedArrival: Date,
    remarks: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

dispatchSchema.index({ branch: 1, dispatchNumber: 1 });
dispatchSchema.index({ branch: 1, status: 1, dispatchDate: -1 });
dispatchSchema.index({ branch: 1, deliveryExecutive: 1, status: 1 });

export default mongoose.model('Dispatch', dispatchSchema);
