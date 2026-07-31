import { Router } from 'express';
import { DailyWageWorker, DailyWageAttendance } from '../models/DailyWageWorker.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);
router.use(requirePermission('attendance.master'));

// ── Workers CRUD ────────────────────────────────────────────
router.get('/workers', async (req, res) => {
  try {
    const { search, isActive, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 50);
    let filter = {};
    if (search) filter.workerName = new RegExp(search, 'i');
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    const [workers, total] = await Promise.all([
      DailyWageWorker.find(filter).sort({ workerName: 1 }).skip((p - 1) * l).limit(l).lean(),
      DailyWageWorker.countDocuments(filter),
    ]);
    res.json({ success: true, data: workers, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/workers', async (req, res) => {
  try {
    const w = await DailyWageWorker.create({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ success: true, message: 'Worker added.', data: w });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/workers/:id', async (req, res) => {
  try {
    const w = await DailyWageWorker.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!w) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: w });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Daily Attendance ────────────────────────────────────────
// GET /api/v1/daily-wages/attendance?date=YYYY-MM-DD
router.get('/attendance', async (req, res) => {
  try {
    const { date, dateFrom, dateTo, worker, page = 1, limit = 100 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(500, parseInt(limit) || 100);
    let filter = {};
    if (date) {
      const d = new Date(date); d.setHours(0,0,0,0);
      const next = new Date(d); next.setDate(next.getDate() + 1);
      filter.date = { $gte: d, $lt: next };
    } else if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = new Date(dateFrom);
      if (dateTo)   { const d = new Date(dateTo); d.setHours(23,59,59); filter.date.$lte = d; }
    }
    if (worker) filter.worker = worker;
    const [records, total] = await Promise.all([
      DailyWageAttendance.find(filter)
        .populate('worker', 'workerName category wagePerDay')
        .sort({ date: -1 }).skip((p - 1) * l).limit(l).lean(),
      DailyWageAttendance.countDocuments(filter),
    ]);
    res.json({ success: true, data: records, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/daily-wages/attendance — mark attendance for a date
router.post('/attendance', async (req, res) => {
  try {
    const { records } = req.body; // array of { worker, date, present, hoursWorked, remarks }
    if (!Array.isArray(records)) return res.status(400).json({ success: false, message: 'records array required' });

    const results = [];
    for (const r of records) {
      const worker = await DailyWageWorker.findById(r.worker).lean();
      const wagePerHour  = worker ? (worker.wagePerDay / (r.standardHours || 8)) : 0;
      const hoursWorked  = r.present ? (r.hoursWorked || 8) : 0;
      const wageEarned   = Math.round(wagePerHour * hoursWorked);

      const rec = await DailyWageAttendance.findOneAndUpdate(
        { worker: r.worker, date: new Date(r.date) },
        {
          workerName: worker?.workerName || '',
          present: r.present !== false,
          hoursWorked,
          wageEarned,
          remarks: r.remarks || '',
          markedBy: req.user._id,
        },
        { upsert: true, new: true }
      );
      results.push(rec);
    }
    res.json({ success: true, message: `${results.length} attendance record(s) saved.`, data: results });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/daily-wages/summary?dateFrom=&dateTo= — monthly wage summary
router.get('/summary', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const filter = {};
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = new Date(dateFrom);
      if (dateTo)   { const d = new Date(dateTo); d.setHours(23,59,59); filter.date.$lte = d; }
    }
    const summary = await DailyWageAttendance.aggregate([
      { $match: filter },
      { $group: {
        _id: '$worker',
        workerName:   { $first: '$workerName' },
        daysPresent:  { $sum: { $cond: ['$present', 1, 0] } },
        totalHours:   { $sum: '$hoursWorked' },
        totalWage:    { $sum: '$wageEarned' },
      }},
      { $sort: { workerName: 1 } },
    ]);
    const totalWage    = summary.reduce((s, r) => s + r.totalWage, 0);
    const totalWorkers = summary.length;
    res.json({ success: true, data: summary, totalWage, totalWorkers });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
