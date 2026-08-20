import mongoose from 'mongoose';

const deliverySchema = new mongoose.Schema(
  {
    deliveryNumber: { type: String, unique: true, required: true },
    deliveryDate: { type: Date, default: Date.now },

    // Source references
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    orderNumber: String,
    dispatchTrip: { type: mongoose.Schema.Types.ObjectId, ref: 'DispatchTrip' },
    tripNumber: String,
    invoiceNumber: { type: String, default: '' },

    // Customer/Dealer
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    dealerName: String,
    dealerCode: String,
    contactPhone: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },

    // Delivery executive
    deliveryExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deliveryExecutiveName: { type: String, default: '' },

    // Items summary
    totalBoxes: { type: Number, default: 0 },
    deliveredBoxes: { type: Number, default: 0 },
    shortBoxes: { type: Number, default: 0 },
    damagedBoxes: { type: Number, default: 0 },
    returnedBoxes: { type: Number, default: 0 },

    // OTP verification
    otp: { type: String, default: '' },
    otpVerified: { type: Boolean, default: false },
    otpVerifiedAt: Date,

    // Proof of delivery
    podImage: { type: String, default: '' },
    podSignature: { type: String, default: '' },
    invoiceImage: { type: String, default: '' },

    // Payment collection at delivery
    paymentCollected: { type: Boolean, default: false },
    collectedAmount: { type: Number, default: 0 },
    paymentMode: { type: String, enum: ['none', 'cash', 'cheque', 'upi', 'bank_transfer'], default: 'none' },
    chequeNumber: { type: String, default: '' },
    utrNumber: { type: String, default: '' },

    // Status
    status: {
      type: String,
      enum: ['assigned', 'in_transit', 'reached', 'delivered', 'partially_delivered', 'failed', 'rescheduled', 'returned'],
      default: 'assigned',
    },

    // Failure details
    failureReason: {
      type: String,
      enum: ['', 'customer_unavailable', 'wrong_address', 'payment_pending', 'vehicle_issue', 'product_damaged', 'product_rejected', 'delivery_delayed', 'other'],
      default: '',
    },
    failureRemarks: { type: String, default: '' },
    rescheduleDate: Date,

    // Timing
    startTime: Date,
    reachTime: Date,
    completionTime: Date,

    // GPS location
    deliveryLocation: {
      lat: { type: Number, default: 0 },
      lng: { type: Number, default: 0 },
    },

    // Notes
    deliveryRemarks: { type: String, default: '' },
    customerFeedback: { type: String, default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

deliverySchema.index({ deliveryNumber: 1 });
deliverySchema.index({ salesOrder: 1 });
deliverySchema.index({ dispatchTrip: 1 });
deliverySchema.index({ status: 1 });
deliverySchema.index({ deliveryExecutive: 1 });
deliverySchema.index({ deliveryDate: -1 });

export default mongoose.model('Delivery', deliverySchema);
