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
    dispatchDate: { type: Date, default: Date.now },
    vehicle: { type: String, default: '' },
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },
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

dispatchSchema.index({ dispatchNumber: 1 });
dispatchSchema.index({ status: 1, dispatchDate: -1 });

export default mongoose.model('Dispatch', dispatchSchema);
