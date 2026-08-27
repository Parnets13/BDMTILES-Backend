import mongoose from 'mongoose';
import Branch from '../models/Branch.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import Warehouse from '../models/Warehouse.js';
import { ROLE_DEFAULT_PERMISSIONS, ROLE_INFO } from '../config/permissions.js';
import { getAssignedBranchIds, hasGlobalBranchAccess } from '../utils/branchScope.js';
import { validateStrongPassword } from '../utils/authSecurity.js';

const FORBIDDEN_APP_ROLES = new Set(['super_admin', 'owner', 'admin', 'sub_admin']);
const OPERATIONAL_APP_ROLES = new Set([
  'sales_manager',
  'purchase_manager',
  'warehouse_manager',
  'finance_manager',
  'hr_manager',
  'sales_executive',
  'delivery_executive',
  'picking_staff',
  'sorting_staff',
]);

const EMPLOYEE_WRITE_FIELDS = [
  'empId', 'name', 'fatherName', 'designation', 'department', 'dateOfJoining', 'dateOfBirth',
  'gender', 'mobile', 'alternateMobile', 'email', 'address', 'city', 'state', 'pinCode',
  'emergencyContact', 'aadhaar', 'pan', 'uan', 'esiNumber', 'bankName', 'accountNumber',
  'ifscCode', 'accountHolderName', 'employmentType', 'probationEndDate', 'reportingManager',
  'workLocation', 'shift', 'salaryType', 'basicSalary', 'hra', 'conveyance', 'medicalAllowance',
  'specialAllowance', 'otherAllowance', 'pf', 'esi', 'professionalTax', 'tds',
  'otherDeductions', 'dailyWageRate', 'attendanceType', 'leaveBalance', 'status', 'documents',
  'profileImage',
];

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const idString = (value) => String(value?._id || value || '');
const serviceError = (status, message, code) => Object.assign(new Error(message), { status, code });

const isTransactionUnsupported = (error) => error?.code === 20
  || error?.codeName === 'IllegalOperation'
  || /transaction numbers are only allowed|transactions are not supported|replica set member or mongos/i.test(error?.message || '');

const mapTransactionError = (error) => {
  if (isTransactionUnsupported(error)) {
    return serviceError(
      503,
      'Employee lifecycle changes require MongoDB transaction support. Configure a replica set and retry; no partial changes were saved.',
      'TRANSACTIONS_UNAVAILABLE'
    );
  }
  return error;
};

const mapDuplicateError = (error) => {
  if (error?.code !== 11000) return error;
  const key = Object.keys(error.keyPattern || error.keyValue || {})[0];
  if (key === 'username') return serviceError(409, 'That app-access username is already in use.', 'USERNAME_CONFLICT');
  if (key === 'email') return serviceError(409, 'That app-access email is already in use.', 'EMAIL_CONFLICT');
  if (key === 'userId') return serviceError(409, 'That user account is already linked to another employee.', 'USER_LINK_CONFLICT');
  if (key === 'empId') return serviceError(409, 'Employee code already exists.', 'EMPLOYEE_CODE_CONFLICT');
  return serviceError(409, 'A unique employee or app-access value already exists.', 'DUPLICATE_VALUE');
};

const runInTransaction = async (work) => {
  let session;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    throw mapDuplicateError(mapTransactionError(error));
  } finally {
    if (session) await session.endSession();
  }
};

const normalizeLogin = (value) => String(value || '').trim().toLowerCase();
const normalizePhone = (value) => String(value || '').trim();

const pickEmployeeInput = (input) => EMPLOYEE_WRITE_FIELDS.reduce((result, field) => {
  if (hasOwn(input, field)) result[field] = input[field];
  return result;
}, {});

const assertNoUserIdTampering = (input) => {
  if (hasOwn(input, 'userId') || hasOwn(input?.appAccess, 'userId')) {
    throw serviceError(422, 'userId is managed by the employee lifecycle and cannot be supplied.', 'USER_LINK_TAMPERING');
  }
  if (hasOwn(input, 'appAccess')
    && (!input.appAccess || typeof input.appAccess !== 'object' || Array.isArray(input.appAccess))) {
    throw serviceError(422, 'appAccess must be an object.', 'INVALID_APP_ACCESS');
  }
};

