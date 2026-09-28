import { Router } from 'express';
import mongoose from 'mongoose';
import DealerEmployee from '../models/DealerEmployee.js';
import { protectDealer } from '../middleware/dealerAuth.js';
import {
  requireDealerPermission,
  requireDealerOwner,
} from '../middleware/dealerPermission.js';
import {
  ALL_DEALER_PERMISSIONS,
  DEALER_FINANCE_PERMISSION_IDS,
  DEALER_RESERVED_PERMISSION_IDS,
  getDealerPermissionsConfig,
  resolveDealerEmployeePermissions,
} from '../config/dealerPermissions.js';
import {
  assertMobileAvailable,
  checkMobileAvailability,
  MOBILE_IN_USE_MESSAGE,
  MOBILE_OWNER_TYPE,
} from '../services/mobileIdentityService.js';
import { disconnectDealerEmployee } from '../services/socketService.js';

/**
 * Dealer App — Team (employee) management.
 *
 * Mounted at /api/v1/dealer-app/employees. Every route is scoped to
 * `req.dealerId`, which comes from the token, so a dealer employee can never see
 * or touch another dealer's staff.
 *
 * A dealer can only manage employees at all once BDMTILES has enabled
 * `employeeAccessEnabled` on the dealer account — see the guard below.
 */
const router = Router();
router.use(protectDealer);

const appError = (status, message, code) => Object.assign(new Error(message), { status, code });

const sendError = (res, error) => {
  const status = error.status
    || (error.code === 11000 ? 409 : error.name === 'CastError' ? 422 : 500);
  const message = error.code === 11000 && /mobileNormalized/.test(error.message || '')
    // Generic on purpose — see MOBILE_IN_USE_MESSAGE. Never name the holder.
    ? MOBILE_IN_USE_MESSAGE
    : error.code === 11000 && /employeeCode/.test(error.message || '')
      ? 'That employee code is already used on this dealer account.'
      : error.name === 'CastError' ? 'Invalid identifier.' : error.message;
  return res.status(status).json({ success: false, code: error.code, message });
};

/**
 * Gate the whole feature on the dealer-level policy.
 *
 * BDMTILES enables employee logins per dealer. Without it there is nothing to
 * manage, and letting the dealer build a team that cannot sign in would be worse
 * than refusing outright.
 */
const requireEmployeeAccessEnabled = (req, res, next) => {
  // Only an explicit `false` blocks — dealers created before this field existed
  // have nothing stored and must keep working. See models/Dealer.js.
  if (req.dealer?.employeeAccessEnabled === false) {
    return res.status(403).json({
      success: false,
      code: 'EMPLOYEE_ACCESS_DISABLED',
      message: 'Employee app access is not enabled for this dealer account yet. Contact your BDMTILES sales executive.',
    });
  }
  return next();
};

/**
 * Validate and normalise a permission list coming from the dealer.
 *
 * Three things are enforced here that the app cannot be trusted to enforce:
 *   1. Only ids from the catalog are accepted — an employee can never be handed
 *      a permission that does not exist, or a BDMTILES staff permission.
 *   2. `*` is refused outright. A wildcard would make the employee an owner.
 *   3. Sensitive finance ids are refused when BDMTILES has switched finance
 *      delegation off for this dealer.
 */
