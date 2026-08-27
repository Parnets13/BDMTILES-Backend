import { Router } from 'express';
import Document from '../models/Document.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);
router.use(requirePermission('document.management'));

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, category, linkedTo, status, hasExpiry } = req.query;
    const p = Math.max(1, parseInt(page)), l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ title: r }, { fileName: r }, { tags: r }, { linkedEntityName: r }]; }
    if (category) filter.category = category;
    if (linkedTo) filter.linkedTo = linkedTo;
    if (status) filter.status = status;
    if (hasExpiry === 'true') filter.hasExpiry = true;
    const [data, total] = await Promise.all([
      Document.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l).populate('uploadedBy','name').lean(),
      Document.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const alertDate = new Date(); alertDate.setDate(alertDate.getDate() + 30);
    const [total, active, expired, expiringSoon] = await Promise.all([
      Document.countDocuments(), Document.countDocuments({ status: 'active' }),
      Document.countDocuments({ status: 'expired' }),
      Document.countDocuments({ hasExpiry: true, expiryDate: { $lte: alertDate, $gte: now }, status: 'active' }),
    ]);
    res.json({ success: true, data: { total, active, expired, expiringSoon } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/expiring', async (req, res) => {
  try {
    const alertDate = new Date(); alertDate.setDate(alertDate.getDate() + 60);
    const docs = await Document.find({ hasExpiry: true, expiryDate: { $lte: alertDate }, status: 'active' })
      .sort({ expiryDate: 1 }).limit(50).populate('uploadedBy','name').lean();
    res.json({ success: true, data: docs });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const data = { ...req.body, uploadedBy: req.user._id };
    const count = await Document.countDocuments();
    data.documentCode = `DOC-${String(count + 1).padStart(5, '0')}`;
    const doc = await Document.create(data);
    res.status(201).json({ success: true, message: 'Document uploaded.', data: doc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const doc = await Document.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Updated.', data: doc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/download', async (req, res) => {
  try {
    const doc = await Document.findByIdAndUpdate(req.params.id, { $inc: { downloadCount: 1 }, lastAccessedBy: req.user._id, lastAccessedAt: new Date() }, { new: true });
    res.json({ success: true, data: doc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Document, req.params.id, { user: req.user, module: 'document', titleField: 'title', codeField: 'documentCode', skipDependencyCheck: true });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
