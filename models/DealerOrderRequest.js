import mongoose from 'mongoose';

const dealerSnapshotSchema = new mongoose.Schema({
  businessName: { type: String, required: true },
  dealerCode: { type: String, default: '' },
  ownerName: { type: String, default: '' },
  mobile: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
}, { _id: false });

const requestItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: { type: String, default: '' },
  productName: { type: String, required: true },
  productImage: { type: String, default: '' },
  unit: { type: String, default: 'Box' },
  tileSize: { type: String, default: '' },
  finish: { type: String, default: '' },
  colour: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 0.000001 },
  boxes: { type: Number, required: true, min: 0.000001 },
  pieces: { type: Number, required: true, min: 0.000001 },
  sqft: { type: Number, required: true, min: 0.000001 },
  piecesPerBox: { type: Number, required: true, min: 0.000001 },
  sqftPerBox: { type: Number, required: true, min: 0.000001 },
}, { _id: false });

// One recorded change to a request's lines, so a dealer can see that the branch
// adjusted what they asked for and why. Requests carry no money, so an edit can
// only ever change quantities or the set of products.
const requestEditSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, default: '' },
  reason: { type: String, trim: true, maxlength: 500, default: '' },
  changes: [{
    _id: false,
    type: { type: String, enum: ['quantity', 'added', 'removed'], required: true },
    productName: { type: String, default: '' },
    from: { type: Number, default: null },
    to: { type: Number, default: null },
  }],
}, { _id: false });

// A snapshot of the stock picture the branch was looking at when they decided how
// to split the request. `planHash` is the same hash the quotation split uses, so a
// plan that was computed against stale stock is rejected instead of being acted on.
const stockPlanLineSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, default: '' },
  unit: { type: String, default: 'Box' },
  requestedQty: { type: Number, required: true, min: 0 },
  availableQty: { type: Number, default: 0, min: 0 },
  allocatedQty: { type: Number, default: 0, min: 0 },
  shortfallQty: { type: Number, default: 0, min: 0 },
}, { _id: false });

const stockPlanSchema = new mongoose.Schema({
  computedAt: { type: Date, default: Date.now },
  computedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  planHash: { type: String, default: '' },
  lines: { type: [stockPlanLineSchema], default: [] },
}, { _id: false });

// One line of one shortfall round. The quantities here only ever describe the part
// of the line that could NOT be reserved. An already-created Sales Order is never
// affected by what the dealer answers here, even if they change the quantity.
const shortfallLineSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: { type: String, default: '' },
  productName: { type: String, default: '' },
  productImage: { type: String, default: '' },
  unit: { type: String, default: 'Box' },
  // What the dealer originally asked for on this line, for context in the app.
  requestedQty: { type: Number, required: true, min: 0 },
  // How much of the line has already been reserved and turned into a Sales Order.
  processedQty: { type: Number, default: 0, min: 0 },
  // The quantity this round is asking the dealer about.
  shortfallQty: { type: Number, required: true, min: 0 },
  // Staff's expected availability date. Expected, never a delivery promise.
  expectedDate: { type: Date, default: null },
  noEta: { type: Boolean, default: false },
  staffRemark: { type: String, trim: true, maxlength: 500, default: '' },
  dealerResponse: {
    type: String,
    enum: ['pending', 'accepted', 'changed', 'rejected'],
    default: 'pending',
  },
  // Only meaningful when dealerResponse is 'changed'. The dealer may go up or down.
  dealerQty: { type: Number, default: null, min: 0 },
  dealerRemark: { type: String, trim: true, maxlength: 500, default: '' },
  respondedAt: { type: Date, default: null },
  // The quantity that finally stands for this line once the round is settled.
  settledQty: { type: Number, default: 0, min: 0 },
}, { _id: false });

