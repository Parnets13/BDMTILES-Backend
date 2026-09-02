import { verifyToken } from '../utils/jwt.js';
import User from '../models/User.js';
import Branch from '../models/Branch.js';
import { resolveBranchContext } from '../utils/branchScope.js';
import { ROLE_DEFAULT_PERMISSIONS } from '../config/permissions.js';

const LEGACY_PERMISSION_ALIASES = {
  'lead.management': ['lead.view', 'lead.create', 'lead.update', 'lead.assign', 'lead.app', 'lead.respond', 'lead.followup', 'lead.convert', 'lead.delete'],
  'cheque.management': ['cheque.view', 'cheque.create', 'cheque.deposit', 'cheque.clear', 'cheque.bounce', 'cheque.return'],
  'delivery.management': ['delivery.view', 'delivery.execute', 'delivery.verify', 'delivery.complete', 'delivery.fail'],
};

const tokenFromRequest = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.split(' ')[1];
  return req.cookies?.token || null;
};

export const buildAuthUser = async (userId) => {
  const user = await User.findById(userId)
    .select('-password')
    .populate({ path: 'assignedBranches', select: 'branchCode name status city state', match: { status: 'active' } })
    .populate({ path: 'defaultBranch', select: 'branchCode name status city state', match: { status: 'active' } })
    .populate('assignedWarehouse', 'warehouseCode name branch status')
    .populate('assignedWarehouses', 'warehouseCode name branch status')
    .lean();

  if (!user) return null;
  if (user.permissionMode === 'role_default') {
    user.permissions = [...(ROLE_DEFAULT_PERMISSIONS[user.role] || [])];
  }
  if (['super_admin', 'owner'].includes(user.role)) {
    user.assignedBranches = await Branch.find({ status: 'active' })
      .select('branchCode name status city state')
      .sort({ name: 1 })
      .lean();
  } else {
    user.assignedBranches = (user.assignedBranches || []).filter(Boolean);
  }

  const assignedIds = new Set(user.assignedBranches.map((branch) => String(branch._id)));
  const defaultId = String(user.defaultBranch?._id || user.defaultBranch || '');
  user.defaultBranch = user.assignedBranches.find((branch) => String(branch._id) === defaultId)
    || user.assignedBranches[0]
    || null;

  user.assignedWarehouses = (user.assignedWarehouses?.length
    ? user.assignedWarehouses
    : (user.assignedWarehouse ? [user.assignedWarehouse] : []))
    .filter((warehouse) => warehouse
      && warehouse.status === 'active'
      && assignedIds.has(String(warehouse.branch)));
  user.assignedWarehouse = user.assignedWarehouses[0] || null;
  return user;
};

const authenticateRequest = async (req, res) => {
  const token = tokenFromRequest(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'Not authorized. Please login.' });
    return false;
  }

  let decoded;
  try {
    decoded = verifyToken(token);
    if (decoded.type !== 'access') throw new Error('Wrong token type');
  } catch {
    res.status(401).json({ success: false, message: 'Invalid token.' });
    return false;
  }

  const user = await buildAuthUser(decoded.userId);
  if (!user) {
    res.status(401).json({ success: false, message: 'User not found.' });
    return false;
  }
  if (user.status !== 'Active') {
    res.status(401).json({ success: false, message: 'Account deactivated.' });
    return false;
  }
  if (!Number.isInteger(decoded.tokenVersion)
    || decoded.tokenVersion !== (user.tokenVersion || 0)) {
    res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    return false;
  }
  req.user = user;
  req.authToken = decoded;
  return true;
};

export const authenticateOnly = async (req, res, next) => {
  try {
    if (await authenticateRequest(req, res)) return next();
    return undefined;
  } catch (error) {
    return next(error);
  }
};

export const protect = async (req, res, next) => {
  try {
    if (!await authenticateRequest(req, res)) return undefined;
    if (req.user.mustChangePassword) {
      return res.status(403).json({
        success: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'You must change your password before continuing.',
      });
    }
    return resolveBranchContext(req, res, next);
  } catch (error) {
    return next(error);
  }
};

export const userHasPermission = (user, permission) => {
  if (!user || !permission) return false;
  if (user.role === 'super_admin' || user.role === 'owner') return true;

  const perms = user.permissions || [];
  const mod = permission.split('.')[0];
  const hasLegacyAlias = Object.entries(LEGACY_PERMISSION_ALIASES)
    .some(([legacy, aliases]) => perms.includes(legacy) && aliases.includes(permission));
  return perms.includes(permission) || perms.includes('*') || perms.includes(`${mod}.*`) || hasLegacyAlias;
};

export const requirePermission = (permission) => (req, res, next) => {
  if (!userHasPermission(req.user, permission)) {
    return res.status(403).json({ success: false, message: `Access denied: ${permission}` });
  }
  return next();
};

export const requireAnyPermission = (...permissions) => (req, res, next) => {
  if (!permissions.some((permission) => userHasPermission(req.user, permission))) {
    return res.status(403).json({
      success: false,
      message: `Access denied: requires one of ${permissions.join(', ')}`,
    });
  }
  return next();
};

export const getDataAccessFilter = async (user, module, branchId = null) => {
  // branchId is optional so existing two-argument call sites keep their current behavior.
  const branchFilter = branchId ? { branch: branchId } : {};
  if (['super_admin', 'owner'].includes(user.role)) return branchFilter;

  try {
    const NotificationSettings = (await import('../models/NotificationSettings.js')).default;
    const settings = await NotificationSettings.findOne({ module, ...branchFilter }).lean();

    if (!settings || !settings.dataAccess?.restrictByTime) return branchFilter;
    if (settings.dataAccess.exemptRoles?.includes(user.role)) return branchFilter;

    const days = Number(settings.dataAccess.accessWindowDays);
    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      return { ...branchFilter, createdAt: { $gte: cutoff } };
    }
  } catch (error) {
    console.error('getDataAccessFilter error:', error.message);
  }

  return branchFilter;
};
