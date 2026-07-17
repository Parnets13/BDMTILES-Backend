import { Router } from 'express';
import User from '../models/User.js';
import { generateToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { protect } from '../middleware/auth.js';

const router = Router();

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }

    const user = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: email.toLowerCase() }],
    }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }
    if (user.status !== 'Active') {
      return res.status(401).json({ success: false, message: 'Account deactivated.' });
    }

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);
    const userObj = user.toObject();
    delete userObj.password;

    res.json({ success: true, message: 'Login successful', token, refreshToken, user: userObj });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

// GET /api/v1/auth/me
router.get('/me', protect, async (req, res) => {
  res.json({ success: true, user: req.user });
});

// POST /api/v1/auth/logout
router.post('/logout', protect, (req, res) => {
  res.json({ success: true, message: 'Logged out.' });
});

// POST /api/v1/auth/refresh-token
router.post('/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Token required.' });
    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findById(decoded.userId).lean();
    if (!user || user.status !== 'Active') {
      return res.status(401).json({ success: false, message: 'Invalid token.' });
    }
    const token = generateToken(user._id, user.role);
    res.json({ success: true, token });
  } catch {
    res.status(401).json({ success: false, message: 'Invalid refresh token.' });
  }
});

export default router;
