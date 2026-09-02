import AccessPolicy from '../models/AccessPolicy.js';
import NotificationSettings from '../models/NotificationSettings.js';

const GLOBAL_ROLES = ['super_admin', 'owner'];

const dateScope = (rule, dateField) => {
  if (!rule?.enabled || rule.mode === 'all_time') return {};

  if (rule.mode === 'rolling_days') {
    const days = Number(rule.rollingDays);
    if (!Number.isInteger(days) || days < 1) throw new Error('Access policy has an invalid rolling-day window.');
    return { [dateField]: { $gte: new Date(Date.now() - (days * 24 * 60 * 60 * 1000)) } };
  }

  if (rule.mode === 'fixed_range') {
    const startDate = rule.startDate ? new Date(rule.startDate) : null;
    const endDate = rule.endDate ? new Date(rule.endDate) : null;
    if (!startDate || !endDate || Number.isNaN(startDate.valueOf()) || Number.isNaN(endDate.valueOf()) || startDate > endDate) {
      throw new Error('Access policy has an invalid fixed date range.');
    }
    return { [dateField]: { $gte: startDate, $lte: endDate } };
  }

  throw new Error(`Unsupported access policy mode: ${rule.mode}`);
};

const compatibilityRule = async ({ branchId, module, role }) => {
  const settings = await NotificationSettings.findOne({ branch: branchId, module }).select('dataAccess').lean();
  const legacy = settings?.dataAccess;
  if (!legacy?.restrictByTime || legacy.exemptRoles?.includes(role)) return null;
  const days = Number(legacy.accessWindowDays);
  if (!Number.isInteger(days) || days < 1) throw new Error('Legacy access policy has an invalid rolling-day window.');
  return { enabled: true, mode: 'rolling_days', rollingDays: days };
};

export const getAccessPolicyScope = async ({ user, branchId, module, resourceKey = '*', dateField = 'createdAt' }) => {
  if (!branchId) throw new Error('A branch is required to resolve data access.');
  const branchScope = { branch: branchId };
  if (GLOBAL_ROLES.includes(user?.role)) return branchScope;
  if (!user?.role || !module) throw new Error('User role and module are required to resolve data access.');

  const normalizedModule = String(module).trim().toLowerCase();
  const normalizedResource = String(resourceKey || '*').trim().toLowerCase();
  let policy = await AccessPolicy.findOne({
    branch: branchId,
    module: normalizedModule,
    resourceKey: normalizedResource,
  }).lean();
  if (!policy && normalizedResource !== '*') {
    policy = await AccessPolicy.findOne({ branch: branchId, module: normalizedModule, resourceKey: '*' }).lean();
  }

  if (!policy) {
    const fallback = await compatibilityRule({ branchId, module: normalizedModule, role: user.role });
    return fallback ? { ...branchScope, ...dateScope(fallback, dateField) } : branchScope;
  }
  if (!policy.enabled || policy.exemptRoles?.includes(user.role)) return branchScope;

  const roleRule = policy.rolePolicies?.find((candidate) => candidate.role === user.role && candidate.enabled);
  return { ...branchScope, ...dateScope(roleRule || { ...policy, enabled: true }, dateField) };
};

export default getAccessPolicyScope;