const assertAssignableRole = (actor, role) => {
  if (!ROLE_INFO[role] || FORBIDDEN_APP_ROLES.has(role) || !OPERATIONAL_APP_ROLES.has(role)) {
    throw serviceError(422, 'Select an eligible operational app-access role.', 'INVALID_APP_ROLE');
  }
  const actorRank = ROLE_INFO[actor?.role]?.rank ?? -1;
  const roleRank = ROLE_INFO[role]?.rank ?? Number.POSITIVE_INFINITY;
  if (roleRank >= actorRank) {
    throw serviceError(403, 'You may assign only operational roles below your own role.', 'APP_ROLE_FORBIDDEN');
  }
};

export const getAssignableEmployeeRoles = (actor) => Object.entries(ROLE_INFO)
  .filter(([role, info]) => OPERATIONAL_APP_ROLES.has(role)
    && !FORBIDDEN_APP_ROLES.has(role)
    && info.rank < (ROLE_INFO[actor?.role]?.rank ?? -1))
  .map(([value, info]) => ({ value, label: info.name }));

const assertBranchAccess = async (actor, branchId, session) => {
  if (!mongoose.isValidObjectId(branchId)) {
    throw serviceError(422, 'Employee branch is invalid.', 'INVALID_EMPLOYEE_BRANCH');
  }
  if (!hasGlobalBranchAccess(actor) && !getAssignedBranchIds(actor).includes(String(branchId))) {
    throw serviceError(403, 'You may assign employees only to your active assigned branches.', 'EMPLOYEE_BRANCH_FORBIDDEN');
  }
  const branch = await Branch.findOne({ _id: branchId, status: 'active' }).session(session).lean();
  if (!branch) throw serviceError(422, 'Employee branch must exist and be active.', 'INVALID_EMPLOYEE_BRANCH');
  return branch;
};

const assertCreateBranch = (requestedBranchId, selectedBranchId) => {
  if (requestedBranchId && idString(requestedBranchId) !== idString(selectedBranchId)) {
    throw serviceError(409, 'Create the employee in the currently selected branch.', 'BRANCH_CONTEXT_MISMATCH');
  }
};

const temporaryPassword = (appAccess) => appAccess?.temporaryPassword ?? appAccess?.password;

const validateTemporaryPassword = (password, required) => {
  if (!password && required) {
    throw serviceError(422, 'A strong temporary password is required for app access.', 'TEMPORARY_PASSWORD_REQUIRED');
  }
  const passwordError = password ? validateStrongPassword(password) : null;
  if (passwordError) {
    throw serviceError(422, passwordError, 'TEMPORARY_PASSWORD_INVALID');
  }
};

const assertLoginAvailable = async ({ email, username, userId, session }) => {
  const clauses = [];
  if (email) clauses.push({ email });
  if (username) clauses.push({ username });
  if (!clauses.length) return;
  const existing = await User.findOne({
    ...(userId ? { _id: { $ne: userId } } : {}),
    $or: clauses,
  }).session(session).select('_id email username').lean();
  if (!existing) return;
  if (email && existing.email === email) {
    throw serviceError(409, 'That app-access email is already in use.', 'EMAIL_CONFLICT');
  }
  throw serviceError(409, 'That app-access username is already in use.', 'USERNAME_CONFLICT');
};

const nextEmployeeCode = async (session) => {
  const last = await Employee.findOne().sort({ createdAt: -1 }).select('empId').session(session).lean();
  const number = last?.empId ? Number.parseInt(last.empId.replace(/\D/g, ''), 10) || 0 : 0;
  return `EMP${String(number + 1).padStart(4, '0')}`;
};