const sanitizePermissions = (role, permissionMode, permissions, dealer) => {
  // A role preset is resolved live at request time, so nothing is stored.
  if (permissionMode === 'role_default' && role !== 'custom') {
    return { permissionMode: 'role_default', permissions: [] };
  }

  const requested = [...new Set((Array.isArray(permissions) ? permissions : []).map(String))];

  if (requested.includes('*')) {
    throw appError(422, 'A wildcard permission cannot be granted to an employee.', 'WILDCARD_NOT_ALLOWED');
  }
  const unknown = requested.filter((permission) => !ALL_DEALER_PERMISSIONS.includes(permission));
  if (unknown.length) {
    throw appError(422, `Unknown permission: ${unknown.join(', ')}`, 'UNKNOWN_PERMISSION');
  }

  // A reserved permission has no feature behind it. Storing one would look like a
  // grant while doing nothing, so it is refused rather than silently kept.
  const reserved = requested.filter((permission) => DEALER_RESERVED_PERMISSION_IDS.includes(permission));
  if (reserved.length) {
    throw appError(
      422,
      `This permission is not available yet: ${reserved.join(', ')}.`,
      'PERMISSION_NOT_AVAILABLE',
    );
  }
  // Only FINANCE ids are refused, not every sensitive id: `targets.manage` and
  // `incentives.manage` are sensitive (they move money indirectly and are warned
  // about in the UI) but they are not finance data, so a finance policy switch
  // must not silently block them.
  const finance = requested.filter((permission) => DEALER_FINANCE_PERMISSION_IDS.includes(permission));
  if (finance.length && dealer.allowEmployeeFinanceAccess === false) {
    throw appError(
      403,
      'BDMTILES has disabled finance delegation for this dealer account, so ledger, outstanding and credit-limit access cannot be granted.',
      'FINANCE_DELEGATION_DISABLED',
    );
  }

  return { permissionMode: 'custom', permissions: requested };
};

/**
 * Shape returned to the app.
 *
 * The queries that feed this select `+pinHash` so `hasPin` is accurate — the
 * hash is excluded from the schema by default, and without the explicit include
 * every employee would report as having no PIN. The hash itself is never
 * serialised: it is read only to derive the boolean below, and this function
 * builds a fresh object rather than spreading the document.
 */
const employeePayload = (employee, dealer) => ({
  id: employee._id,
  employeeCode: employee.employeeCode || '',
  name: employee.name,
  mobile: employee.mobile,
  email: employee.email || '',
  designation: employee.designation || '',
  joiningDate: employee.joiningDate || null,
  status: employee.status,
  loginEnabled: Boolean(employee.loginEnabled),

  role: employee.role,
  permissionMode: employee.permissionMode,
  // Effective list (preset expanded, finance stripped when policy forbids it).
  permissions: resolveDealerEmployeePermissions(employee, dealer),
  // Raw stored list, so the editor can show exactly what was ticked.
  selectedPermissions: employee.permissions || [],

  assignedArea: employee.assignedArea || '',
  assignedRegion: employee.assignedRegion || null,
  assignedRoute: employee.assignedRoute || null,

  hasPin: Boolean(employee.pinHash),
  biometricEnabled: Boolean(employee.biometricEnabled),
  lastLoginAt: employee.appLastLoginAt || null,
  accessResetAt: employee.accessResetAt || null,
  createdAt: employee.createdAt,
});

/** Fields a dealer may set on create/update, picked explicitly (never spread). */
const pickWritable = (body) => {
  const data = {};
  const assign = (key, transform = (value) => value) => {
    if (Object.prototype.hasOwnProperty.call(body, key)) data[key] = transform(body[key]);
  };
  assign('name', (value) => String(value || '').trim());
  assign('mobile', (value) => String(value || '').trim());
  assign('email', (value) => String(value || '').trim().toLowerCase());
  assign('designation', (value) => String(value || '').trim());
  assign('employeeCode', (value) => String(value || '').trim());
  assign('assignedArea', (value) => String(value || '').trim());
  assign('notes', (value) => String(value || '').trim());
  assign('joiningDate', (value) => (value ? new Date(value) : null));
  assign('status', (value) => (value === 'inactive' ? 'inactive' : 'active'));
  assign('loginEnabled', (value) => Boolean(value));
  return data;
};

