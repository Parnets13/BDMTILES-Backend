import mongoose from 'mongoose';

const notificationTemplateSchema = new mongoose.Schema(
  {
    // Optional only for pre-branch legacy rows. All API writes require and set this field.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    templateCode: { type: String, required: true },
    templateName: { type: String, required: true },
    channel: { type: String, enum: ['whatsapp', 'sms', 'email', 'push'], required: true },
    event: { type: String, enum: [
      'order_confirmation', 'invoice_generated', 'payment_received', 'payment_reminder',
      'dispatch_notification', 'delivery_notification', 'delivery_otp',
      'scheme_alert', 'credit_alert', 'overdue_reminder',
      'quotation_sent', 'complaint_update', 'birthday_wish', 'custom'
    ], required: true },
    subject: { type: String, default: '' },
    body: { type: String, required: true },
    // Variables: {{dealerName}}, {{orderNumber}}, {{amount}}, {{invoiceNumber}}, {{otp}}, etc.
    variables: [String],
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

notificationTemplateSchema.index({ branch: 1, templateCode: 1 }, { unique: true });
notificationTemplateSchema.index({ branch: 1, event: 1, channel: 1 });
notificationTemplateSchema.index({ branch: 1, isActive: 1 });

export default mongoose.model('NotificationTemplate', notificationTemplateSchema);
