import { Router } from 'express';
import Task from '../models/Task.js';
import User from '../models/User.js';
import { protect, requirePermission, userHasPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

const sameObjectId = (left, right) => Boolean(left && right && String(left) === String(right));

const findAssignableUser = (userId, branchId) => User.findOne({
  _id: userId,
  status: 'Active',
  $or: [
    { assignedBranches: branchId },
    { role: { $in: ['super_admin', 'owner'] } },
  ],
}).select('_id').lean();

const router = Router();
router.use(protect);
router.use(requireBranch);

router.get('/', requirePermission('task.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority, assignedTo } = req.query;
    const p = Math.max(1, parseInt(page)), l = Math.min(100, parseInt(limit) || 20);
    const filter = { branch: req.branchId };
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

router.get('/stats', requirePermission('task.management'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, pending, inProgress, completed, overdue] = await Promise.all([
      Task.countDocuments(scope), Task.countDocuments({ ...scope, status: 'pending' }),
      Task.countDocuments({ ...scope, status: 'in_progress' }), Task.countDocuments({ ...scope, status: 'completed' }),
      Task.countDocuments({ ...scope, status: { $in: ['pending','in_progress'] }, dueDate: { $lt: new Date() } }),
    ]);
    res.json({ success: true, data: { total, pending, inProgress, completed, overdue } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/my-tasks', async (req, res) => {
  try {
    const tasks = await Task.find({ branch: req.branchId, assignedTo: req.user._id, status: { $in: ['pending','in_progress'] } })
      .sort({ priority: -1, dueDate: 1 }).populate('assignedBy','name').lean();
    res.json({ success: true, data: tasks });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', requirePermission('task.management'), async (req, res) => {
  try {
    if (!await findAssignableUser(req.body.assignedTo, req.branchId)) {
      return res.status(400).json({ success: false, message: 'Assigned user must be active and belong to the selected branch.' });
    }
    const data = {
      ...req.body,
      branch: req.branchId,
      assignedBy: req.user._id,
      createdBy: req.user._id,
    };
    // Task numbers remain globally sequenced for compatibility across branches.
    const count = await Task.countDocuments();
    data.taskNumber = `TSK-${String(count + 1).padStart(5, '0')}`;
    const task = await Task.create(data);
    res.status(201).json({ success: true, message: `Task ${task.taskNumber} created.`, data: task });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const existingTask = await Task.findOne({ _id: req.params.id, branch: req.branchId }).select('assignedTo').lean();
    if (!existingTask) return res.status(404).json({ success: false, message: 'Not found.' });
    if (!userHasPermission(req.user, 'task.management') && !sameObjectId(existingTask.assignedTo, req.user._id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const { status } = req.body;
    const update = { status };
    if (status === 'in_progress') update.startedDate = new Date();
    if (status === 'completed') update.completedDate = new Date();
    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId },
      update,
      { new: true, runValidators: true },
    );
    res.json({ success: true, message: `Task ${status}.`, data: task });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/:id/comment', async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, branch: req.branchId });
    if (!task) return res.status(404).json({ success: false, message: 'Not found.' });
    const canComment = userHasPermission(req.user, 'task.management')
      || sameObjectId(task.assignedTo, req.user._id)
      || sameObjectId(task.assignedBy, req.user._id);
    if (!canComment) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    task.comments.push({ text: req.body.text, user: req.user._id, userName: req.user.name });
    await task.save();
    res.json({ success: true, message: 'Comment added.', data: task });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/:id', requirePermission('task.management'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Task, req.params.id, {
      user: req.user,
      branch: req.branchId,
      module: 'task',
      titleField: 'title',
      codeField: 'taskNumber',
      skipDependencyCheck: true,
    });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
