import { verifyToken } from '../utils/jwt.js';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authorized. Please login.' });
    }

    const decoded = verifyToken(token);
    const user = await User.findById(decoded.userId).select('-password').lean();

    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found.' });
    }
    if (user.status !== 'Active') {
      return res.status(401).json({ success: false, message: 'Account deactivated.' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
};

export const requirePermission = (permission) => (req, res, next) => {
  if (req.user.role === 'super_admin') return next();

  const perms = req.user.permissions || [];
  const mod = permission.split('.')[0];
  const has = perms.includes(permission) || perms.includes('*') || perms.includes(`${mod}.*`);

  if (!has) {
    return res.status(403).json({ success: false, message: `Access denied: ${permission}` });
  }
  next();
};
