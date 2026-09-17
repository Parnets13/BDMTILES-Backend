import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Branch from '../models/Branch.js';
import Warehouse from '../models/Warehouse.js';
import Region from '../models/Region.js';
import Dealer from '../models/Dealer.js';
import Employee from '../models/Employee.js';
import { protect, requirePermission, userHasPermission } from '../middleware/auth.js';
import { logActivity } from '../middleware/activityLogger.js';
import {
  GLOBAL_BRANCH_ROLES,
  assertWarehousesInBranches,
  getAssignedBranchIds,
  hasGlobalBranchAccess,
} from '../utils/branchScope.js';
import { AVAILABLE_PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, ROLE_INFO } from '../config/permissions.js';
import { validateStrongPassword } from '../utils/authSecurity.js';
import { canonicalPhone } from '../utils/phone.js';

const KNOWN_PERMISSIONS = new Set(
  Object.values(AVAILABLE_PERMISSIONS).flat().map((permission) => permission.id)
);
const REPORT_PERMISSIONS = AVAILABLE_PERMISSIONS.Reports || [];
const KNOWN_REPORT_PERMISSIONS = new Set(REPORT_PERMISSIONS.map((permission) => permission.id));
const ASSIGNMENT_DIMENSIONS = ['warehouses', 'regions', 'dealers', 'departments', 'reports', 'employees'];
const ASSIGNMENT_SCOPE_VALUES = new Set(['all', 'selected', 'none']);
const GLOBAL_ONLY_DIMENSIONS = new Set(['regions', 'dealers']);
const GLOBAL_DIMENSION_REASON = 'Unavailable until these records have branch ownership and can be isolated safely.';
const MAX_DEPARTMENTS = 50;
const MAX_DEPARTMENT_LENGTH = 100;

const httpError = (status, message, code) => Object.assign(
  new Error(message),
  { status, ...(code ? { code } : {}) }
);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idString = (value) => String(value?._id || value || '');

async function assertPhoneAvailable(value, excludeUserId = null) {
  const phone = String(value || '').trim();
  const canonical = canonicalPhone(phone);
  if (!canonical) {
    throw httpError(422, 'Enter a valid phone number using digits and standard phone formatting.');
  }

  const excludeFilter = excludeUserId ? { _id: { $ne: excludeUserId } } : {};
  const indexedMatch = await User.exists({ ...excludeFilter, phoneNormalized: canonical });
  if (indexedMatch) {
    throw httpError(409, 'This phone number is already used by another user.', 'PHONE_ALREADY_USED');
  }

  // Legacy users predate phoneNormalized. Keep checking them until they are
  // migrated naturally by an update or an explicit data-cleanup migration.
  const legacyUsers = await User.find({
    ...excludeFilter,
    $or: [{ phoneNormalized: { $exists: false } }, { phoneNormalized: null }],
  }).select('phone').lean();
  if (legacyUsers.some((user) => canonicalPhone(user.phone) === canonical)) {
    throw httpError(409, 'This phone number is already used by another user.', 'PHONE_ALREADY_USED');
  }
  return phone;
}

const isPhoneDuplicateKey = (error) => error?.code === 11000
  && Boolean(error?.keyPattern?.phoneNormalized || error?.keyValue?.phoneNormalized);

function assertCanAssignRole(actor, role) {
  if (!ROLE_INFO[role]) throw httpError(422, 'Unknown user role.');
  if (actor.role === 'super_admin') return;
  if (GLOBAL_BRANCH_ROLES.has(role)) {
    throw httpError(403, 'Only a super administrator can assign a global role.');
  }
  if (actor.role === 'owner') return;
  if ((ROLE_INFO[role]?.rank ?? Infinity) >= (ROLE_INFO[actor.role]?.rank ?? -1)) {
    throw httpError(403, 'You may assign only roles below your own role.');
  }
}

function assertCanManageTarget(actor, target) {
  if (actor.role === 'super_admin') return;
  if (GLOBAL_BRANCH_ROLES.has(target.role)) {
    throw httpError(403, 'Only a super administrator can manage global users.');
  }
  if (actor.role === 'owner') return;
  if ((ROLE_INFO[target.role]?.rank ?? Infinity) >= (ROLE_INFO[actor.role]?.rank ?? -1)) {
    throw httpError(403, 'You may manage only users below your own role.');
  }

  const actorIds = new Set(getAssignedBranchIds(actor));
  const targetIds = getAssignedBranchIds(target);
  if (!targetIds.length || targetIds.some((id) => !actorIds.has(id))) {
    throw httpError(403, 'The target user is outside your assigned branches.');
  }
}

