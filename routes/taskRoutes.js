import { Router } from 'express';
import Task from '../models/Task.js';
import { protect } from '../middleware/auth.js';

const router = Router();
router.use(protect);

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority, assignedTo } = req.query;
    const p = Math.max(1, parseInt(page)), l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ title: r }, { taskNumber: r }, { description: r }]; }
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (assignedTo) filter.assignedTo = assignedTo;
    const [data, total] = await Promise.all([
      Task.find(filter).sort({ priority: -1, dueDate: 1 }).skip((p-1)*l).limit(l)
        .populate('assignedTo','name').populate('assignedBy','name').lean(),
      Task.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const [total, pending, inProgress, completed, overdue] = await Promise.all([
      Task.countDocuments(), Task.countDocuments({ status: 'pending' }),
      Task.countDocuments({ status: 'in_progress' }), Task.countDocuments({ status: 'completed' }),
      Task.countDocuments({ status: { $in: ['pending','in_progress'] }, dueDate: { $lt: new Date() } }),
    ]);
    res.json({ success: true, data: { total, pending, inProgress, completed, overdue } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/my-tasks', async (req, res) => {
  try {
    const tasks = await Task.find({ assignedTo: req.user._id, status: { $in: ['pending','in_progress'] } })
      .sort({ priority: -1, dueDate: 1 }).populate('assignedBy','name').lean();
    res.json({ success: true, data: tasks });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const data = { ...req.body, assignedBy: req.user._id, createdBy: req.user._id };
    const count = await Task.countDocuments();
    data.taskNumber = `TSK-${String(count + 1).padStart(5, '0')}`;
    const task = await Task.create(data);
    res.status(201).json({ success: true, message: `Task ${task.taskNumber} created.`, data: task });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const update = { status };
    if (status === 'in_progress') update.startedDate = new Date();
    if (status === 'completed') update.completedDate = new Date();
    const task = await Task.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!task) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: `Task ${status}.`, data: task });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/comment', async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Not found.' });
    task.comments.push({ text: req.body.text, user: req.user._id, userName: req.user.name });
    await task.save();
    res.json({ success: true, message: 'Comment added.', data: task });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Task, req.params.id, { user: req.user, module: 'task', titleField: 'title', codeField: 'taskNumber', skipDependencyCheck: true });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
