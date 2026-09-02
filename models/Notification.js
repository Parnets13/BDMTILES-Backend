import mongoose from 'mongoose';

const channelAttemptSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: ['web', 'email', 'whatsapp', 'sms', 'push'], required: true },
    status: { type: String, enum: ['queued', 'delivered', 'failed', 'skipped'], required: true, default: 'queued' },
    provider: { type: String, default: '' },
    providerMessageId: { type: String, default: '' },
    error: { type: String, default: '' },
    attemptedAt: Date,
    deliveredAt: Date,
  },
  { _id: false }
);

const notificationSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    module: { type: String, required: true, trim: true, lowercase: true },
    event: { type: String, required: true, trim: true, lowercase: true },
    eventKey: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 250 },
    body: { type: String, required: true, maxlength: 5000 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    deepLink: { type: String, default: '', maxlength: 1000 },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientRole: { type: String, default: '' },
    readAt: Date,
    deliveryState: { type: String, enum: ['queued', 'delivered', 'failed', 'skipped'], default: 'queued' },
    channelAttempts: [channelAttemptSchema],
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

notificationSchema.index({ branch: 1, eventKey: 1, recipient: 1 }, { unique: true });
notificationSchema.index({ branch: 1, recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ branch: 1, deliveryState: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