const shortfallRoundSchema = new mongoose.Schema({
  round: { type: Number, required: true, min: 1 },
  offeredAt: { type: Date, default: Date.now },
  offeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  offeredByName: { type: String, default: '' },
  offerRemark: { type: String, trim: true, maxlength: 1000, default: '' },
  lines: { type: [shortfallLineSchema], default: [] },
  respondedAt: { type: Date, default: null },
  dealerRemark: { type: String, trim: true, maxlength: 1000, default: '' },
  outcome: {
    type: String,
    // `changed` means the dealer altered quantities, so staff must reconfirm the
    // expected availability before the round can be settled.
    enum: ['pending', 'accepted', 'changed', 'rejected', 'superseded'],
    default: 'pending',
  },
  settledAt: { type: Date, default: null },
  settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

// Every Sales Order this request produced. A stock split means one request can
// become more than one order, so the app reads this list instead of guessing from
// a single quotation link.
const requestOutcomeSchema = new mongoose.Schema({
  kind: { type: String, enum: ['available', 'shortfall'], required: true },
  quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
  salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const dealerOrderRequestSchema = new mongoose.Schema({
  requestNumber: { type: String, required: true, trim: true },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true },
  dealerSnapshot: { type: dealerSnapshotSchema, required: true },
  salesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  salesExecutiveName: { type: String, default: '' },
  items: {
    type: [requestItemSchema],
    validate: {
      validator: value => Array.isArray(value) && value.length > 0 && value.length <= 100,
      message: 'A request requires between 1 and 100 items.',
    },
  },
  remarks: { type: String, trim: true, maxlength: 2000, default: '' },
  // Dealer's delivery preference, captured in the app. Advisory only — the sales
  // executive confirms the final address and date when converting to a quotation.
  deliveryAddress: { type: String, trim: true, maxlength: 500, default: '' },
  expectedDeliveryDate: { type: Date, default: null },
  status: {
    type: String,
    enum: [
      'submitted',
      'approved',
      'rejected',
      // Part of the request was reserved and ordered; the rest is with the dealer.
      'partially_processed',
      // Nothing could be reserved, so the whole request is with the dealer.
      'awaiting_dealer',
      // Agreed with the dealer, but nothing is reserved yet: it is queued for the
      // next GRN. Distinct from awaiting_dealer, where the ball is in their court.
      'awaiting_stock',
      'quotation_linked',
      'cancelled',
    ],
    default: 'submitted',
  },
  revision: { type: Number, default: 0, min: 0 },
  submittedAt: { type: Date, default: Date.now },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  approvalRemarks: { type: String, trim: true, maxlength: 1000, default: '' },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: Date,
  rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
  cancelledAt: Date,
  cancellationReason: { type: String, trim: true, maxlength: 1000, default: '' },
  sourceQuotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
  linkedAt: Date,
  linkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Set when the linked quotation is converted, so the request can report the
  // order it finally became without the app having to walk the chain itself.
  sourceSalesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
  convertedAt: Date,
  // --- stock-aware processing ---
  // The plan the branch last previewed. Acting on it re-checks `planHash` first.
  stockPlan: { type: stockPlanSchema, default: null },
  // The quotation family produced by processing: the immutable split parent, the
  // available child that became a Sales Order, and the pending-stock child (if the
  // dealer accepts a shortfall). `sourceQuotation` still points at the parent.
  availableQuotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
  pendingStockQuotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
  // Set when the pending-stock quantity was finally reserved and ordered.
  pendingStockFulfilledAt: Date,
  processedAt: Date,
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  outcomes: { type: [requestOutcomeSchema], default: [] },
  shortfallStatus: {
    type: String,
    enum: ['none', 'awaiting_dealer', 'needs_reconfirmation', 'accepted', 'rejected', 'closed'],
    default: 'none',
  },
  shortfallRounds: { type: [shortfallRoundSchema], default: [] },
  shortfallSettledAt: Date,
  editHistory: { type: [requestEditSchema], default: [] },
  editedAt: Date,
  editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  sourceKey: { type: String, required: true },
  requestFingerprint: { type: String, required: true },
  approvedFingerprint: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

dealerOrderRequestSchema.index({ branch: 1, requestNumber: 1 }, { unique: true });
dealerOrderRequestSchema.index({ sourceKey: 1 }, { unique: true });
dealerOrderRequestSchema.index({ branch: 1, status: 1, createdAt: -1 });
dealerOrderRequestSchema.index({ branch: 1, salesExecutive: 1, createdAt: -1 });
dealerOrderRequestSchema.index({ branch: 1, dealer: 1, createdAt: -1 });
dealerOrderRequestSchema.index(
  { branch: 1, sourceQuotation: 1 },
  { unique: true, partialFilterExpression: { sourceQuotation: { $type: 'objectId' } } },
);
// Drives the dealer app's "needs your response" badge and the branch's follow-up list.
dealerOrderRequestSchema.index({ branch: 1, dealer: 1, shortfallStatus: 1, updatedAt: -1 });

export default mongoose.model('DealerOrderRequest', dealerOrderRequestSchema);
