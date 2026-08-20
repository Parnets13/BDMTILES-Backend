import { Router } from 'express';
import NotificationTemplate from '../models/NotificationTemplate.js';
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

export default router;
