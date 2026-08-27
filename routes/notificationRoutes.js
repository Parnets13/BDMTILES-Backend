import { Router } from 'express';
import NotificationTemplate from '../models/NotificationTemplate.js';
import NotificationSettings from '../models/NotificationSettings.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

const router = Router();
const TEMPLATE_WRITE_FIELDS = [
  'templateCode', 'templateName', 'channel', 'event', 'subject', 'body', 'variables', 'isActive',
];
const SETTINGS_WRITE_FIELDS = ['moduleName', 'isEnabled', 'events', 'dataAccess'];
const pick = (source, fields) => fields.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(source || {}, field)) result[field] = source[field];
  return result;
}, {});
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errorStatus = (error) => (error?.code === 11000 ? 409 : 500);

router.use(protect);
router.use(requireBranch);
router.use(['/templates', '/send'], requirePermission('system.management'));

// Templates CRUD — every lookup and mutation is owned by the selected branch.
router.get('/templates', async (req, res) => {
  try {
    const { channel, event, search } = req.query;
    const filter = { branch: req.branchId };
    if (channel) filter.channel = channel;
    if (event) filter.event = event;
    if (search) filter.templateName = new RegExp(escapeRegex(search), 'i');
    const templates = await NotificationTemplate.find(filter).sort({ event: 1 }).lean();
    return res.json({ success: true, data: templates });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const data = {
      ...pick(req.body, TEMPLATE_WRITE_FIELDS),
      branch: req.branchId,
      createdBy: req.user._id,
    };
    const template = await NotificationTemplate.create(data);
    return res.status(201).json({ success: true, message: 'Template created.', data: template });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const template = await NotificationTemplate.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId },
      { $set: pick(req.body, TEMPLATE_WRITE_FIELDS) },
      { new: true, runValidators: true }
    );
    if (!template) return res.status(404).json({ success: false, message: 'Template not found in the selected branch.' });
    return res.json({ success: true, message: 'Updated.', data: template });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const template = await NotificationTemplate.findOneAndDelete({
      _id: req.params.id,
      branch: req.branchId,
    });
    if (!template) return res.status(404).json({ success: false, message: 'Template not found in the selected branch.' });
    return res.json({ success: true, message: 'Deleted.', data: { _id: template._id } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Placeholder send operation. Template selection cannot cross the selected branch.
router.post('/send', async (req, res) => {
  try {
    const { templateCode, recipients, variables } = req.body;
    const template = await NotificationTemplate.findOne({
      branch: req.branchId,
      templateCode,
      isActive: true,
    }).lean();
    if (!template) return res.status(404).json({ success: false, message: 'Template not found or inactive.' });

    let messageBody = template.body;
    if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
      Object.entries(variables).forEach(([key, value]) => {
        messageBody = messageBody.replace(new RegExp(`{{${escapeRegex(key)}}}`, 'g'), String(value));
      });
    }

    console.log(`[NOTIFICATION] Branch: ${req.branchId}, Channel: ${template.channel}, To: ${recipients?.join(', ')}, Message: ${messageBody}`);
    return res.json({
      success: true,
      message: `Notification queued via ${template.channel} to ${recipients?.length || 0} recipients.`,
      data: { channel: template.channel, messageBody, recipients },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

const requireSettingsOwner = (req, res) => {
  if (!['super_admin', 'owner'].includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'Only Super Admin / Owner can manage notification settings.' });
    return false;
  }
  return true;
};

router.get('/settings', async (req, res) => {
  try {
    if (!requireSettingsOwner(req, res)) return;
    const settings = await NotificationSettings.find({ branch: req.branchId }).sort({ module: 1 }).lean();
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/settings/:module', async (req, res) => {
  try {
    if (!requireSettingsOwner(req, res)) return;
    let settings = await NotificationSettings.findOne({
      branch: req.branchId,
      module: req.params.module,
    }).lean();
    if (!settings) {
      settings = {
        branch: req.branchId,
        module: req.params.module,
        isEnabled: true,
        events: [],
        dataAccess: {
          restrictByTime: false,
          accessWindowDays: 0,
          exemptRoles: ['super_admin', 'owner'],
        },
      };
    }
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/settings/:module', async (req, res) => {
  try {
    if (!requireSettingsOwner(req, res)) return;
    const settings = await NotificationSettings.findOneAndUpdate(
      { branch: req.branchId, module: req.params.module },
      {
        $set: { ...pick(req.body, SETTINGS_WRITE_FIELDS), updatedBy: req.user._id },
        $setOnInsert: { branch: req.branchId, module: req.params.module },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return res.json({
      success: true,
      message: `Settings for "${req.params.module}" updated.`,
      data: settings,
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.post('/settings/initialize', async (req, res) => {
  try {
    if (!requireSettingsOwner(req, res)) return;
    const modules = [
      { module: 'sales_order', moduleName: 'Sales Orders', events: [
        { eventCode: 'order_created', eventName: 'New Order Created', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['admin', 'owner', 'sales_manager'] },
        { eventCode: 'order_confirmed', eventName: 'Order Confirmed', isEnabled: true, channels: ['web', 'whatsapp'], recipientRoles: ['warehouse_manager'] },
        { eventCode: 'credit_exceeded', eventName: 'Credit Limit Exceeded', isEnabled: true, channels: ['web', 'push', 'whatsapp'], recipientRoles: ['owner', 'finance_manager'] },
      ] },
      { module: 'payment', moduleName: 'Payments', events: [
        { eventCode: 'payment_received', eventName: 'Payment Received', isEnabled: true, channels: ['web'], recipientRoles: ['finance_manager', 'owner'] },
        { eventCode: 'cheque_bounced', eventName: 'Cheque Bounced', isEnabled: true, channels: ['web', 'push', 'whatsapp'], recipientRoles: ['owner', 'finance_manager', 'sales_manager'] },
      ] },
      { module: 'stock_alert', moduleName: 'Stock Alerts', events: [
        { eventCode: 'stock_low', eventName: 'Stock Below Reorder', isEnabled: true, channels: ['web'], recipientRoles: ['purchase_manager', 'warehouse_manager'] },
        { eventCode: 'stock_zero', eventName: 'Zero Stock', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['purchase_manager', 'owner'] },
      ] },
      { module: 'delivery', moduleName: 'Delivery', events: [
        { eventCode: 'delivery_failed', eventName: 'Delivery Failed', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['sales_manager', 'owner'] },
        { eventCode: 'delivery_completed', eventName: 'Delivery Completed', isEnabled: true, channels: ['web'], recipientRoles: ['finance_manager'] },
      ] },
      { module: 'lead', moduleName: 'Lead Management', events: [
        { eventCode: 'lead_assigned', eventName: 'Lead Assigned to SE', isEnabled: true, channels: ['push', 'web'], recipientRoles: ['sales_executive'] },
        { eventCode: 'lead_accepted', eventName: 'Lead Accepted by SE', isEnabled: true, channels: ['web'], recipientRoles: ['sales_manager'] },
        { eventCode: 'lead_declined', eventName: 'Lead Declined by SE', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['sales_manager', 'admin'] },
      ] },
      { module: 'approval', moduleName: 'Approvals', events: [
        { eventCode: 'approval_required', eventName: 'Approval Required', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['owner', 'admin'] },
      ] },
      { module: 'complaint', moduleName: 'Complaints', events: [
        { eventCode: 'complaint_raised', eventName: 'New Complaint', isEnabled: true, channels: ['web'], recipientRoles: ['sales_manager', 'warehouse_manager'] },
      ] },
      { module: 'expense', moduleName: 'Expenses', events: [
        { eventCode: 'expense_submitted', eventName: 'Expense Submitted for Approval', isEnabled: true, channels: ['web'], recipientRoles: ['finance_manager', 'hr_manager'] },
      ] },
    ];

    let created = 0;
    for (const item of modules) {
      const result = await NotificationSettings.updateOne(
        { branch: req.branchId, module: item.module },
        {
          $setOnInsert: {
            ...item,
            branch: req.branchId,
            isEnabled: true,
            dataAccess: {
              restrictByTime: false,
              accessWindowDays: 0,
              exemptRoles: ['super_admin', 'owner'],
            },
            updatedBy: req.user._id,
          },
        },
        { upsert: true, runValidators: true }
      );
      if (result.upsertedCount) created += 1;
    }

    return res.json({
      success: true,
      message: `Initialized ${created} module settings.`,
      data: { created, total: modules.length },
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.patch('/settings/:module/toggle', async (req, res) => {
  try {
    if (!requireSettingsOwner(req, res)) return;
    const settings = await NotificationSettings.findOneAndUpdate(
      { branch: req.branchId, module: req.params.module },
      { $set: { isEnabled: req.body.isEnabled, updatedBy: req.user._id } },
      { new: true, runValidators: true }
    );
    if (!settings) return res.status(404).json({ success: false, message: 'Module settings not found. Initialize first.' });
    return res.json({
      success: true,
      message: `${req.params.module} notifications ${settings.isEnabled ? 'enabled' : 'disabled'}.`,
      data: settings,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/settings/:module/data-access', async (req, res) => {
  try {
    if (!requireSettingsOwner(req, res)) return;
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'restrictByTime')) {
      updates['dataAccess.restrictByTime'] = req.body.restrictByTime;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'accessWindowDays')) {
      updates['dataAccess.accessWindowDays'] = req.body.accessWindowDays;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'exemptRoles')) {
      updates['dataAccess.exemptRoles'] = req.body.exemptRoles;
    }
    updates.updatedBy = req.user._id;

    const settings = await NotificationSettings.findOneAndUpdate(
      { branch: req.branchId, module: req.params.module },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!settings) return res.status(404).json({ success: false, message: 'Module settings not found.' });
    return res.json({ success: true, message: 'Data access settings updated.', data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
