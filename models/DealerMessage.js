import mongoose from 'mongoose';

/**
 * Dealer ↔ sales executive chat (SOW 17.8 "Chat with assigned sales executive").
 *
 * A single conversation per dealer, addressed to their assigned executive.
 * Messages may optionally be tied to a complaint so support threads stay in
 * context.
 *
 * Delivery is realtime: a `post('save')` hook broadcasts the message over
 * socket.io (see services/socketService.js). Clients still refetch on demand, so
 * a dropped socket degrades to a stale screen rather than a broken one.
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

    // Read receipts, tracked per side. Admin/support read state is kept separate
    // from the assigned executive's: back-office staff monitoring a thread must
    // not clear the executive's unread badge, or the executive never learns the
    // dealer wrote in.
    readByDealerAt: { type: Date, default: null },
    readByExecutiveAt: { type: Date, default: null },
    readByAdminAt: { type: Date, default: null },

    // Set when the message was sent from the web admin support desk rather than by
    // the dealer's own assigned executive. senderRole stays 'executive' so both
    // apps keep rendering it on the staff side of the conversation.
    sentFromSupportDesk: { type: Boolean, default: false },
  },
  { timestamps: true }
);

dealerMessageSchema.index({ dealer: 1, createdAt: -1 });
dealerMessageSchema.index({ dealer: 1, senderRole: 1, readByDealerAt: 1 });
dealerMessageSchema.index({ branch: 1, senderRole: 1, readByAdminAt: 1 });

/**
 * Broadcast the message to everyone watching this thread.
 *
 * A model hook rather than an emit inside each route, so none of the three write
 * paths — dealer app, Sales Executive app, support desk — can forget to notify the
 * other side. A missed emit is invisible until somebody reports that chat
 * "sometimes" does not update, which is exactly the failure worth designing out.
 *
 * The import is dynamic because socketService imports this model; a static import
 * here would be a cycle. Delivery is fire-and-forget on purpose — realtime is
 * best-effort and must never affect whether the message itself was saved.
 */
dealerMessageSchema.post('save', function notifyRealtime(doc) {
  import('../services/socketService.js')
    .then(({ emitNewMessage }) => emitNewMessage(doc))
    .catch(() => { /* the message is saved; realtime is the only thing lost */ });
});

export default mongoose.model('DealerMessage', dealerMessageSchema);
