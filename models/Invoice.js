import mongoose from 'mongoose';

const invoiceItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  hsnCode: { type: String, default: '' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  quantity: { type: Number, default: 0 },
  unit: { type: String, default: 'Box' },
  boxes: { type: Number, default: 0 },
  pieces: { type: Number, default: 0 },
  sqft: { type: Number, default: 0 },
  rate: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  discountType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
  discountAmount: { type: Number, default: 0 },
  schemeDiscount: { type: Number, default: 0 },
  taxableAmount: { type: Number, default: 0 },
  gstPercentage: { type: Number, default: 18 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
});

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, unique: true, required: true },
    invoiceDate: { type: Date, default: Date.now },

    // Type
    invoiceType: {
      type: String,
      enum: ['tax_invoice', 'retail_invoice', 'proforma', 'delivery_challan', 'credit_note', 'debit_note'],
      default: 'tax_invoice',
    },

    // GST classification
    gstType: { type: String, enum: ['output', 'input'], default: 'output' }, // output = sales to dealer/customer, input = purchase from supplier
    isInterState: { type: Boolean, default: false }, // true = IGST, false = CGST+SGST

    // Source reference
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    orderNumber: String,

    // Seller details (company)
    sellerName: { type: String, default: 'BDM GRANIMARMO PRIVATE LIMITED' },
    sellerGstin: { type: String, default: '' },
    sellerAddress: { type: String, default: '' },
    sellerState: { type: String, default: '' },
    sellerStateCode: { type: String, default: '' },

    // Buyer details
    buyerType: { type: String, enum: ['dealer', 'wholesaler', 'retail', 'distributor', 'builder', 'customer'], default: 'dealer' },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    buyerName: String,
    buyerCode: String,
    buyerGstin: { type: String, default: '' },
    buyerPan: { type: String, default: '' },
    buyerAddress: { type: String, default: '' },
    buyerCity: { type: String, default: '' },
    buyerState: { type: String, default: '' },
    buyerStateCode: { type: String, default: '' },
    buyerPhone: { type: String, default: '' },

    // Delivery address (if different)
    deliveryAddress: { type: String, default: '' },

    // Items
    items: [invoiceItemSchema],

    // Totals
    subtotal: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    totalSchemeDiscount: { type: Number, default: 0 },
    taxableTotal: { type: Number, default: 0 },
    totalCgst: { type: Number, default: 0 },
    totalSgst: { type: Number, default: 0 },
    totalIgst: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    freightCharges: { type: Number, default: 0 },
    loadingCharges: { type: Number, default: 0 },
    installationCharges: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    amountInWords: { type: String, default: '' },

    // Payment
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
    paidAmount: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },
    paymentTerms: { type: String, default: '' },
    dueDate: Date,

    // E-Invoice / E-Way Bill
    eInvoiceIrn: { type: String, default: '' },
    eInvoiceAckNo: { type: String, default: '' },
    eInvoiceAckDate: Date,
    eWayBillNo: { type: String, default: '' },
    eWayBillDate: Date,
    eWayBillValidUpto: Date,

    // Transport
    transportMode: { type: String, default: '' },
    vehicleNumber: { type: String, default: '' },
    transporterName: { type: String, default: '' },
    transporterGstin: { type: String, default: '' },
    lrNumber: { type: String, default: '' },
    lrDate: Date,

    // Status
    status: { type: String, enum: ['draft', 'generated', 'sent', 'cancelled'], default: 'generated' },
    cancelReason: String,

    // Notes
    remarks: { type: String, default: '' },
    termsAndConditions: { type: String, default: '' },
    internalNotes: { type: String, default: '' },

    // Metadata
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

invoiceSchema.index({ invoiceNumber: 1 });
invoiceSchema.index({ salesOrder: 1 });
invoiceSchema.index({ dealer: 1 });
invoiceSchema.index({ invoiceDate: -1 });
invoiceSchema.index({ status: 1 });

export default mongoose.model('Invoice', invoiceSchema);
