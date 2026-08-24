import mongoose from 'mongoose';

/**
 * NotificationSettings — Super Admin controls which modules send notifications,
 * who receives them, and through which channels.
 * 
 * One document per module (singleton per module).
 * Only super_admin/owner can modify these settings.
 */

const recipientSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userName: String,
  role: String,
  channels: [{ type: String, enum: ['web', 'email', 'whatsapp', 'sms', 'push'] }],
});

const notificationSettingsSchema = new mongoose.Schema(
  {
    module: {
      type: String,
      required: true,
      unique: true,
      enum: [
        'sales_order', 'quotation', 'invoice', 'payment', 'purchase_order', 'grn',
        'stock_alert', 'dispatch', 'delivery', 'complaint', 'lead', 'approval',
        'expense', 'attendance', 'leave', 'task', 'credit_limit', 'cheque_bounce',
      ],
    },
    moduleName: { type: String, default: '' },

    // Master switch
    isEnabled: { type: Boolean, default: true },

    // Events within this module that trigger notifications
    events: [{
      eventCode: String, // e.g. 'order_created', 'payment_received', 'stock_low'
      eventName: String,
      isEnabled: { type: Boolean, default: true },
      channels: [{ type: String, enum: ['web', 'email', 'whatsapp', 'sms', 'push'] }],
      recipients: [recipientSchema],
      // Role-based recipients (all users with this role get notified)
      recipientRoles: [String],
    }],

    // Data access control — who can see data in this module
    dataAccess: {
      // Default: everyone with module permission sees all data
      restrictByTime: { type: Boolean, default: false },
      // If restrictByTime is true, non-admin users can only see data from last N days
      accessWindowDays: { type: Number, default: 0 }, // 0 = all time, 30 = last 30 days, etc.
      // Exceptions: roles that always see all data regardless of restriction
      exemptRoles: [String], // e.g. ['super_admin', 'owner', 'admin']
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

notificationSettingsSchema.index({ module: 1 });

export default mongoose.model('NotificationSettings', notificationSettingsSchema);
