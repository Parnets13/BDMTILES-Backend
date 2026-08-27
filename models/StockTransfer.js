import mongoose from 'mongoose';

const transferItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productCode: String,
  productName: String,
  productImage: { type: String, default: '' },
  shade: { type: String, default: '' },
  batch: { type: String, default: '' },
  requestedQty: { type: Number, required: true, min: 1 },
  dispatchedQty: { type: Number, default: 0 },
  receivedQty: { type: Number, default: 0 },
  damagedQty: { type: Number, default: 0 },
  shortQty: { type: Number, default: 0 },
  unit: { type: String, default: 'Box' },
  remarks: { type: String, default: '' },
});

const stockTransferSchema = new mongoose.Schema(
  {
    transferNumber: { type: String, required: true },
    sourceBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    destinationBranch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    transferDate: { type: Date, default: Date.now },

    // Source and destination
    fromWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    toWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    fromWarehouseName: String,
    toWarehouseName: String,

    // Transfer type
    transferType: {
      type: String,
      enum: ['warehouse_to_warehouse', 'branch_to_branch', 'warehouse_to_showroom'],
      default: 'warehouse_to_warehouse',
    },

    // Items
    items: [transferItemSchema],

    // Status workflow: requested → approved → dispatched → in_transit → received → completed
    status: {
      type: String,
      enum: ['requested', 'approved', 'dispatched', 'in_transit', 'received', 'completed', 'rejected', 'cancelled'],
      default: 'requested',
    },

    // Priority
    priority: { type: String, enum: ['normal', 'urgent', 'critical'], default: 'normal' },

    // Approval
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalDate: Date,
    approvalRemarks: { type: String, default: '' },
    rejectionReason: { type: String, default: '' },

    // Dispatch
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    dispatchDate: Date,
    vehicleNumber: { type: String, default: '' },
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },
    transitId: { type: String, default: '' },

    // Receiving
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedDate: Date,
    receivingRemarks: { type: String, default: '' },

    // Notes
    reason: { type: String, default: '' },
    remarks: { type: String, default: '' },

    // Totals
    totalItems: { type: Number, default: 0 },
    totalRequestedQty: { type: Number, default: 0 },
    totalDispatchedQty: { type: Number, default: 0 },
    totalReceivedQty: { type: Number, default: 0 },
  },
  { timestamps: true }
);

stockTransferSchema.index({ sourceBranch: 1, status: 1, transferDate: -1 });
stockTransferSchema.index({ destinationBranch: 1, status: 1, transferDate: -1 });
stockTransferSchema.index({ sourceBranch: 1, transferNumber: 1 }, { unique: true });
stockTransferSchema.index({ status: 1 });
stockTransferSchema.index({ fromWarehouse: 1 });
stockTransferSchema.index({ toWarehouse: 1 });
stockTransferSchema.index({ transferDate: -1 });

export default mongoose.model('StockTransfer', stockTransferSchema);
