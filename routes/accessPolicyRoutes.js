import { Router } from 'express';
import AccessPolicy from '../models/AccessPolicy.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { ROLE_INFO } from '../config/permissions.js';
import { requireBranch } from '../utils/branchScope.js';

const router = Router();
const WRITE_FIELDS = [
  'module', 'resourceKey', 'mode', 'rollingDays', 'startDate', 'endDate',
  'exemptRoles', 'rolePolicies', 'enabled',
];
const pick = (source) => WRITE_FIELDS.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(source || {}, field)) result[field] = source[field];
  return result;
}, {});
const requireOwner = (req, res, next) => {
  if (!['super_admin', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Only Super Admin / Owner can manage access policies.' });
  }
  return next();
};

const VALID_ROLES = new Set(Object.keys(ROLE_INFO));
const VALID_MODES = new Set(['all_time', 'rolling_days', 'fixed_range']);
const validateRule = (rule, label) => {
  if (rule?.enabled === false) return null;
  if (!VALID_MODES.has(rule?.mode)) return `${label} has an invalid mode.`;
  if (rule.mode === 'rolling_days' && (!Number.isInteger(Number(rule.rollingDays)) || Number(rule.rollingDays) < 1)) {
    return `${label} requires rollingDays to be a positive integer.`;
  }
  if (rule.mode === 'fixed_range') {
    const start = new Date(rule.startDate);
    const end = new Date(rule.endDate);
    if (!rule.startDate || !rule.endDate || Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) {
      return `${label} requires a valid ordered fixed date range.`;
    }
  }
  return null;
};
const validatePolicy = (body) => {
  const defaultError = validateRule(body, 'Default policy');
  if (body.enabled !== false && defaultError) return defaultError;
  if ((body.exemptRoles || []).some((role) => !VALID_ROLES.has(role))) return 'Exempt roles contain an unsupported role.';
  const rolePolicies = body.rolePolicies || [];
  const roles = rolePolicies.map((rule) => rule.role);
  if (roles.some((role) => !VALID_ROLES.has(role))) return 'Role policies contain an unsupported role.';
  if (new Set(roles).size !== roles.length) return 'Role policies cannot contain duplicate roles.';
  for (const rule of rolePolicies) {
    const error = validateRule(rule, `Policy for ${rule.role}`);
    if (error) return error;
  }
  return null;
};

router.use(protect);
router.use(requireBranch);
router.use(requireOwner);
router.use(requirePermission('access.policy.manage'));

router.get('/', async (req, res) => {
  try {
    const policies = await AccessPolicy.find({ branch: req.branchId })
      .sort({ module: 1, resourceKey: 1 })
      .populate('updatedBy', 'name role')
      .lean();
    return res.json({ success: true, data: policies });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:module/:resourceKey', async (req, res) => {
  try {
    const module = String(req.params.module || '').trim().toLowerCase();
    const resourceKey = String(req.params.resourceKey || req.body.resourceKey || '*').trim().toLowerCase();
    if (!module) return res.status(400).json({ success: false, message: 'Module is required.' });
    const validationError = validatePolicy(req.body || {});
    if (validationError) return res.status(422).json({ success: false, message: validationError });

    const policy = await AccessPolicy.findOneAndUpdate(
      { branch: req.branchId, module, resourceKey },
      {
        $set: { ...pick(req.body), module, resourceKey, updatedBy: req.user._id },
        $setOnInsert: { branch: req.branchId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return res.json({ success: true, message: 'Access policy saved.', data: policy });
  } catch (error) {
    return res.status(error?.code === 11000 ? 409 : 500).json({ success: false, message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const policy = await AccessPolicy.findOneAndDelete({ _id: req.params.id, branch: req.branchId });
    if (!policy) return res.status(404).json({ success: false, message: 'Access policy not found.' });
    return res.json({ success: true, message: 'Access policy deleted.', data: { _id: policy._id } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
