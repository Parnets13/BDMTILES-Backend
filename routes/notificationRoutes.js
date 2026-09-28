import { Router } from 'express';
import crypto from 'crypto';
import Notification from '../models/Notification.js';
import NotificationTemplate from '../models/NotificationTemplate.js';
import NotificationSettings from '../models/NotificationSettings.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { createNotificationEvent } from '../services/notificationService.js';
import { channelCapabilities } from '../services/systemCapabilityService.js';

const router = Router();
const TEMPLATE_WRITE_FIELDS = [
  'templateCode', 'templateName', 'channel', 'event', 'subject', 'body', 'variables', 'isActive',
];
const SETTINGS_WRITE_FIELDS = ['moduleName', 'isEnabled', 'events'];
const pick = (source, fields) => fields.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(source || {}, field)) result[field] = source[field];
  return result;
}, {});
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errorStatus = (error) => (error?.code === 11000 ? 409 : 500);
const requireOwner = (req, res, next) => {
  if (!['super_admin', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Only Super Admin / Owner can manage notification controls.' });
  }
  return next();
};

router.use(protect);
router.use(requireBranch);
router.use('/inbox', requirePermission('notification.inbox'));

// Authenticated current-user inbox.
router.get('/inbox', async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { branch: req.branchId, recipient: req.user._id };
    if (req.query.unread === 'true') filter.readAt = null;
    const [data, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Notification.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data,
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/inbox/unread-count', async (req, res) => {
  try {
    const count = await Notification.countDocuments({ branch: req.branchId, recipient: req.user._id, readAt: null });
    return res.json({ success: true, data: { count } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/inbox/read-all', async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { branch: req.branchId, recipient: req.user._id, readAt: null },
      { $set: { readAt: new Date() } }
    );
    return res.json({ success: true, message: 'All notifications marked as read.', data: { modified: result.modifiedCount } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/inbox/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, recipient: req.user._id },
      { $set: { readAt: new Date() } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, message: 'Notification not found.' });
    return res.json({ success: true, data: notification });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Which channels can actually be delivered. Served to anyone who can read their
// own inbox, because the settings and template screens both need to warn that
// selecting WhatsApp/SMS/push stores a preference but sends nothing. Derived from
// the dispatcher's own behaviour so the UI cannot claim more than the code does.
router.get('/channel-capabilities', requirePermission('notification.inbox'), (req, res) => {
  res.json({ success: true, data: channelCapabilities() });
});

// All remaining controls are owner-only.
router.use(requireOwner);
router.use(['/templates', '/send', '/settings'], requirePermission('notification.manage'));

router.get('/delivery-audit', requirePermission('notification.audit'), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const filter = { branch: req.branchId };
    if (req.query.deliveryState) filter.deliveryState = req.query.deliveryState;
    if (req.query.module) filter.module = req.query.module;
    const [data, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('recipient', 'name email role').populate('actor', 'name role').lean(),
      Notification.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

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
    const template = await NotificationTemplate.create({
      ...pick(req.body, TEMPLATE_WRITE_FIELDS),
      branch: req.branchId,
      createdBy: req.user._id,
    });
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
    const template = await NotificationTemplate.findOneAndDelete({ _id: req.params.id, branch: req.branchId });
    if (!template) return res.status(404).json({ success: false, message: 'Template not found in the selected branch.' });
    return res.json({ success: true, message: 'Deleted.', data: { _id: template._id } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Persisted test/event send. External channels are explicitly skipped until providers are configured.
router.post('/send', async (req, res) => {
  try {
    const { templateCode, variables, recipients, recipientUserIds, recipientRoles, eventKey, module, event, deepLink, data } = req.body;
    const template = await NotificationTemplate.findOne({ branch: req.branchId, templateCode, isActive: true }).lean();
    if (!template) return res.status(404).json({ success: false, message: 'Template not found or inactive.' });

    let messageBody = template.body;
    if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
      Object.entries(variables).forEach(([key, value]) => {
        messageBody = messageBody.replace(new RegExp(`{{${escapeRegex(key)}}}`, 'g'), String(value));
      });
    }

    const result = await createNotificationEvent({
      branch: req.branchId,
      module: module || 'custom',
      event: event || template.event,
      eventKey: eventKey || `test:${template._id}:${crypto.randomUUID()}`,
      title: template.subject || template.templateName,
      body: messageBody,
      data: data || {},
      deepLink: deepLink || '',
      actor: req.user._id,
      recipientUserIds: recipientUserIds || recipients || [],
      recipientRoles: recipientRoles || [],
      channels: [template.channel, 'web'],
      respectSettings: false,
    });
    return res.status(result.created ? 201 : 200).json({ success: true, message: result.skipped ? result.reason : 'Notification event persisted.', data: result });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/settings', async (req, res) => {
  try {
    const settings = await NotificationSettings.find({ branch: req.branchId }).sort({ module: 1 }).lean();
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/settings/:module', async (req, res) => {
  try {
    const settings = await NotificationSettings.findOne({ branch: req.branchId, module: req.params.module }).lean();
    return res.json({ success: true, data: settings || {
      branch: req.branchId,
      module: req.params.module,
      moduleName: req.params.module.replace(/_/g, ' '),
      isEnabled: true,
      events: [],
    } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/settings/:module', async (req, res) => {
  try {
    const settings = await NotificationSettings.findOneAndUpdate(
      { branch: req.branchId, module: req.params.module },
      {
        $set: { ...pick(req.body, SETTINGS_WRITE_FIELDS), updatedBy: req.user._id },
        $setOnInsert: { branch: req.branchId, module: req.params.module },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return res.json({ success: true, message: `Settings for "${req.params.module}" updated.`, data: settings });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.post('/settings/initialize', async (req, res) => {
  try {
    const defaultEvents = {
      lead: [
        { eventCode: 'lead_created', eventName: 'Lead Created', isEnabled: true, channels: ['web'], recipientRoles: ['sales_manager'] },
        { eventCode: 'lead_assigned', eventName: 'Lead Assigned', isEnabled: true, channels: ['web', 'push'], recipientRoles: [] },
        { eventCode: 'lead_accepted', eventName: 'Lead Accepted', isEnabled: true, channels: ['web'], recipientRoles: ['sales_manager'] },
        { eventCode: 'lead_declined', eventName: 'Lead Declined', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['sales_manager', 'admin'] },
      ],
      complaint: [
        { eventCode: 'complaint_raised', eventName: 'Complaint Raised', isEnabled: true, channels: ['web'], recipientRoles: ['sales_manager', 'warehouse_manager'] },
      ],
    };
    const modules = [
      ['sales_order', 'Sales Orders'], ['quotation', 'Quotations'], ['invoice', 'Invoices'],
      ['payment', 'Payments'], ['purchase_order', 'Purchase Orders'], ['grn', 'Goods Receipts'],
      ['stock_alert', 'Stock Alerts'], ['dispatch', 'Dispatch'], ['delivery', 'Delivery'],
      ['complaint', 'Complaints'], ['lead', 'Lead Management'], ['approval', 'Approvals'],
      ['expense', 'Expenses'], ['attendance', 'Attendance'], ['leave', 'Leave'], ['task', 'Tasks'],
      ['credit_limit', 'Credit Limit'], ['cheque_bounce', 'Cheque Bounce'],
    ];
    let created = 0;
    for (const [module, moduleName] of modules) {
      const result = await NotificationSettings.updateOne(
        { branch: req.branchId, module },
        { $setOnInsert: { branch: req.branchId, module, moduleName, isEnabled: true, events: defaultEvents[module] || [], updatedBy: req.user._id } },
        { upsert: true, runValidators: true }
      );
      if (result.upsertedCount) created += 1;
    }
    return res.json({ success: true, message: `Initialized ${created} module settings.`, data: { created, total: modules.length } });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

export default router;
