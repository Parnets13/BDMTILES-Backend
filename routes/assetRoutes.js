import { Router } from 'express';
import Asset from '../models/Asset.js';
import Employee from '../models/Employee.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ── Auto-increment helper ────────────────────────────────────────────────────
async function nextAssetCode() {
  const last = await Asset.findOne({}, { assetCode: 1 }).sort({ createdAt: -1 }).lean();
  if (!last?.assetCode) return 'AST-00001';
  const num = parseInt(last.assetCode.replace('AST-', ''), 10) || 0;
  return 'AST-' + String(num + 1).padStart(5, '0');
}

// ── GET /api/v1/assets/stats ─────────────────────────────────────────────────
router.get('/stats', requirePermission('asset.management'), async (req, res) => {
  try {
    const [total, active, inUse, maintenance, disposed, warrantyExpiringSoon] = await Promise.all([
      Asset.countDocuments({ isActive: true }),
      Asset.countDocuments({ status: 'active', isActive: true }),
      Asset.countDocuments({ status: 'in_use', isActive: true }),
      Asset.countDocuments({ status: 'under_maintenance', isActive: true }),
      Asset.countDocuments({ status: 'disposed', isActive: true }),
      Asset.countDocuments({
        warrantyExpiry: { $gte: new Date(), $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
        isActive: true,
      }),
    ]);
    const totalValue = await Asset.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: null, total: { $sum: '$currentValue' } } },
    ]);
    const totalPurchaseCost = await Asset.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: null, total: { $sum: '$purchaseCost' } } },
    ]);
    res.json({
      success: true,
      data: {
        total, active, inUse, maintenance, disposed, warrantyExpiringSoon,
        totalCurrentValue: totalValue[0]?.total || 0,
        totalPurchaseCost: totalPurchaseCost[0]?.total || 0,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/v1/assets ───────────────────────────────────────────────────────
router.get('/', requirePermission('asset.management'), async (req, res) => {
  try {
    const { page = 1, limit = 25, search, status, category, assignedTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 25);

    let filter = { isActive: true };
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ assetCode: r }, { name: r }, { serialNumber: r }, { brand: r }, { assignedToName: r }];
    }
    if (status)     filter.status = status;
    if (category)   filter.category = category;
    if (assignedTo) filter.assignedTo = assignedTo;

    const [data, total] = await Promise.all([
      Asset.find(filter)
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .populate('assignedTo', 'name empId designation')
        .lean(),
      Asset.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/v1/assets/:id ───────────────────────────────────────────────────
router.get('/:id', requirePermission('asset.management'), async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id)
      .populate('assignedTo', 'name empId designation mobile')
      .lean();
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    res.json({ success: true, data: asset });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/v1/assets ──────────────────────────────────────────────────────
router.post('/', requirePermission('asset.management'), async (req, res) => {
  try {
    const assetCode = await nextAssetCode();
    const asset = await Asset.create({
      ...req.body,
      assetCode,
      currentValue: req.body.currentValue ?? req.body.purchaseCost ?? 0,
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, data: asset, message: 'Asset created successfully.' });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Asset code already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/v1/assets/:id ───────────────────────────────────────────────────
router.put('/:id', requirePermission('asset.management'), async (req, res) => {
  try {
    const { maintenanceLogs, ...updateData } = req.body;  // don't overwrite logs via PUT
    const asset = await Asset.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true })
      .populate('assignedTo', 'name empId designation');
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    res.json({ success: true, data: asset, message: 'Asset updated.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── DELETE /api/v1/assets/:id — soft delete ──────────────────────────────────
router.delete('/:id', requirePermission('asset.management'), async (req, res) => {
  try {
    const asset = await Asset.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    res.json({ success: true, message: 'Asset deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/v1/assets/:id/assign ──────────────────────────────────────────
router.post('/:id/assign', requirePermission('asset.management'), async (req, res) => {
  try {
    const { employeeId, assignedDate, notes } = req.body;
    let assignedToName = '';
    if (employeeId) {
      const emp = await Employee.findById(employeeId).lean();
      assignedToName = emp?.name || '';
    }
    const asset = await Asset.findByIdAndUpdate(
      req.params.id,
      {
        assignedTo: employeeId || null,
        assignedToName,
        assignedDate: assignedDate ? new Date(assignedDate) : new Date(),
        returnDate: null,
        status: employeeId ? 'in_use' : 'active',
        notes: notes || '',
      },
      { new: true }
    ).populate('assignedTo', 'name empId designation');
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    res.json({ success: true, data: asset, message: employeeId ? 'Asset assigned.' : 'Asset unassigned (returned).' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/v1/assets/:id/maintenance ─────────────────────────────────────
router.post('/:id/maintenance', requirePermission('asset.management'), async (req, res) => {
  try {
    const { date, type, description, cost, doneBy, nextDueDate, status, remarks } = req.body;
    if (!description) return res.status(400).json({ success: false, message: 'Description is required.' });

    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });

    const logEntry = { date: date ? new Date(date) : new Date(), type, description, cost, doneBy, remarks, status };
    if (nextDueDate) logEntry.nextDueDate = new Date(nextDueDate);

    asset.maintenanceLogs.push(logEntry);
    asset.lastMaintenanceDate = logEntry.date;
    if (nextDueDate) asset.nextMaintenanceDue = new Date(nextDueDate);
    // Update status — if maintenance is completed, revert to active/in_use
    if (status === 'completed' && asset.status === 'under_maintenance') {
      asset.status = asset.assignedTo ? 'in_use' : 'active';
    } else if (status === 'in_progress') {
      asset.status = 'under_maintenance';
    }

    await asset.save();
    res.json({ success: true, data: asset, message: 'Maintenance log added.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /api/v1/assets/:id/status ─────────────────────────────────────────
router.patch('/:id/status', requirePermission('asset.management'), async (req, res) => {
  try {
    const { status, condition } = req.body;
    const update = {};
    if (status)    update.status = status;
    if (condition) update.condition = condition;
    const asset = await Asset.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    res.json({ success: true, data: asset, message: 'Status updated.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
