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
  // Super Admin and Owner have full unrestricted access
  if (req.user.role === 'super_admin' || req.user.role === 'owner') return next();

  const perms = req.user.permissions || [];
  const mod = permission.split('.')[0];
  const has = perms.includes(permission) || perms.includes('*') || perms.includes(`${mod}.*`);

  if (!has) {
    return res.status(403).json({ success: false, message: `Access denied: ${permission}` });
  }
  next();
};


/**
 * Data access filter — applies time-based restrictions based on NotificationSettings.dataAccess
 * Usage in routes: const dateFilter = await getDataAccessFilter(req.user, 'lead');
 * Returns a MongoDB filter object like { createdAt: { $gte: ... } } or {} (no restriction)
 */
export const getDataAccessFilter = async (user, module) => {
  // Super admin and owner always see everything
  if (['super_admin', 'owner'].includes(user.role)) return {};

  try {
    const NotificationSettings = (await import('../models/NotificationSettings.js')).default;
    const settings = await NotificationSettings.findOne({ module }).lean();

    if (!settings || !settings.dataAccess?.restrictByTime) return {};

    // Check if user's role is exempt
    if (settings.dataAccess.exemptRoles?.includes(user.role)) return {};

    // Apply time window restriction
    const days = settings.dataAccess.accessWindowDays;
    if (days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      return { createdAt: { $gte: cutoff } };
    }
  } catch (e) {
    console.error('getDataAccessFilter error:', e.message);
  }

  return {};
};
