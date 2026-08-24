import { Router } from 'express';
import NotificationTemplate from '../models/NotificationTemplate.js';
import NotificationSettings from '../models/NotificationSettings.js';
import { protect } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// Templates CRUD
router.get('/templates', async (req, res) => {
  try {
    const { channel, event, search } = req.query;
    let filter = {};
    if (channel) filter.channel = channel;
    if (event) filter.event = event;
    if (search) filter.templateName = new RegExp(search, 'i');
    const templates = await NotificationTemplate.find(filter).sort({ event: 1 }).lean();
    res.json({ success: true, data: templates });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/templates', async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const t = await NotificationTemplate.create(data);
    res.status(201).json({ success: true, message: 'Template created.', data: t });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const t = await NotificationTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, message: 'Updated.', data: t });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/templates/:id', async (req, res) => {
  try { await NotificationTemplate.findByIdAndDelete(req.params.id); res.json({ success: true, message: 'Deleted.' }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Send notification (placeholder — actual integration depends on WhatsApp API / SMS gateway)
router.post('/send', async (req, res) => {
  try {
    const { templateCode, recipients, variables } = req.body;
    const template = await NotificationTemplate.findOne({ templateCode, isActive: true }).lean();
    if (!template) return res.status(404).json({ success: false, message: 'Template not found or inactive.' });

    // Replace variables in body
    let messageBody = template.body;
    if (variables) {
      Object.entries(variables).forEach(([key, value]) => {
        messageBody = messageBody.replace(new RegExp(`{{${key}}}`, 'g'), value);
      });
    }

    // TODO: Integrate with actual WhatsApp Business API / SMS gateway
    // For now, log and return success
    console.log(`[NOTIFICATION] Channel: ${template.channel}, To: ${recipients?.join(', ')}, Message: ${messageBody}`);

    res.json({
      success: true,
      message: `Notification queued via ${template.channel} to ${recipients?.length || 0} recipients.`,
      data: { channel: template.channel, messageBody, recipients },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// NOTIFICATION SETTINGS (Super Admin / Owner only)
// ═══════════════════════════════════════

// GET /api/v1/notifications/settings — get all module notification settings
router.get('/settings', async (req, res) => {
  try {
    // Only super_admin/owner can manage settings
    if (!['super_admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only Super Admin / Owner can access notification settings.' });
    }
    const settings = await NotificationSettings.find().sort({ module: 1 }).lean();
    res.json({ success: true, data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/notifications/settings/:module — get single module settings
router.get('/settings/:module', async (req, res) => {
  try {
    if (!['super_admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    let settings = await NotificationSettings.findOne({ module: req.params.module }).lean();
    if (!settings) {
      // Return default structure
      settings = { module: req.params.module, isEnabled: true, events: [], dataAccess: { restrictByTime: false, accessWindowDays: 0, exemptRoles: ['super_admin', 'owner'] } };
    }
    res.json({ success: true, data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/v1/notifications/settings/:module — update module settings
router.put('/settings/:module', async (req, res) => {
  try {
    if (!['super_admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only Super Admin / Owner can modify settings.' });
    }
    const settings = await NotificationSettings.findOneAndUpdate(
      { module: req.params.module },
      { ...req.body, module: req.params.module, updatedBy: req.user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, message: `Settings for "${req.params.module}" updated.`, data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/notifications/settings/initialize — create default settings for all modules
router.post('/settings/initialize', async (req, res) => {
  try {
    if (!['super_admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const modules = [
      { module: 'sales_order', moduleName: 'Sales Orders', events: [
        { eventCode: 'order_created', eventName: 'New Order Created', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['admin', 'owner', 'sales_manager'] },
        { eventCode: 'order_confirmed', eventName: 'Order Confirmed', isEnabled: true, channels: ['web', 'whatsapp'], recipientRoles: ['warehouse_manager'] },
        { eventCode: 'credit_exceeded', eventName: 'Credit Limit Exceeded', isEnabled: true, channels: ['web', 'push', 'whatsapp'], recipientRoles: ['owner', 'finance_manager'] },
      ]},
      { module: 'payment', moduleName: 'Payments', events: [
        { eventCode: 'payment_received', eventName: 'Payment Received', isEnabled: true, channels: ['web'], recipientRoles: ['finance_manager', 'owner'] },
        { eventCode: 'cheque_bounced', eventName: 'Cheque Bounced', isEnabled: true, channels: ['web', 'push', 'whatsapp'], recipientRoles: ['owner', 'finance_manager', 'sales_manager'] },
      ]},
      { module: 'stock_alert', moduleName: 'Stock Alerts', events: [
        { eventCode: 'stock_low', eventName: 'Stock Below Reorder', isEnabled: true, channels: ['web'], recipientRoles: ['purchase_manager', 'warehouse_manager'] },
        { eventCode: 'stock_zero', eventName: 'Zero Stock', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['purchase_manager', 'owner'] },
      ]},
      { module: 'delivery', moduleName: 'Delivery', events: [
        { eventCode: 'delivery_failed', eventName: 'Delivery Failed', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['sales_manager', 'owner'] },
        { eventCode: 'delivery_completed', eventName: 'Delivery Completed', isEnabled: true, channels: ['web'], recipientRoles: ['finance_manager'] },
      ]},
      { module: 'lead', moduleName: 'Lead Management', events: [
        { eventCode: 'lead_assigned', eventName: 'Lead Assigned to SE', isEnabled: true, channels: ['push', 'web'], recipientRoles: ['sales_executive'] },
        { eventCode: 'lead_accepted', eventName: 'Lead Accepted by SE', isEnabled: true, channels: ['web'], recipientRoles: ['sales_manager'] },
        { eventCode: 'lead_declined', eventName: 'Lead Declined by SE', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['sales_manager', 'admin'] },
      ]},
      { module: 'approval', moduleName: 'Approvals', events: [
        { eventCode: 'approval_required', eventName: 'Approval Required', isEnabled: true, channels: ['web', 'push'], recipientRoles: ['owner', 'admin'] },
      ]},
      { module: 'complaint', moduleName: 'Complaints', events: [
        { eventCode: 'complaint_raised', eventName: 'New Complaint', isEnabled: true, channels: ['web'], recipientRoles: ['sales_manager', 'warehouse_manager'] },
      ]},
      { module: 'expense', moduleName: 'Expenses', events: [
        { eventCode: 'expense_submitted', eventName: 'Expense Submitted for Approval', isEnabled: true, channels: ['web'], recipientRoles: ['finance_manager', 'hr_manager'] },
      ]},
    ];

    let created = 0;
    for (const mod of modules) {
      const exists = await NotificationSettings.findOne({ module: mod.module });
      if (!exists) {
        await NotificationSettings.create({
          ...mod, isEnabled: true,
          dataAccess: { restrictByTime: false, accessWindowDays: 0, exemptRoles: ['super_admin', 'owner'] },
          updatedBy: req.user._id,
        });
        created++;
      }
    }

    res.json({ success: true, message: `Initialized ${created} module settings.`, data: { created, total: modules.length } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/notifications/settings/:module/toggle — enable/disable module notifications
router.patch('/settings/:module/toggle', async (req, res) => {
  try {
    if (!['super_admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const settings = await NotificationSettings.findOneAndUpdate(
      { module: req.params.module },
      { isEnabled: req.body.isEnabled },
      { new: true }
    );
    if (!settings) return res.status(404).json({ success: false, message: 'Module settings not found. Initialize first.' });
    res.json({ success: true, message: `${req.params.module} notifications ${settings.isEnabled ? 'enabled' : 'disabled'}.`, data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/notifications/settings/:module/data-access — set data access restrictions
router.patch('/settings/:module/data-access', async (req, res) => {
  try {
    if (!['super_admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const { restrictByTime, accessWindowDays, exemptRoles } = req.body;
    const settings = await NotificationSettings.findOneAndUpdate(
      { module: req.params.module },
      { 'dataAccess.restrictByTime': restrictByTime, 'dataAccess.accessWindowDays': accessWindowDays || 0, 'dataAccess.exemptRoles': exemptRoles || ['super_admin', 'owner'] },
      { new: true }
    );
    if (!settings) return res.status(404).json({ success: false, message: 'Module settings not found.' });
    res.json({ success: true, message: 'Data access settings updated.', data: settings });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
