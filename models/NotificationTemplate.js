import mongoose from 'mongoose';

const notificationTemplateSchema = new mongoose.Schema(
  {
    templateCode: { type: String, unique: true, required: true },
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

export default mongoose.model('NotificationTemplate', notificationTemplateSchema);
