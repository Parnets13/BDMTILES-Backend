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

/**
 * Append one entry to an asset's custody trail. Callers mutate the asset document
 * *after* capturing the before-state, so this only stores what it is handed —
 * it deliberately does not infer statusBefore/conditionBefore itself.
 */
function recordMovement(asset, entry, req) {
  asset.movements.push({
    ...entry,
    date: entry.date ? new Date(entry.date) : new Date(),
    recordedBy: req.user?._id,
    recordedByName: req.user?.name || req.user?.email || '',
  });
}

// Movement types where custody actually leaves the "from" employee. Damage,
// repair and plain status changes are logged against the holder but they keep it.
const CUSTODY_RELEASING_TYPES = new Set(['returned', 'transferred', 'disposed', 'lost']);

async function loadEmployee(employeeId) {
  if (!employeeId) return null;
  return Employee.findById(employeeId).select('name empId department designation').lean();
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
        .select('-movements')   // custody trail grows without bound; fetch it per-asset instead
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
// Handing the asset to an employee. If it is already held by someone else this
// is recorded as a transfer so the trail never shows two open custodies.
router.post('/:id/assign', requirePermission('asset.management'), async (req, res) => {
  try {
    const { employeeId, assignedDate, location, department, remarks, notes } = req.body;
    if (!employeeId) return res.status(400).json({ success: false, message: 'employeeId is required. Use /return to hand an asset back.' });

    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    if (asset.status === 'disposed') return res.status(400).json({ success: false, message: 'Asset is disposed and cannot be assigned.' });

    const emp = await loadEmployee(employeeId);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const isTransfer = asset.assignedTo && String(asset.assignedTo) !== String(employeeId);
    const statusBefore = asset.status;

    recordMovement(asset, {
      type: isTransfer ? 'transferred' : 'assigned',
      date: assignedDate,
      fromEmployee: asset.assignedTo || undefined,
      fromEmployeeName: asset.assignedToName || '',
      toEmployee: emp._id,
      toEmployeeName: emp.name || '',
      fromLocation: asset.location || '',
      toLocation: location ?? asset.location ?? '',
      fromDepartment: asset.department || '',
      toDepartment: department ?? emp.department ?? asset.department ?? '',
      statusBefore,
      statusAfter: 'in_use',
      conditionBefore: asset.condition || '',
      conditionAfter: asset.condition || '',
      remarks: remarks || notes || '',
    }, req);

    asset.assignedTo = emp._id;
    asset.assignedToName = emp.name || '';
    asset.assignedDate = assignedDate ? new Date(assignedDate) : new Date();
    asset.returnDate = null;
    asset.status = 'in_use';
    if (location !== undefined)   asset.location = location;
    if (department !== undefined) asset.department = department;
    // `notes` is the asset's own descriptive field — only touch it when explicitly sent,
    // otherwise assigning without notes would silently erase it.
    if (notes !== undefined) asset.notes = notes;

    await asset.save();
    await asset.populate('assignedTo', 'name empId designation');
    res.json({
      success: true,
      data: asset,
      message: isTransfer ? `Asset transferred to ${emp.name}.` : `Asset assigned to ${emp.name}.`,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/v1/assets/:id/return ──────────────────────────────────────────
// Employee hands the asset back to the company. Condition on return is the point
// of the exercise, so it is accepted here and written onto the asset.
router.post('/:id/return', requirePermission('asset.management'), async (req, res) => {
  try {
    const { returnDate, condition, location, remarks } = req.body;

    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    if (!asset.assignedTo) return res.status(400).json({ success: false, message: 'Asset is not currently assigned to anyone.' });

    const statusBefore = asset.status;
    const conditionBefore = asset.condition;
    const nextCondition = condition || asset.condition;
    // A set returned damaged should not silently go back into the available pool.
    const statusAfter = nextCondition === 'damaged' ? 'under_maintenance' : 'returned';

    recordMovement(asset, {
      type: 'returned',
      date: returnDate,
      fromEmployee: asset.assignedTo,
      fromEmployeeName: asset.assignedToName || '',
      fromLocation: asset.location || '',
      toLocation: location ?? asset.location ?? '',
      fromDepartment: asset.department || '',
      toDepartment: asset.department || '',
      statusBefore,
      statusAfter,
      conditionBefore,
      conditionAfter: nextCondition,
      remarks: remarks || '',
    }, req);

    asset.assignedTo = null;
    asset.assignedToName = '';
    asset.returnDate = returnDate ? new Date(returnDate) : new Date();
    asset.status = statusAfter;
    asset.condition = nextCondition;
    if (location !== undefined) asset.location = location;

    await asset.save();
    res.json({ success: true, data: asset, message: 'Asset returned.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/v1/assets/:id/transfer ────────────────────────────────────────
// Move an unassigned asset between locations/departments, or between employees.
router.post('/:id/transfer', requirePermission('asset.management'), async (req, res) => {
  try {
    const { toEmployeeId, location, department, date, reason, remarks } = req.body;
    if (!toEmployeeId && location === undefined && department === undefined) {
      return res.status(400).json({ success: false, message: 'Provide toEmployeeId, location or department to transfer.' });
    }

    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    if (asset.status === 'disposed') return res.status(400).json({ success: false, message: 'Asset is disposed and cannot be transferred.' });

    let emp = null;
    if (toEmployeeId) {
      emp = await loadEmployee(toEmployeeId);
      if (!emp) return res.status(404).json({ success: false, message: 'Destination employee not found.' });
    }

    const statusBefore = asset.status;
    const statusAfter = emp ? 'in_use' : statusBefore;

    recordMovement(asset, {
      type: 'transferred',
      date,
      fromEmployee: asset.assignedTo || undefined,
      fromEmployeeName: asset.assignedToName || '',
      toEmployee: emp?._id,
      toEmployeeName: emp?.name || '',
      fromLocation: asset.location || '',
      toLocation: location ?? asset.location ?? '',
      fromDepartment: asset.department || '',
      toDepartment: department ?? emp?.department ?? asset.department ?? '',
      statusBefore,
      statusAfter,
      conditionBefore: asset.condition || '',
      conditionAfter: asset.condition || '',
      reason: reason || '',
      remarks: remarks || '',
    }, req);

    if (emp) {
      asset.assignedTo = emp._id;
      asset.assignedToName = emp.name || '';
      asset.assignedDate = date ? new Date(date) : new Date();
      asset.returnDate = null;
      asset.status = 'in_use';
    }
    if (location !== undefined)   asset.location = location;
    if (department !== undefined) asset.department = department;

    await asset.save();
    await asset.populate('assignedTo', 'name empId designation');
    res.json({ success: true, data: asset, message: 'Asset transferred.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/v1/assets/:id/damage ──────────────────────────────────────────
// Report damage or loss. Custody is left as-is; who holds it is a separate fact
// from what state it is in.
router.post('/:id/damage', requirePermission('asset.management'), async (req, res) => {
  try {
    const { date, reason, remarks, lost } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Reason is required.' });

    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });

    const statusBefore = asset.status;
    const conditionBefore = asset.condition;
    const statusAfter = lost ? 'lost' : 'under_maintenance';

    recordMovement(asset, {
      type: lost ? 'lost' : 'damaged',
      date,
      fromEmployee: asset.assignedTo || undefined,
      fromEmployeeName: asset.assignedToName || '',
      fromLocation: asset.location || '',
      toLocation: asset.location || '',
      statusBefore,
      statusAfter,
      conditionBefore,
      conditionAfter: lost ? conditionBefore : 'damaged',
      reason,
      remarks: remarks || '',
    }, req);

    asset.status = statusAfter;
    if (!lost) asset.condition = 'damaged';

    await asset.save();
    res.json({ success: true, data: asset, message: lost ? 'Asset marked as lost.' : 'Damage recorded.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/v1/assets/:id/movements ────────────────────────────────────────
router.get('/:id/movements', requirePermission('asset.management'), async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id, { assetCode: 1, name: 1, movements: 1 }).lean();
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
    const movements = [...(asset.movements || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({
      success: true,
      data: { assetCode: asset.assetCode, name: asset.name, movements },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/v1/assets/employee/:employeeId/history ─────────────────────────
// Everything this employee has ever held: currently-held assets plus every
// movement they were on either side of.
router.get('/employee/:employeeId/history', requirePermission('asset.management'), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const emp = await loadEmployee(employeeId);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const assets = await Asset.find({
      $or: [
        { assignedTo: employeeId },
        { 'movements.toEmployee': employeeId },
        { 'movements.fromEmployee': employeeId },
      ],
    }, { assetCode: 1, name: 1, category: 1, status: 1, condition: 1, assignedTo: 1, assignedToName: 1, assignedDate: 1, returnDate: 1, movements: 1 }).lean();

    const currentlyHeld = [];
    const history = [];

    for (const asset of assets) {
      if (String(asset.assignedTo || '') === String(employeeId)) {
        currentlyHeld.push({
          _id: asset._id,
          assetCode: asset.assetCode,
          name: asset.name,
          category: asset.category,
          status: asset.status,
          condition: asset.condition,
          assignedDate: asset.assignedDate,
        });
      }
      for (const m of asset.movements || []) {
        const isTo   = String(m.toEmployee || '') === String(employeeId);
        const isFrom = String(m.fromEmployee || '') === String(employeeId);
        if (!isTo && !isFrom) continue;
        // Being on the "from" side does not always mean custody left the employee —
        // a damage report or repair happens while they still hold the asset.
        const direction = isTo
          ? 'received'
          : CUSTODY_RELEASING_TYPES.has(m.type) ? 'handed_over' : 'while_held';
        history.push({
          _id: m._id,
          assetId: asset._id,
          assetCode: asset.assetCode,
          assetName: asset.name,
          category: asset.category,
          direction,
          type: m.type,
          date: m.date,
          counterpartName: isTo ? (m.fromEmployeeName || '') : (m.toEmployeeName || ''),
          conditionBefore: m.conditionBefore,
          conditionAfter: m.conditionAfter,
          statusAfter: m.statusAfter,
          reason: m.reason,
          remarks: m.remarks,
          recordedByName: m.recordedByName,
        });
      }
    }

    history.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      data: {
        employee: { _id: emp._id, name: emp.name, empId: emp.empId, department: emp.department, designation: emp.designation },
        currentlyHeld,
        history,
        summary: {
          currentlyHeldCount: currentlyHeld.length,
          totalAssetsTouched: assets.length,
          totalMovements: history.length,
        },
      },
    });
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
    const statusBefore = asset.status;
    const conditionBefore = asset.condition;
    if (status === 'completed' && asset.status === 'under_maintenance') {
      asset.status = asset.assignedTo ? 'in_use' : 'active';
      // Coming out of maintenance, "damaged" is no longer the truth.
      if (asset.condition === 'damaged') asset.condition = 'fair';
    } else if (status === 'in_progress') {
      asset.status = 'under_maintenance';
    }

    if (asset.status !== statusBefore || asset.condition !== conditionBefore) {
      recordMovement(asset, {
        type: status === 'completed' ? 'repaired' : 'status_change',
        date: logEntry.date,
        fromEmployee: asset.assignedTo || undefined,
        fromEmployeeName: asset.assignedToName || '',
        statusBefore,
        statusAfter: asset.status,
        conditionBefore,
        conditionAfter: asset.condition,
        reason: description,
        remarks: remarks || '',
      }, req);
    }

    await asset.save();
    res.json({ success: true, data: asset, message: 'Maintenance log added.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /api/v1/assets/:id/status ─────────────────────────────────────────
router.patch('/:id/status', requirePermission('asset.management'), async (req, res) => {
  try {
    const { status, condition, reason, remarks } = req.body;
    if (!status && !condition) return res.status(400).json({ success: false, message: 'Provide status or condition.' });

    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });

    const statusBefore = asset.status;
    const conditionBefore = asset.condition;
    if (status)    asset.status = status;
    if (condition) asset.condition = condition;

    // Only log when something actually moved, so the trail isn't padded with no-ops.
    if (asset.status !== statusBefore || asset.condition !== conditionBefore) {
      recordMovement(asset, {
        type: asset.status === 'disposed' ? 'disposed' : asset.status === 'lost' ? 'lost' : 'status_change',
        fromEmployee: asset.assignedTo || undefined,
        fromEmployeeName: asset.assignedToName || '',
        statusBefore,
        statusAfter: asset.status,
        conditionBefore,
        conditionAfter: asset.condition,
        reason: reason || '',
        remarks: remarks || '',
      }, req);
    }

    await asset.save();
    res.json({ success: true, data: asset, message: 'Status updated.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
