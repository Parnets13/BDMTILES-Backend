import mongoose from 'mongoose';

/**
 * Dealer ↔ sales executive chat (SOW 17.8 "Chat with assigned sales executive").
 *
 * A single conversation per dealer, addressed to their assigned executive.
 * Messages may optionally be tied to a complaint so support threads stay in
 * context. Delivery is pull-based (the app polls) — no socket infrastructure is
 * assumed.
 */
const dealerMessageSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer', required: true, index: true },

    // Who wrote it. 'dealer' messages come from the app; 'executive' from staff.
    senderRole: { type: String, enum: ['dealer', 'executive'], required: true },
    salesExecutive: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    senderName: { type: String, default: '' },

    body: { type: String, required: true, trim: true, maxlength: 2000 },
    attachments: { type: [String], default: [] },

    // Optional context
    complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint' },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },

    // Read receipts, tracked per side.
    readByDealerAt: { type: Date, default: null },
    readByExecutiveAt: { type: Date, default: null },
  },
  { timestamps: true }
);

dealerMessageSchema.index({ dealer: 1, createdAt: -1 });
dealerMessageSchema.index({ dealer: 1, senderRole: 1, readByDealerAt: 1 });

export default mongoose.model('DealerMessage', dealerMessageSchema);