const assertValidObjectId = (value, label) => {
  if (value && !mongoose.isValidObjectId(value)) throw appError(422, `Invalid ${label}.`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-app/employees/permissions
// The permission catalog + role presets the editor renders, plus whether the
// dealer is allowed to delegate finance at all.
router.get('/permissions', requireDealerPermission('team.view'), (req, res) => {
  res.json({ success: true, data: getDealerPermissionsConfig(req.dealer) });
});

// GET /api/v1/dealer-app/employees/mobile-availability?mobile=...&excludeId=...
// Lets the form warn that a number is already used before the dealer submits.
// Declared before '/:id' so "mobile-availability" is not read as an id.
router.get('/mobile-availability', requireDealerPermission('team.view'), async (req, res) => {
  try {
    const excludeId = mongoose.isValidObjectId(req.query.excludeId) ? req.query.excludeId : null;
    const result = await checkMobileAvailability(req.query.mobile, {
      exclude: excludeId ? { type: MOBILE_OWNER_TYPE.DEALER_EMPLOYEE, id: excludeId } : null,
    });
    // The dealer's own number is never available to an employee, and the guard
    // already reports it as taken by "dealer X" — surface that plainly.
    return res.json({ success: true, data: result });
  } catch (error) { return sendError(res, error); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/dealer-app/employees
router.get('/', requireDealerPermission('team.view'), async (req, res) => {
  try {
    const filter = { dealer: req.dealerId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      const regex = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: regex }, { mobile: regex }, { employeeCode: regex }, { designation: regex }];
    }

    const employees = await DealerEmployee.find(filter)
      .select('+pinHash')
      .sort({ createdAt: -1 })
      .lean();

    const active = employees.filter((employee) => employee.status === 'active').length;
    return res.json({
      success: true,
      data: employees.map((employee) => employeePayload(employee, req.dealer)),
      summary: {
        total: employees.length,
        active,
        inactive: employees.length - active,
        withLogin: employees.filter((employee) => employee.loginEnabled).length,
      },
    });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/dealer-app/employees
router.post('/', requireEmployeeAccessEnabled, requireDealerPermission('team.create'), async (req, res) => {
  try {
    const data = pickWritable(req.body);

    if (!data.name) throw appError(422, 'Employee name is required.');
    if (!data.mobile) throw appError(422, 'Mobile number is required.');
    if (data.joiningDate && Number.isNaN(data.joiningDate.getTime())) {
      throw appError(422, 'Joining date is not a valid date.');
    }

    // Global uniqueness — across dealers, dealer employees, staff and HRMS.
    // This is the guard that keeps the app login unambiguous.
    data.mobileNormalized = await assertMobileAvailable(data.mobile, {
      exclude: null,
      field: 'mobile',
    });

    if (req.body?.role) {
      const role = String(req.body.role);
      if (!['manager', 'salesperson', 'accountant', 'viewer', 'custom'].includes(role)) {
        throw appError(422, 'Select a valid role.');
      }
      data.role = role;
    }

    const { permissionMode, permissions } = sanitizePermissions(
      data.role || 'salesperson',
      req.body?.permissionMode || 'role_default',
      req.body?.permissions,
      req.dealer,
    );
    data.permissionMode = permissionMode;
    data.permissions = permissions;

    assertValidObjectId(req.body?.assignedRegion, 'region');
    assertValidObjectId(req.body?.assignedRoute, 'route');
    if (req.body?.assignedRegion) data.assignedRegion = req.body.assignedRegion;
    if (req.body?.assignedRoute) data.assignedRoute = req.body.assignedRoute;
    if (Array.isArray(req.body?.assignedCustomers)) {
      data.assignedCustomers = req.body.assignedCustomers.filter((id) => mongoose.isValidObjectId(id));
    }

    if (!data.employeeCode) {
      data.employeeCode = await DealerEmployee.generateEmployeeCode(req.dealerId);
    }

    // A new employee never gets a login until the dealer explicitly enables it,
    // so creating a record cannot accidentally hand out app access.
    data.loginEnabled = false;
    data.createdBy = req.dealerId;

    const created = await DealerEmployee.create({ ...data, dealer: req.dealerId });
    const full = await DealerEmployee.findById(created._id).select('+pinHash').lean();
    return res.status(201).json({
      success: true,
      message: `${full.name} added to your team.`,
      data: employeePayload(full, req.dealer),
    });
  } catch (error) {
    if (error.code === 11000 && /mobileNormalized/.test(error.message || '')) {
      // A race between the guard above and the unique index. Same generic message.
      console.warn(`[mobile-identity] create raced the unique index on ${error.message}`);
      return res.status(409).json({
        success: false,
        code: 'MOBILE_ALREADY_IN_USE',
        message: MOBILE_IN_USE_MESSAGE,
      });
    }
    return sendError(res, error);
  }
});

// GET /api/v1/dealer-app/employees/:id
router.get('/:id', requireDealerPermission('team.view'), async (req, res) => {
  try {
    const employee = await DealerEmployee.findOne({ _id: req.params.id, dealer: req.dealerId })
      .select('+pinHash')
      .lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    return res.json({ success: true, data: employeePayload(employee, req.dealer) });
  } catch (error) { return sendError(res, error); }
});

// PUT /api/v1/dealer-app/employees/:id
router.put('/:id', requireEmployeeAccessEnabled, requireDealerPermission('team.edit'), async (req, res) => {
  try {
    const existing = await DealerEmployee.findOne({ _id: req.params.id, dealer: req.dealerId }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const data = pickWritable(req.body);
    if (Object.prototype.hasOwnProperty.call(data, 'name') && !data.name) {
      throw appError(422, 'Employee name cannot be empty.');
    }
    if (data.joiningDate && Number.isNaN(data.joiningDate.getTime())) {
      throw appError(422, 'Joining date is not a valid date.');
    }

    // Re-check uniqueness only when the number actually changed, and excluding
    // this employee so saving an unchanged form does not self-conflict.
    if (Object.prototype.hasOwnProperty.call(data, 'mobile')) {
      data.mobileNormalized = await assertMobileAvailable(data.mobile, {
        exclude: { type: MOBILE_OWNER_TYPE.DEALER_EMPLOYEE, id: existing._id },
        field: 'mobile',
      });
    }

    if (req.body?.role) {
      const role = String(req.body.role);
      if (!['manager', 'salesperson', 'accountant', 'viewer', 'custom'].includes(role)) {
        throw appError(422, 'Select a valid role.');
      }
      data.role = role;
    }

    const nextRole = data.role || existing.role;
    const body = req.body || {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

    // An explicit permissionMode wins. Otherwise, changing the role implies that
    // role's preset (for a preset role) or an explicit list (`custom`); leaving
    // both untouched keeps whatever the employee already had.
    const nextMode = has('permissionMode')
      ? body.permissionMode
      : has('role')
        ? (nextRole === 'custom' ? 'custom' : 'role_default')
        : existing.permissionMode;

    if (has('permissions') || has('permissionMode') || has('role')) {
      const { permissionMode, permissions } = sanitizePermissions(
        nextRole,
        nextMode,
        has('permissions') ? body.permissions : existing.permissions,
        req.dealer,
      );
      data.permissionMode = permissionMode;
      data.permissions = permissions;
    }

    assertValidObjectId(body.assignedRegion, 'region');
    assertValidObjectId(body.assignedRoute, 'route');
    if (has('assignedRegion')) data.assignedRegion = body.assignedRegion || null;
    if (has('assignedRoute')) data.assignedRoute = body.assignedRoute || null;
    if (Array.isArray(body.assignedCustomers)) {
      data.assignedCustomers = body.assignedCustomers.filter((id) => mongoose.isValidObjectId(id));
    }

    // Toggling login is an access change, not an edit — route it through the
    // access permission so `team.edit` alone cannot grant app sign-in.
    if (Object.prototype.hasOwnProperty.call(data, 'loginEnabled')
      && data.loginEnabled !== Boolean(existing.loginEnabled)) {
      if (!req.dealerPrincipal?.isOwner) {
        const canManageAccess = (req.dealerPrincipal?.permissions || []).includes('team.access');
        if (!canManageAccess) {
          return res.status(403).json({
            success: false,
            code: 'DEALER_PERMISSION_DENIED',
            message: 'Your dealer has not given you access to manage logins. Ask your dealer to change this.',
          });
        }
      }
    }

    const updated = await DealerEmployee.findOneAndUpdate(
      { _id: req.params.id, dealer: req.dealerId },
      data,
      { new: true, runValidators: true },
    ).select('+pinHash').lean();

    return res.json({ success: true, message: 'Employee updated.', data: employeePayload(updated, req.dealer) });
  } catch (error) {
    if (error.code === 11000 && /mobileNormalized/.test(error.message || '')) {
      console.warn(`[mobile-identity] update raced the unique index on ${error.message}`);
      return res.status(409).json({
        success: false,
        code: 'MOBILE_ALREADY_IN_USE',
        message: MOBILE_IN_USE_MESSAGE,
      });
    }
    return sendError(res, error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Access control
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /api/v1/dealer-app/employees/:id/access  { loginEnabled }
// Turn the employee's ability to sign in on or off without touching their record.
router.patch('/:id/access', requireEmployeeAccessEnabled, requireDealerPermission('team.access'), async (req, res) => {
  try {
    const loginEnabled = Boolean(req.body?.loginEnabled);
    const employee = await DealerEmployee.findOneAndUpdate(
      { _id: req.params.id, dealer: req.dealerId },
      {
        $set: { loginEnabled },
        // Disabling access also drops any active session immediately, rather
        // than waiting up to 30 days for the token to expire.
        ...(loginEnabled ? {} : { $inc: { tokenVersion: 1 } }),
      },
      { new: true },
    ).select('+pinHash').lean();

    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    // Access just ended, so drop their live sockets now rather than waiting for
    // the revalidation sweep — otherwise a revoked employee keeps receiving the
    // dealer's chat on an already-open connection.
    if (!loginEnabled) await disconnectDealerEmployee(req.dealerId, employee._id);
    return res.json({
      success: true,
      message: loginEnabled ? `App access enabled for ${employee.name}.` : `App access disabled for ${employee.name}.`,
      data: employeePayload(employee, req.dealer),
    });
  } catch (error) { return sendError(res, error); }
});

// PATCH /api/v1/dealer-app/employees/:id/status  { status }
router.patch('/:id/status', requireDealerPermission('team.access'), async (req, res) => {
  try {
    const status = req.body?.status === 'inactive' ? 'inactive' : 'active';
    const employee = await DealerEmployee.findOneAndUpdate(
      { _id: req.params.id, dealer: req.dealerId },
      {
        $set: {
          status,
          // Deactivating also revokes app access, so a deactivated employee
          // cannot keep ordering from a device they are already signed in on.
          ...(status === 'inactive' ? { loginEnabled: false } : {}),
        },
        ...(status === 'inactive' ? { $inc: { tokenVersion: 1 } } : {}),
      },
      { new: true },
    ).select('+pinHash').lean();

    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    if (status === 'inactive') await disconnectDealerEmployee(req.dealerId, employee._id);
    return res.json({
      success: true,
      message: status === 'active' ? `${employee.name} is now active.` : `${employee.name} is now inactive.`,
      data: employeePayload(employee, req.dealer),
    });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/dealer-app/employees/:id/reset-access
//
// Clears the employee's PIN, drops their registered devices and bumps
// tokenVersion, so any device they are signed in on is signed out and they must
// set a new PIN. This is the "Reset / Manage Access" action.
router.post('/:id/reset-access', requireEmployeeAccessEnabled, requireDealerPermission('team.access'), async (req, res) => {
  try {
    const employee = await DealerEmployee.findOneAndUpdate(
      { _id: req.params.id, dealer: req.dealerId },
      {
        $set: {
          pinHash: null,
          biometricEnabled: false,
          appDevices: [],
          accessResetAt: new Date(),
          accessResetBy: req.dealerId,
        },
        $inc: { tokenVersion: 1 },
      },
      { new: true },
    ).select('+pinHash').lean();

    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    // A reset bumps tokenVersion, so every live socket is already invalid — drop
    // them rather than leaving them connected until the sweep notices.
    await disconnectDealerEmployee(req.dealerId, employee._id);
    return res.json({
      success: true,
      message: `Access reset for ${employee.name}. They will need to sign in again and set a new PIN.`,
      data: employeePayload(employee, req.dealer),
    });
  } catch (error) { return sendError(res, error); }
});

// DELETE /api/v1/dealer-app/employees/:id
//
// Owner-only: removing an app user entirely is an account-holder decision.
// Everyone else should deactivate instead, which keeps the audit trail.
router.delete('/:id', requireDealerOwner, async (req, res) => {
  try {
    const employee = await DealerEmployee.findOne({ _id: req.params.id, dealer: req.dealerId }).lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });

    await DealerEmployee.deleteOne({ _id: employee._id });
    await disconnectDealerEmployee(req.dealerId, employee._id);
    return res.json({ success: true, message: `${employee.name} removed from your team.` });
  } catch (error) { return sendError(res, error); }
});

export default router;
