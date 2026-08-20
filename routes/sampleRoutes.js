import { Router } from 'express';
import Sample from '../models/Sample.js';
import Product from '../models/Product.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/samples
router.get('/', requirePermission('stock.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ sampleNumber: r }, { issuedTo: r }, { productName: r }]; }
    if (status) filter.status = status;
    const [data, total] = await Promise.all([
      Sample.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('product', 'productCode itemName tileSize').populate('warehouse', 'name').lean(),
      Sample.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/samples/stats
router.get('/stats', requirePermission('stock.view'), async (req, res) => {
  try {
    const [total, issued, returned, damaged, pending] = await Promise.all([
      Sample.countDocuments(),
      Sample.countDocuments({ status: 'issued' }),
      Sample.countDocuments({ status: 'returned' }),
      Sample.countDocuments({ status: 'damaged' }),
      Sample.countDocuments({ status: { $in: ['issued', 'with_customer'] } }),
    ]);
    res.json({ success: true, data: { total, issued, returned, damaged, pending } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/samples — issue sample
router.post('/', requirePermission('stock.view'), async (req, res) => {
  try {
    const data = { ...req.body, issuedBy: req.user._id };
    const count = await Sample.countDocuments();
    data.sampleNumber = `SMP-${String(count + 1).padStart(5, '0')}`;
    if (data.product) {
      const prod = await Product.findById(data.product).lean();
      if (prod) { data.productName = prod.itemName; data.productCode = prod.productCode; }
    }
    const sample = await Sample.create(data);
    res.status(201).json({ success: true, message: `Sample ${sample.sampleNumber} issued.`, data: sample });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/samples/:id/return
router.patch('/:id/return', requirePermission('stock.view'), async (req, res) => {
  try {
    const s = await Sample.findById(req.params.id);
    if (!s) return res.status(404).json({ success: false, message: 'Not found.' });
    s.status = req.body.condition === 'damaged' ? 'damaged' : 'returned';
    s.actualReturnDate = new Date();
    s.returnCondition = req.body.condition || 'good';
    s.damageNotes = req.body.damageNotes || '';
    if (s.depositCollected) s.depositReturned = true;
    await s.save();
    res.json({ success: true, message: 'Sample returned.', data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
