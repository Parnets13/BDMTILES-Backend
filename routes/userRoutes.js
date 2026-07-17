import { Router } from 'express';
import User from '../models/User.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { AVAILABLE_PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from '../config/permissions.js';

const router = Router();
router.use(protect);
router.use(requirePermission('users.manage'));

// GET /api/v1/users/permissions-config
router.get('/permissions-config', (req, res) => {
  res.json({ success: true, permissions: AVAILABLE_PERMISSIONS, rolePermissions: ROLE_DEFAULT_PERMISSIONS });
});

// GET /api/v1/users
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, status, role, excludeRole } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ name: regex }, { email: regex }, { username: regex }, { phone: regex }];
    }
    if (status && status !== 'All') filter.status = status;
    if (role && role !== 'All') filter.role = role;
    if (excludeRole) filter.role = { ...(filter.role || {}), $ne: excludeRole };

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: users,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    console.error('Get users error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/users
router.post('/', async (req, res) => {
  try {
    const { name, username, email, password, phone, role, permissions, status } = req.body;

    const exists = await User.findOne({ $or: [{ email: email?.toLowerCase() }, { username: username?.toLowerCase() }] });
    if (exists) {
      return res.status(400).json({ success: false, message: 'Email or username already exists.' });
    }

    const user = await User.create({
      name, username: username.toLowerCase(), email: email.toLowerCase(),
      password, phone, role, permissions: permissions || [], status: status || 'Active',
      createdBy: req.user._id,
    });

    const userObj = user.toObject();
    delete userObj.password;
    res.status(201).json({ success: true, message: 'User created.', user: userObj });
  } catch (error) {
    console.error('Create user error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/v1/users/:id
router.put('/:id', async (req, res) => {
  try {
    const { password, ...data } = req.body;
    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    Object.assign(user, data);
    if (password?.trim()) user.password = password;
    await user.save();

    const userObj = user.toObject();
    delete userObj.password;
    res.json({ success: true, message: 'User updated.', user: userObj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/v1/users/:id
router.delete('/:id', async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'Cannot delete yourself.' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, message: 'User deleted.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/v1/users/:id/permissions
router.put('/:id/permissions', async (req, res) => {
  try {
    const { permissions } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, { permissions }, { new: true }).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, message: 'Permissions updated.', user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