function validatePermissionGrant(actor, permissions) {
  if (!Array.isArray(permissions)) throw httpError(422, 'permissions must be an array.');
  const unique = [...new Set(permissions.map(String))];
  if (unique.some((permission) => permission !== '*' && !KNOWN_PERMISSIONS.has(permission))) {
    throw httpError(422, 'One or more permissions are unknown.');
  }
  if (unique.includes('*') && actor.role !== 'super_admin') {
    throw httpError(403, 'Only a super administrator can grant unrestricted permission.');
  }
  if (!hasGlobalBranchAccess(actor)
    && unique.some((permission) => !userHasPermission(actor, permission))) {
    throw httpError(403, 'You cannot grant permissions you do not possess.');
  }
  return unique;
}

function roleDefaultPermissions(role) {
  return [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
}

function resolvePermissions(input, role, existingUser, actor) {
  const mode = hasOwn(input, 'permissionMode')
    ? input.permissionMode
    : (existingUser?.permissionMode || 'role_default');
  if (!['role_default', 'custom'].includes(mode)) {
    throw httpError(422, 'permissionMode must be role_default or custom.');
  }
  if (mode === 'role_default') {
    const permissions = roleDefaultPermissions(role);
    validatePermissionGrant(actor, permissions);
    return { permissionMode: mode, permissions };
  }
  if (hasOwn(input, 'permissions')) {
    return { permissionMode: mode, permissions: validatePermissionGrant(actor, input.permissions) };
  }
  if (!existingUser || existingUser.permissionMode !== 'custom') {
    throw httpError(422, 'Custom permission mode requires an explicit permissions array.');
  }
  return { permissionMode: mode, permissions: [...(existingUser.permissions || [])] };
}

function normalizeIdList(value, label) {
  if (!Array.isArray(value)) throw httpError(422, `${label} must be an array.`);
  const ids = [...new Set(value.map(idString).filter(Boolean))];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) {
    throw httpError(422, `One or more ${label.toLowerCase()} are invalid.`);
  }
  return ids;
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value)) throw httpError(422, `${label} must be an array.`);
  if (value.some((item) => typeof item !== 'string')) {
    throw httpError(422, `${label} must contain strings only.`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function normalizeDepartmentList(value) {
  const departments = normalizeStringList(value, 'Assigned departments');
  const seen = new Set();
  return departments.filter((department) => {
    const canonical = department.toLocaleLowerCase();
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

function validateScopePayload(input) {
  if (!hasOwn(input, 'assignmentScopes')) return;
  if (!input.assignmentScopes || typeof input.assignmentScopes !== 'object' || Array.isArray(input.assignmentScopes)) {
    throw httpError(422, 'assignmentScopes must be an object.');
  }
  const unknown = Object.keys(input.assignmentScopes)
    .filter((dimension) => !ASSIGNMENT_DIMENSIONS.includes(dimension));
  if (unknown.length) throw httpError(422, `Unknown assignment scope: ${unknown[0]}.`);
}

function resolveScope(input, dimension, values, existingUser, valueWasProvided) {
  const scopeWasProvided = hasOwn(input.assignmentScopes || {}, dimension);
  if (scopeWasProvided) {
    const scope = input.assignmentScopes[dimension];
    if (!ASSIGNMENT_SCOPE_VALUES.has(scope)) {
      throw httpError(422, `${dimension} scope must be all, selected, or none.`);
    }
    return { scope, explicit: true };
  }
  if (valueWasProvided) return { scope: values.length ? 'selected' : 'none', explicit: true };

  const existingScope = existingUser?.assignmentScopes?.[dimension];
  if (existingScope === 'all') return { scope: 'all', explicit: false };
  if (existingScope === 'selected') return { scope: 'selected', explicit: false };
  if (values.length) return { scope: 'selected', explicit: false };
  return { scope: ASSIGNMENT_SCOPE_VALUES.has(existingScope) ? existingScope : 'none', explicit: false };
}

async function validateActiveIds(Model, ids, statusFilter, label) {
  if (!ids.length) return [];
  const rows = await Model.find({ _id: { $in: ids }, ...statusFilter }).lean();
  if (rows.length !== ids.length) {
    throw httpError(422, `All selected ${label} must exist and be active.`);
  }
  return rows;
}

async function normalizeBranchAssignments(input, role, existingUser = null, actor = null) {
  let assignedBranches = hasOwn(input, 'assignedBranches')
    ? input.assignedBranches
    : (existingUser?.assignedBranches || []);
  assignedBranches = normalizeIdList(assignedBranches || [], 'Assigned branches');

  if (GLOBAL_BRANCH_ROLES.has(role)) {
    assignedBranches = (await Branch.find({ status: 'active' }).select('_id').lean())
      .map((item) => String(item._id));
  }

  if (assignedBranches.length) {
    const activeCount = await Branch.countDocuments({ _id: { $in: assignedBranches }, status: 'active' });
    if (activeCount !== assignedBranches.length) {
      throw httpError(422, 'All assigned branches must exist and be active.');
    }
  } else if (!GLOBAL_BRANCH_ROLES.has(role) && await Branch.exists({ status: 'active' })) {
    throw httpError(422, 'At least one branch assignment is required.');
  }

  if (actor && !hasGlobalBranchAccess(actor)) {
    const actorBranchIds = new Set(getAssignedBranchIds(actor));
    if (assignedBranches.some((id) => !actorBranchIds.has(id))) {
      throw httpError(403, 'You may assign only your own branches.');
    }
  }

  const requestedDefault = hasOwn(input, 'defaultBranch')
    ? input.defaultBranch
    : existingUser?.defaultBranch;
  let defaultBranch = idString(requestedDefault);
  if (defaultBranch && !mongoose.isValidObjectId(defaultBranch)) {
    throw httpError(422, 'Default branch is invalid.');
  }
  if (defaultBranch && !assignedBranches.includes(defaultBranch)) {
    throw httpError(422, 'Default branch must be one of the assigned branches.');
  }
  if (!defaultBranch && assignedBranches.length) defaultBranch = assignedBranches[0];

  return { assignedBranches, defaultBranch: defaultBranch || undefined };
}

function existingIds(existingUser, pluralField, legacyField = null) {
  const plural = existingUser?.[pluralField] || [];
  if (plural.length) return normalizeIdList(plural, pluralField);
  if (legacyField && existingUser?.[legacyField]) {
    return normalizeIdList([existingUser[legacyField]], pluralField);
  }
  return [];
}

function restrictedDimension(actor, dimension, scopeState, values) {
  if (hasGlobalBranchAccess(actor) || !GLOBAL_ONLY_DIMENSIONS.has(dimension)) return false;
  if (!scopeState.explicit) return true;
  if (scopeState.scope !== 'none' || values.length) {
    throw httpError(403, `${dimension} assignments are ${GLOBAL_DIMENSION_REASON.toLowerCase()}`);
  }
  return false;
}

async function normalizeAssignments(input, branchAssignments, existingUser, actor) {
  validateScopePayload(input);

  const warehouseProvided = hasOwn(input, 'assignedWarehouses') || hasOwn(input, 'assignedWarehouse');
  let assignedWarehouses = warehouseProvided
    ? normalizeIdList(
      hasOwn(input, 'assignedWarehouses')
        ? (input.assignedWarehouses || [])
        : (input.assignedWarehouse ? [input.assignedWarehouse] : []),
      'Assigned warehouses'
    )
    : existingIds(existingUser, 'assignedWarehouses', 'assignedWarehouse');
  const warehouseScope = resolveScope(input, 'warehouses', assignedWarehouses, existingUser, warehouseProvided);
  if (warehouseScope.scope === 'selected') {
    if (!assignedWarehouses.length) throw httpError(422, 'Selected warehouse scope requires at least one warehouse.');
    await assertWarehousesInBranches(assignedWarehouses, branchAssignments.assignedBranches);
  } else {
    assignedWarehouses = [];
  }

  const regionProvided = hasOwn(input, 'assignedRegions');
  let assignedRegions = regionProvided
    ? normalizeIdList(input.assignedRegions || [], 'Assigned regions')
    : existingIds(existingUser, 'assignedRegions');
  const regionScope = resolveScope(input, 'regions', assignedRegions, existingUser, regionProvided);
  const preserveRegions = restrictedDimension(actor, 'regions', regionScope, assignedRegions);
  if (!preserveRegions) {
    if (regionScope.scope === 'selected') {
      if (!assignedRegions.length) throw httpError(422, 'Selected region scope requires at least one region.');
      await validateActiveIds(Region, assignedRegions, { status: 'active' }, 'regions');
    } else assignedRegions = [];
  }

  const dealerProvided = hasOwn(input, 'assignedDealers');
  let assignedDealers = dealerProvided
    ? normalizeIdList(input.assignedDealers || [], 'Assigned dealers')
    : existingIds(existingUser, 'assignedDealers');
  const dealerScope = resolveScope(input, 'dealers', assignedDealers, existingUser, dealerProvided);
  const preserveDealers = restrictedDimension(actor, 'dealers', dealerScope, assignedDealers);
  let dealerRows = [];
  if (!preserveDealers) {
    if (dealerScope.scope === 'selected') {
      if (!assignedDealers.length) throw httpError(422, 'Selected dealer scope requires at least one dealer.');
      dealerRows = await validateActiveIds(Dealer, assignedDealers, { status: 'active' }, 'dealers');
    } else assignedDealers = [];
  }

  const departmentProvided = hasOwn(input, 'assignedDepartments');
  let assignedDepartments = departmentProvided
    ? normalizeDepartmentList(input.assignedDepartments || [])
    : normalizeDepartmentList(existingUser?.assignedDepartments || []);
  const departmentScope = resolveScope(input, 'departments', assignedDepartments, existingUser, departmentProvided);
  const preserveDepartments = restrictedDimension(actor, 'departments', departmentScope, assignedDepartments);
  if (!preserveDepartments) {
    if (departmentScope.scope === 'selected') {
      if (!assignedDepartments.length) throw httpError(422, 'Selected department scope requires at least one department.');
      if (assignedDepartments.length > MAX_DEPARTMENTS
        || assignedDepartments.some((department) => department.length > MAX_DEPARTMENT_LENGTH)) {
        throw httpError(422, `Select at most ${MAX_DEPARTMENTS} departments, each up to ${MAX_DEPARTMENT_LENGTH} characters.`);
      }
      const availableDepartments = await Employee.distinct('department', {
        branchId: { $in: branchAssignments.assignedBranches },
        status: 'Active',
        department: { $in: assignedDepartments },
      });
      const availableSet = new Set(availableDepartments.map((department) => String(department).trim()));
      if (assignedDepartments.some((department) => !availableSet.has(department))) {
        throw httpError(422, 'One or more departments do not belong to the assigned branches.');
      }
    } else assignedDepartments = [];
  }

  const reportProvided = hasOwn(input, 'assignedReports');
  let assignedReports = reportProvided
    ? normalizeStringList(input.assignedReports || [], 'Assigned reports')
    : normalizeStringList(existingUser?.assignedReports || [], 'Assigned reports');
  const reportScope = resolveScope(input, 'reports', assignedReports, existingUser, reportProvided);
  if (reportScope.scope === 'selected') {
    if (!assignedReports.length) throw httpError(422, 'Selected report scope requires at least one report.');
    if (assignedReports.some((permission) => !KNOWN_REPORT_PERMISSIONS.has(permission))) {
      throw httpError(422, 'Assigned reports must contain canonical report permission IDs only.');
    }
    if (assignedReports.some((permission) => !userHasPermission(actor, permission))) {
      throw httpError(403, 'You cannot assign report access you do not possess.');
    }
  } else if (reportScope.scope === 'all') {
    if (REPORT_PERMISSIONS.some((permission) => !userHasPermission(actor, permission.id))) {
      throw httpError(403, 'You cannot assign all reports because you do not possess every report permission.');
    }
    assignedReports = [];
  } else assignedReports = [];

  const employeeProvided = hasOwn(input, 'assignedEmployees');
  let assignedEmployees = employeeProvided
    ? normalizeIdList(input.assignedEmployees || [], 'Assigned employees')
    : existingIds(existingUser, 'assignedEmployees');
  const employeeScope = resolveScope(input, 'employees', assignedEmployees, existingUser, employeeProvided);
  const preserveEmployees = restrictedDimension(actor, 'employees', employeeScope, assignedEmployees);
  if (!preserveEmployees) {
    if (employeeScope.scope === 'selected') {
      if (!assignedEmployees.length) throw httpError(422, 'Selected employee scope requires at least one employee.');
      await validateActiveIds(
        Employee,
        assignedEmployees,
        { status: 'Active', branchId: { $in: branchAssignments.assignedBranches } },
        'employees'
      );
    } else assignedEmployees = [];
  }

  if (!preserveRegions && !preserveDealers
    && regionScope.scope === 'selected' && dealerScope.scope === 'selected') {
    const regionIds = new Set(assignedRegions);
    if (dealerRows.some((dealer) => !dealer.assignedRegion || !regionIds.has(String(dealer.assignedRegion)))) {
      throw httpError(422, 'Every selected dealer must belong to one of the selected regions.');
    }
  }

  return {
    assignmentScopes: {
      warehouses: warehouseScope.scope,
      regions: regionScope.scope,
      dealers: dealerScope.scope,
      departments: departmentScope.scope,
      reports: reportScope.scope,
      employees: employeeScope.scope,
    },
    assignedWarehouses,
    assignedWarehouse: assignedWarehouses[0] || null,
    assignedRegions,
    assignedDealers,
    assignedDepartments,
    assignedReports,
    assignedEmployees,
  };
}

function populateAssignmentRefs(query, actor) {
  query
    .populate('assignedBranches', 'branchCode name status')
    .populate('defaultBranch', 'branchCode name status')
    .populate('assignedWarehouse', 'warehouseCode name branch status')
    .populate('assignedWarehouses', 'warehouseCode name branch status');
  if (hasGlobalBranchAccess(actor)) {
    query
      .populate('assignedRegions', 'name state status')
      .populate('assignedDealers', 'dealerCode businessName assignedRegion status')
      .populate('assignedEmployees', 'empId name designation department status');
  }
  return query;
}

function sanitizeUserForActor(user, actor) {
  const value = user?.toObject ? user.toObject() : user;
  if (!value) return value;

  // Treat response sanitization as an explicit contract, not only a projection side effect.
  for (const field of [
    'password', 'refreshSessions', 'passwordResetTokenHash', 'passwordResetExpiresAt',
    'fcmToken', 'tokenVersion', 'failedLoginAttempts', 'loginLockedUntil',
  ]) delete value[field];
  if (value.deactivation) {
    value.deactivation = {
      at: value.deactivation.at,
      by: value.deactivation.by,
      reason: value.deactivation.reason,
      branch: value.deactivation.branch,
    };
  }

  if (value.permissionMode === 'role_default') value.permissions = roleDefaultPermissions(value.role);
  if (!hasGlobalBranchAccess(actor)) {
    value.assignedRegions = [];
    value.assignedDealers = [];
    value.assignedDepartments = [];
    value.assignedEmployees = [];
  }
  return value;
}

async function getPopulatedUser(userId, actor) {
  const user = await populateAssignmentRefs(User.findById(userId), actor).lean();
  return sanitizeUserForActor(user, actor);
}

const MAX_DEACTIVATION_REASON_LENGTH = 500;
const idEquals = (left, right) => idString(left) === idString(right);

function collectUserReferencePaths(schema, prefix = '', visited = new Set()) {
  if (!schema || visited.has(schema)) return [];
  visited.add(schema);
  const paths = [];
  schema.eachPath((pathName, schemaType) => {
    const fullPath = prefix ? `${prefix}.${pathName}` : pathName;
    const directRef = schemaType?.options?.ref;
    const arrayRef = schemaType?.caster?.options?.ref;
    if (directRef === 'User' || arrayRef === 'User') paths.push(fullPath);
    if (schemaType?.schema) {
      paths.push(...collectUserReferencePaths(schemaType.schema, fullPath, new Set(visited)));
    }
  });
  return [...new Set(paths)];
}

async function captureUserDependencies(userId) {
  const models = Object.values(mongoose.models)
    .filter((Model) => Model?.schema && typeof Model.countDocuments === 'function');
  const rows = await Promise.all(models.map(async (Model) => {
    const fields = collectUserReferencePaths(Model.schema);
    if (!fields.length) return null;
    const count = await Model.countDocuments({
      $or: fields.map((field) => ({ [field]: userId })),
    });
    return count > 0 ? { model: Model.modelName, count, fields } : null;
  }));
  const byModel = rows.filter(Boolean).sort((left, right) => left.model.localeCompare(right.model));
  return {
    capturedAt: new Date(),
    totalDocuments: byModel.reduce((sum, item) => sum + item.count, 0),
    totalModels: byModel.length,
    byModel,
  };
}

function dependencySummary(snapshot) {
  return {
    capturedAt: snapshot?.capturedAt || null,
    totalDocuments: snapshot?.totalDocuments || 0,
    totalModels: snapshot?.totalModels || 0,
    byModel: Array.isArray(snapshot?.byModel) ? snapshot.byModel : [],
  };
}

function deactivationMetadata(req) {
  return {
    actor: {
      id: req.user._id,
      name: req.user.name || '',
      role: req.user.role || '',
    },
    ipAddress: req.ip || req.connection?.remoteAddress || '',
    userAgent: req.get?.('user-agent') || '',
    device: req.get?.('x-device') || 'web',
  };
}

const router = Router();
router.use(protect);
router.use(requirePermission('users.manage'));

router.get('/permissions-config', (req, res) => {
  res.json({
    success: true,
    permissions: AVAILABLE_PERMISSIONS,
    rolePermissions: ROLE_DEFAULT_PERMISSIONS,
    roleInfo: ROLE_INFO,
  });
});

router.get('/assignment-options', async (req, res) => {
  try {
    const globalAccess = hasGlobalBranchAccess(req.user);
    const branchFilter = globalAccess
      ? { status: 'active' }
      : { _id: { $in: getAssignedBranchIds(req.user) }, status: 'active' };
    const branches = await Branch.find(branchFilter)
      .select('branchCode name status')
      .sort({ name: 1 })
      .lean();
    const branchIds = branches.map((branch) => branch._id);

    const [warehouses, regions, dealers, employees] = await Promise.all([
      Warehouse.find({ branch: { $in: branchIds }, status: 'active' })
        .select('warehouseCode name branch status')
        .populate('branch', 'branchCode name')
        .sort({ name: 1 })
        .lean(),
      globalAccess
        ? Region.find({ status: 'active' }).select('name state status').sort({ name: 1 }).lean()
        : Promise.resolve([]),
      globalAccess
        ? Dealer.find({ status: 'active' })
          .select('dealerCode businessName assignedRegion status')
          .sort({ businessName: 1 })
          .lean()
        : Promise.resolve([]),
      Employee.find({ branchId: { $in: branchIds }, status: 'Active' })
        .select('empId name designation department status branchId')
        .sort({ name: 1 })
        .lean(),
    ]);
    const departments = [...new Set(employees.map((employee) => employee.department?.trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    const reports = REPORT_PERMISSIONS.filter((permission) => userHasPermission(req.user, permission.id));
    const restrictedAvailability = globalAccess
      ? { available: true, reason: null }
      : { available: false, reason: GLOBAL_DIMENSION_REASON };

    return res.json({
      success: true,
      data: { branches, warehouses, regions, dealers, departments, reports, employees },
      availability: {
        warehouses: { available: true, reason: null },
        regions: restrictedAvailability,
        dealers: restrictedAvailability,
        departments: { available: departments.length > 0, reason: departments.length ? null : 'No active employee departments are available in the assigned branches.' },
        reports: {
          available: reports.length > 0,
          allowAll: reports.length === REPORT_PERMISSIONS.length,
          reason: reports.length ? null : 'You do not have grantable report permissions.',
        },
        employees: { available: employees.length > 0, reason: employees.length ? null : 'No active employees are available in the assigned branches.' },
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, status, role, excludeRole } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10));
    const clauses = [];

    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      clauses.push({ $or: [{ name: regex }, { email: regex }, { username: regex }, { phone: regex }] });
    }
    if (status && status !== 'All') clauses.push({ status });
    if (role && role !== 'All') clauses.push({ role });
    if (excludeRole) clauses.push({ role: { $ne: excludeRole } });

    if (!hasGlobalBranchAccess(req.user)) {
      const actorIds = getAssignedBranchIds(req.user);
      clauses.push({ role: { $nin: [...GLOBAL_BRANCH_ROLES] } });
      clauses.push({ 'assignedBranches.0': { $exists: true } });
      clauses.push({
        $expr: {
          $setIsSubset: [
            { $ifNull: ['$assignedBranches', []] },
            actorIds.map((id) => new mongoose.Types.ObjectId(id)),
          ],
        },
      });
    }

    if (req.query.branch) {
      if (!mongoose.isValidObjectId(req.query.branch)) throw httpError(422, 'Invalid branch filter.');
      if (!hasGlobalBranchAccess(req.user) && !getAssignedBranchIds(req.user).includes(String(req.query.branch))) {
        throw httpError(403, 'Branch access denied.');
      }
      clauses.push({ assignedBranches: req.query.branch });
    }

    const filter = clauses.length ? { $and: clauses } : {};
    const usersQuery = User.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l);
    const [users, total] = await Promise.all([
      populateAssignmentRefs(usersQuery, req.user).lean(),
      User.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: users.map((user) => sanitizeUserForActor(user, req.user)),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, username, email, password, phone, status } = req.body;
    const role = req.body.role || 'sales_executive';
    if (!username || !email || !password || !name || !phone) {
      throw httpError(422, 'Name, username, email, phone, and password are required.');
    }
    assertCanAssignRole(req.user, role);
    const normalizedPhone = await assertPhoneAvailable(phone);

    const exists = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
    });
    if (exists) throw httpError(400, 'Email or username already exists.');

    const passwordError = validateStrongPassword(password);
    if (passwordError) throw httpError(422, passwordError);

    const branchAssignments = await normalizeBranchAssignments(req.body, role, null, req.user);
    const assignments = await normalizeAssignments(req.body, branchAssignments, null, req.user);
    const permissionState = resolvePermissions(
      { ...req.body, permissionMode: req.body.permissionMode || 'role_default' },
      role,
      null,
      req.user
    );

    const user = await User.create({
      name,
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password,
      phone: normalizedPhone,
      role,
      status: status || 'Active',
      mustChangePassword: true,
      ...permissionState,
      ...branchAssignments,
      ...assignments,
      createdBy: req.user._id,
    });

    return res.status(201).json({
      success: true,
      message: 'User created.',
      user: await getPopulatedUser(user._id, req.user),
    });
  } catch (error) {
    const phoneConflict = error.code === 'PHONE_ALREADY_USED' || isPhoneDuplicateKey(error);
    return res.status(phoneConflict ? 409 : (error.status || (error.code === 11000 ? 400 : 500)))
      .json({
        success: false,
        message: phoneConflict ? 'This phone number is already used by another user.' : error.message,
        ...(phoneConflict ? { code: 'PHONE_ALREADY_USED' } : {}),
      });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(422, 'Invalid user ID.');
    const user = await User.findById(req.params.id).select('+refreshSessions');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    assertCanManageTarget(req.user, user);

    const normalizedPhone = hasOwn(req.body, 'phone')
      ? await assertPhoneAvailable(req.body.phone, user._id)
      : user.phone;

    const nextRole = req.body.role || user.role;
    if (idEquals(user._id, req.user._id) && nextRole !== user.role) {
      throw httpError(403, 'You cannot change your own role.');
    }
    assertCanAssignRole(req.user, nextRole);

    const requestedStatus = hasOwn(req.body, 'status') ? req.body.status : user.status;
    if (!['Active', 'Inactive'].includes(requestedStatus)) {
      throw httpError(422, 'Status must be Active or Inactive.');
    }
    if (requestedStatus !== user.status && idEquals(user._id, req.user._id)) {
      throw httpError(403, 'You cannot change your own account status.');
    }
    if (user.status === 'Active' && requestedStatus === 'Inactive') {
      throw httpError(422, 'Use the deactivation action to deactivate a user safely.');
    }

    const isReactivation = user.status === 'Inactive' && requestedStatus === 'Active';
    if (isReactivation) {
      const linkedEmployee = await Employee.findOne({ userId: user._id }).select('status').lean();
      if (linkedEmployee && ['Inactive', 'Terminated'].includes(linkedEmployee.status)) {
        throw httpError(409, `Cannot reactivate a user linked to an ${linkedEmployee.status} employee.`);
      }
    }

    const branchInput = {};
    if (hasOwn(req.body, 'assignedBranches')) branchInput.assignedBranches = req.body.assignedBranches;
    if (hasOwn(req.body, 'defaultBranch')) branchInput.defaultBranch = req.body.defaultBranch;
    const branchAssignments = await normalizeBranchAssignments(branchInput, nextRole, user, req.user);
    const assignments = await normalizeAssignments(req.body, branchAssignments, user, req.user);
    const permissionState = resolvePermissions(req.body, nextRole, user, req.user);

    for (const field of ['name', 'username', 'email']) {
      if (hasOwn(req.body, field)) user[field] = req.body[field];
    }
    user.phone = normalizedPhone;
    user.status = requestedStatus;
    user.role = nextRole;
    Object.assign(user, permissionState, branchAssignments, assignments);
    if (isReactivation) {
      user.lastReactivation = {
        at: new Date(),
        by: req.user._id,
        branch: req.branchId || undefined,
      };
      user.failedLoginAttempts = 0;
      user.loginLockedUntil = undefined;
    }
    await user.save();

    const responseUser = await getPopulatedUser(user._id, req.user);
    if (isReactivation) {
      res.locals.skipAutoActivityLog = true;
      await logActivity({
        user: req.user,
        action: 'status_change',
        module: 'user',
        recordId: user._id,
        recordTitle: user.name,
        recordModel: 'User',
        description: `Reactivated user ${user.name}`,
        metadata: { from: 'Inactive', to: 'Active' },
        branch: req.branchId,
        req,
      });
    }

    return res.json({ success: true, message: isReactivation ? 'User reactivated.' : 'User updated.', user: responseUser });
  } catch (error) {
    const phoneConflict = error.code === 'PHONE_ALREADY_USED' || isPhoneDuplicateKey(error);
    const status = phoneConflict
      ? 409
      : (error.status || (error.code === 11000 ? 400 : (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500)));
    return res.status(status).json({
      success: false,
      message: phoneConflict ? 'This phone number is already used by another user.' : error.message,
      ...(phoneConflict ? { code: 'PHONE_ALREADY_USED' } : {}),
    });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    if (req.params.id === String(req.user._id)) {
      throw httpError(400, 'Use Change Password to update your own password.');
    }
    const temporaryPassword = String(req.body?.temporaryPassword || '');
    const passwordError = validateStrongPassword(temporaryPassword);
    if (passwordError) throw httpError(422, passwordError);

    const target = await User.findById(req.params.id).select('+password +refreshSessions');
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    assertCanManageTarget(req.user, target);
    if (await target.comparePassword(temporaryPassword)) {
      throw httpError(422, 'Temporary password must be different from the current password.');
    }

    target.password = temporaryPassword;
    target.mustChangePassword = true;
    target.tokenVersion = (target.tokenVersion || 0) + 1;
    target.refreshSessions = [];
    target.failedLoginAttempts = 0;
    target.loginLockedUntil = undefined;
    target.passwordResetTokenHash = undefined;
    target.passwordResetExpiresAt = undefined;
    await target.save();

    return res.json({
      success: true,
      message: 'Temporary password set. The user must change it at next login.',
      user: await getPopulatedUser(target._id, req.user),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(422, 'Invalid user ID.');
    if (idEquals(req.params.id, req.user._id)) throw httpError(400, 'Cannot deactivate yourself.');

    const reason = String(req.body?.reason || req.body?.deactivationReason || 'Administrative deactivation').trim();
    if (!reason) throw httpError(422, 'A deactivation reason is required.');
    if (reason.length > MAX_DEACTIVATION_REASON_LENGTH) {
      throw httpError(422, `Deactivation reason cannot exceed ${MAX_DEACTIVATION_REASON_LENGTH} characters.`);
    }

    let target = await User.findById(req.params.id).lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    assertCanManageTarget(req.user, target);

    let snapshot = target.deactivation?.dependencySnapshot || await captureUserDependencies(target._id);
    const deactivation = {
      at: new Date(),
      by: req.user._id,
      reason,
      branch: req.branchId || undefined,
      metadata: deactivationMetadata(req),
      dependencySnapshot: snapshot,
    };
    let transitioned = false;

    if (target.status === 'Active') {
      const updated = await User.findOneAndUpdate(
        { _id: target._id, status: 'Active' },
        {
          $set: {
            status: 'Inactive',
            deactivation,
            refreshSessions: [],
            failedLoginAttempts: 0,
            mustChangePassword: true,
          },
          $unset: {
            fcmToken: 1,
            loginLockedUntil: 1,
            passwordResetTokenHash: 1,
            passwordResetExpiresAt: 1,
          },
          $inc: { tokenVersion: 1 },
        },
        { new: true, runValidators: true }
      ).lean();
      transitioned = Boolean(updated);
      if (updated) target = updated;
      else {
        target = await User.findById(req.params.id).lean();
        if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
        snapshot = target.deactivation?.dependencySnapshot || snapshot;
      }
    }

    if (!transitioned) {
      const cleanupSet = {
        refreshSessions: [],
        failedLoginAttempts: 0,
        mustChangePassword: true,
      };
      if (!target.deactivation) cleanupSet.deactivation = deactivation;
      else if (!target.deactivation.dependencySnapshot) {
        cleanupSet['deactivation.dependencySnapshot'] = snapshot;
      }
      await User.updateOne(
        { _id: target._id, status: 'Inactive' },
        {
          $set: cleanupSet,
          $unset: {
            fcmToken: 1,
            loginLockedUntil: 1,
            passwordResetTokenHash: 1,
            passwordResetExpiresAt: 1,
          },
        },
        { runValidators: true }
      );
      target = await User.findById(req.params.id).lean();
      snapshot = target?.deactivation?.dependencySnapshot || snapshot;
    }

    const responseUser = await getPopulatedUser(req.params.id, req.user);
    res.locals.skipAutoActivityLog = true;
    if (transitioned) {
      await logActivity({
        user: req.user,
        action: 'status_change',
        module: 'user',
        recordId: target._id,
        recordTitle: target.name,
        recordModel: 'User',
        description: `Deactivated user ${target.name}`,
        metadata: {
          reason,
          dependencySummary: dependencySummary(snapshot),
          from: 'Active',
          to: 'Inactive',
        },
        branch: req.branchId,
        req,
      });
    }

    return res.json({
      success: true,
      message: transitioned ? 'User deactivated. Existing references were preserved.' : 'User is already inactive.',
      transitioned,
      data: responseUser,
      dependencySummary: dependencySummary(snapshot),
    });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.message });
  }
});

router.put('/:id/permissions/reset', async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    assertCanManageTarget(req.user, target);
    target.permissionMode = 'role_default';
    target.permissions = validatePermissionGrant(req.user, roleDefaultPermissions(target.role));
    await target.save();
    return res.json({
      success: true,
      message: 'Permissions reset to role defaults.',
      user: await getPopulatedUser(target._id, req.user),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.put('/:id/permissions', async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    assertCanManageTarget(req.user, target);
    target.permissionMode = 'custom';
    target.permissions = validatePermissionGrant(req.user, req.body.permissions);
    await target.save();
    return res.json({
      success: true,
      message: 'Custom permissions updated.',
      user: await getPopulatedUser(target._id, req.user),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