const syncUserBranch = async (user, branchId, session) => {
  const candidateWarehouseIds = [...new Set([
    ...(user.assignedWarehouses || []).map(idString),
    idString(user.assignedWarehouse),
  ].filter(Boolean))];
  const compatibleWarehouses = await Warehouse.find({
    _id: { $in: candidateWarehouseIds },
    branch: branchId,
    status: 'active',
  }).session(session).select('_id').lean();
  const warehouseIds = compatibleWarehouses.map((warehouse) => warehouse._id);

  user.assignedBranches = [branchId];
  user.defaultBranch = branchId;
  user.assignedWarehouses = warehouseIds;
  user.assignedWarehouse = warehouseIds[0] || undefined;
  if (!user.assignmentScopes) user.assignmentScopes = {};
  if (user.assignmentScopes.warehouses !== 'all') {
    user.assignmentScopes.warehouses = warehouseIds.length ? 'selected' : 'none';
  }
};

const clearRevokedAccessCredentials = (user) => {
  user.refreshSessions = [];
  user.fcmToken = undefined;
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpiresAt = undefined;
  user.failedLoginAttempts = 0;
  user.loginLockedUntil = undefined;
  user.mustChangePassword = true;
};

const applyAccessState = (user, employeeStatus, appAccess, { creating = false } = {}) => {
  const enabledWasProvided = hasOwn(appAccess, 'enabled');
  const password = temporaryPassword(appAccess);
  let shouldEnable;

  if (employeeStatus === 'Inactive' || employeeStatus === 'Terminated') shouldEnable = false;
  else if (enabledWasProvided) shouldEnable = appAccess.enabled === true;
  else shouldEnable = creating ? false : user.status === 'Active';

  const wasEnabled = user.status === 'Active';
  const shouldRevoke = (wasEnabled && !shouldEnable)
    || employeeStatus === 'Inactive'
    || employeeStatus === 'Terminated'
    || Boolean(password);

  user.status = shouldEnable ? 'Active' : 'Inactive';
  if (shouldRevoke) {
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    clearRevokedAccessCredentials(user);
  }
  if (password) {
    user.password = String(password);
    user.mustChangePassword = true;
  }
};

const createLinkedUser = async ({ employee, appAccess, actor, branchId, session }) => {
  const role = appAccess.role;
  assertAssignableRole(actor, role);
  const password = temporaryPassword(appAccess);
  validateTemporaryPassword(password, true);

  const username = normalizeLogin(appAccess.username);
  const email = normalizeLogin(appAccess.email || employee.email);
  const phone = normalizePhone(appAccess.phone || employee.mobile);
  if (!username || !email || !phone) {
    throw serviceError(422, 'Username, email, phone, and temporary password are required for app access.', 'APP_ACCESS_FIELDS_REQUIRED');
  }
  await assertLoginAvailable({ email, username, session });

  employee.email = email;
  employee.mobile = phone;
  const [user] = await User.create([{
    name: employee.name,
    username,
    email,
    phone,
    password: String(password),
    role,
    status: ['Inactive', 'Terminated'].includes(employee.status) ? 'Inactive' : 'Active',
    permissions: [...(ROLE_DEFAULT_PERMISSIONS[role] || [])],
    permissionMode: 'role_default',
    assignedBranches: [branchId],
    defaultBranch: branchId,
    assignedWarehouses: [],
    assignedWarehouse: undefined,
    assignmentScopes: {
      warehouses: 'none', regions: 'none', dealers: 'none', departments: 'none', reports: 'none', employees: 'none',
    },
    tokenVersion: 0,
    mustChangePassword: true,
    createdBy: actor._id,
  }], { session });
  return user;
};

const syncLinkedUser = async ({ employee, user, appAccess, actor, branchId, session }) => {
  const role = appAccess.role || user.role;
  const isForcedDeactivation = ['Inactive', 'Terminated'].includes(employee.status) || appAccess.enabled === false;
  if (!isForcedDeactivation || hasOwn(appAccess, 'role')) assertAssignableRole(actor, role);

  const username = hasOwn(appAccess, 'username') ? normalizeLogin(appAccess.username) : user.username;
  const email = normalizeLogin(hasOwn(appAccess, 'email') ? appAccess.email : employee.email);
  const phone = normalizePhone(hasOwn(appAccess, 'phone') ? appAccess.phone : employee.mobile);
  if (!username || !email || !phone) {
    throw serviceError(422, 'Linked app access requires a username, email, and phone.', 'APP_ACCESS_FIELDS_REQUIRED');
  }
  validateTemporaryPassword(temporaryPassword(appAccess), false);
  await assertLoginAvailable({ email, username, userId: user._id, session });

  employee.email = email;
  employee.mobile = phone;
  user.name = employee.name;
  user.username = username;
  user.email = email;
  user.phone = phone;
  user.role = role;
  user.permissionMode = 'role_default';
  user.permissions = [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
  await syncUserBranch(user, branchId, session);
  applyAccessState(user, employee.status, appAccess);
  await user.save({ session });
};

const serializeEmployee = async (employeeId, branchId) => {
  const employee = await Employee.findOne({ _id: employeeId, branchId })
    .populate('branchId', 'branchCode name status city state')
    .populate('userId', 'name username email phone role status mustChangePassword')
    .lean();
  if (!employee) return null;
  const linkedUser = employee.userId && typeof employee.userId === 'object' ? employee.userId : null;
  return {
    ...employee,
    userId: linkedUser?._id || employee.userId || null,
    appAccess: linkedUser ? {
      linked: true,
      enabled: linkedUser.status === 'Active',
      status: linkedUser.status,
      role: linkedUser.role,
      username: linkedUser.username,
      email: linkedUser.email,
      phone: linkedUser.phone,
      mustChangePassword: Boolean(linkedUser.mustChangePassword),
    } : { linked: false, enabled: false, status: 'Not provisioned' },
  };
};

export const listEmployeesWithAccess = async (filter, options) => {
  const query = Employee.find(filter)
    .sort({ createdAt: -1 })
    .skip(options.skip)
    .limit(options.limit)
    .populate('branchId', 'branchCode name status city state')
    .populate('userId', 'name username email phone role status mustChangePassword')
    .lean();
  const rows = await query;
  return rows.map((employee) => {
    const linkedUser = employee.userId && typeof employee.userId === 'object' ? employee.userId : null;
    return {
      ...employee,
      userId: linkedUser?._id || employee.userId || null,
      appAccess: linkedUser ? {
        linked: true,
        enabled: linkedUser.status === 'Active',
        status: linkedUser.status,
        role: linkedUser.role,
        username: linkedUser.username,
        email: linkedUser.email,
        phone: linkedUser.phone,
        mustChangePassword: Boolean(linkedUser.mustChangePassword),
      } : { linked: false, enabled: false, status: 'Not provisioned' },
    };
  });
};

export const getEmployeeWithAccess = serializeEmployee;

export const createEmployeeWithAccess = async ({ input, actor, selectedBranchId }) => {
  assertNoUserIdTampering(input);
  assertCreateBranch(input.branchId, selectedBranchId);
  const appAccess = input.appAccess || {};
  const employeeId = await runInTransaction(async (session) => {
    await assertBranchAccess(actor, selectedBranchId, session);
    const employeeData = pickEmployeeInput(input);
    if (employeeData.status === 'Terminated') {
      throw serviceError(422, 'Use the employee exit lifecycle after creating an employee.', 'EXIT_REQUIRED');
    }
    employeeData.branchId = selectedBranchId;
    employeeData.createdBy = actor._id;
    if (!employeeData.empId) employeeData.empId = await nextEmployeeCode(session);

    const wantsAccess = appAccess.enabled === true;
    if (wantsAccess) {
      employeeData.email = normalizeLogin(appAccess.email || employeeData.email);
      employeeData.mobile = normalizePhone(appAccess.phone || employeeData.mobile);
    }
    const employee = new Employee(employeeData);
    if (wantsAccess) {
      const user = await createLinkedUser({ employee, appAccess, actor, branchId: selectedBranchId, session });
      employee.userId = user._id;
    }
    await employee.save({ session });
    return employee._id;
  });
  return serializeEmployee(employeeId, selectedBranchId);
};

export const updateEmployeeWithAccess = async ({ employeeId, input, actor, selectedBranchId }) => {
  assertNoUserIdTampering(input);
  const appAccess = input.appAccess || {};
  const result = await runInTransaction(async (session) => {
    const employee = await Employee.findOne({ _id: employeeId, branchId: selectedBranchId }).session(session);
    if (!employee) throw serviceError(404, 'Employee not found in the selected branch.', 'EMPLOYEE_NOT_FOUND');

    if (hasOwn(input, 'branchId') && idString(input.branchId) !== idString(employee.branchId)) {
      throw serviceError(409, 'Employee branch cannot be changed through general editing.', 'EMPLOYEE_BRANCH_CHANGE_FORBIDDEN');
    }
    await assertBranchAccess(actor, employee.branchId, session);
    const updates = pickEmployeeInput(input);
    if (updates.status === 'Terminated' && employee.status !== 'Terminated') {
      throw serviceError(422, 'Use the dedicated exit action to terminate an employee.', 'EXIT_REQUIRED');
    }
    if (employee.status === 'Terminated' && updates.status && updates.status !== 'Terminated') {
      throw serviceError(409, 'Exited employees cannot be reactivated through general editing.', 'EMPLOYEE_ALREADY_EXITED');
    }
    Object.assign(employee, updates);

    let user = employee.userId
      ? await User.findById(employee.userId)
        .select('+refreshSessions +passwordResetTokenHash +passwordResetExpiresAt')
        .session(session)
      : null;
    if (employee.userId && !user) {
      throw serviceError(409, 'The employee link points to a missing user account. Repair the link before updating.', 'LINKED_USER_MISSING');
    }

    if (user) {
      await syncLinkedUser({ employee, user, appAccess, actor, branchId: employee.branchId, session });
    } else if (appAccess.enabled === true) {
      user = await createLinkedUser({ employee, appAccess, actor, branchId: employee.branchId, session });
      employee.userId = user._id;
    }

    await employee.save({ session });
    return { employeeId: employee._id, branchId: employee.branchId };
  });
  return serializeEmployee(result.employeeId, result.branchId);
};

export const exitEmployee = async ({ employeeId, input, actor, selectedBranchId }) => {
  assertNoUserIdTampering(input);
  const exitReason = String(input.exitReason || '').trim();
  const exitDate = input.exitDate ? new Date(input.exitDate) : null;
  if (!exitDate || Number.isNaN(exitDate.getTime()) || !exitReason) {
    throw serviceError(422, 'Exit date and exit reason are required.', 'EXIT_DETAILS_REQUIRED');
  }

  const result = await runInTransaction(async (session) => {
    const employee = await Employee.findOne({ _id: employeeId, branchId: selectedBranchId }).session(session);
    if (!employee) throw serviceError(404, 'Employee not found in the selected branch.', 'EMPLOYEE_NOT_FOUND');
    employee.status = 'Terminated';
    employee.exitDate = exitDate;
    employee.exitReason = exitReason;

    if (employee.userId) {
      const user = await User.findById(employee.userId)
        .select('+refreshSessions +passwordResetTokenHash +passwordResetExpiresAt')
        .session(session);
      if (user) {
        user.status = 'Inactive';
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        clearRevokedAccessCredentials(user);
        await user.save({ session });
      }
    }
    await employee.save({ session });
    return { employeeId: employee._id, branchId: employee.branchId };
  });
  return serializeEmployee(result.employeeId, result.branchId);
};

export const deactivateEmployee = async ({ employeeId, selectedBranchId }) => {
  const result = await runInTransaction(async (session) => {
    const employee = await Employee.findOne({ _id: employeeId, branchId: selectedBranchId }).session(session);
    if (!employee) throw serviceError(404, 'Employee not found in the selected branch.', 'EMPLOYEE_NOT_FOUND');
    if (employee.status !== 'Terminated') employee.status = 'Inactive';

    if (employee.userId) {
      const user = await User.findById(employee.userId)
        .select('+refreshSessions +passwordResetTokenHash +passwordResetExpiresAt')
        .session(session);
      if (user) {
        user.status = 'Inactive';
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        clearRevokedAccessCredentials(user);
        await user.save({ session });
      }
    }
    await employee.save({ session });
    return { employeeId: employee._id, branchId: employee.branchId };
  });
  return serializeEmployee(result.employeeId, result.branchId);
};

export const employeeServiceErrorResponse = (error) => ({
  status: error.status
    || (error.name === 'ValidationError' || error.name === 'CastError' ? 422 : 500),
  body: {
    success: false,
    message: error.message,
    ...(error.code && typeof error.code === 'string' ? { code: error.code } : {}),
  },
});
