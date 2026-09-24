import { verifyToken } from '../utils/jwt.js';
import Dealer from '../models/Dealer.js';
import DealerEmployee from '../models/DealerEmployee.js';
import { resolveDealerEmployeePermissions } from '../config/dealerPermissions.js';

/**
 * Dealer App authentication.
 *
 * Two kinds of principal can present a token here:
 *
 *   dealer_access           the dealer itself (the account owner)
 *   dealer_employee_access  an employee the dealer created
 *
 * Both resolve to the same `req.dealer` / `req.dealerId`, because every dealer-app
 * query is scoped to the dealer account. The difference is carried in
 * `req.dealerPrincipal`, which is what permission checks read:
 *
 *   { isOwner: true,  permissions: ['*'] }            the owner — everything
 *   { isOwner: false, permissions: [...] }            an employee — granted subset
 *
 * The dealer id always comes from the token, never from the request, so an
 * employee cannot reach another dealer's data by passing a different id.
 */

const tokenFromRequest = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.split(' ')[1];
  return null;
};

const unauthorized = (res, message) => res.status(401).json({ success: false, message });
const forbidden = (res, message, code) => res.status(403).json({ success: false, code, message });

const loadDealer = (dealerId) => Dealer.findById(dealerId)
  .populate('dealerType', 'name pricingTier')
  .populate('assignedSalesExecutive', 'name phone')
  .lean();

export const protectDealer = async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    if (!token) return unauthorized(res, 'Not authorized. Please sign in.');

    let decoded;
    try {
      decoded = verifyToken(token);
      const recognised = (decoded.type === 'dealer_access' && decoded.role === 'dealer')
        || (decoded.type === 'dealer_employee_access' && decoded.role === 'dealer_employee');
      if (!recognised || !decoded.dealerId) throw new Error('Wrong token type');
    } catch {
      return unauthorized(res, 'Invalid or expired session.');
    }

    const dealer = await loadDealer(decoded.dealerId);
    if (!dealer) return unauthorized(res, 'Dealer account not found.');
    if (dealer.status !== 'active') {
      return forbidden(res, 'Your dealer account is not active. Contact BDMTILES.', 'DEALER_INACTIVE');
    }
    if (!dealer.appAccess) {
      return forbidden(res, 'App access is not enabled for your account yet.', 'APP_ACCESS_DISABLED');
    }

    // ── The dealer itself ────────────────────────────────────────────────────
    if (decoded.type === 'dealer_access') {
      if (Number(decoded.tokenVersion || 0) !== Number(dealer.tokenVersion || 0)) {
        return unauthorized(res, 'Session expired. Please sign in again.');
      }
      req.dealer = dealer;
      req.dealerId = dealer._id;
      req.dealerEmployee = null;
      req.dealerPrincipal = {
        isOwner: true,
        isEmployee: false,
        employeeId: null,
        name: dealer.ownerName || dealer.businessName,
        role: 'owner',
        permissions: ['*'],
      };
      return next();
    }

    // ── A dealer employee ────────────────────────────────────────────────────
    // Gated on the dealer-level policy first. Only an explicit `false` disables
    // it: dealers created before this field existed have nothing stored, and a
    // truthy check would read that absence as "disabled".
    if (dealer.employeeAccessEnabled === false) {
      return forbidden(
        res,
        'Employee app logins are not enabled for this dealer account. Ask your dealer to contact BDMTILES.',
        'EMPLOYEE_ACCESS_DISABLED',
      );
    }

    const employee = await DealerEmployee.findOne({
      _id: decoded.dealerEmployeeId,
      dealer: dealer._id,
    }).lean();

    if (!employee) return unauthorized(res, 'Employee account not found.');
    if (employee.status !== 'active') {
      return forbidden(res, 'Your account has been deactivated by your dealer.', 'EMPLOYEE_INACTIVE');
    }
    if (!employee.loginEnabled) {
      return forbidden(res, 'App access has been turned off for your account.', 'EMPLOYEE_LOGIN_DISABLED');
    }
    if (Number(decoded.tokenVersion || 0) !== Number(employee.tokenVersion || 0)) {
      return unauthorized(res, 'Session expired. Please sign in again.');
    }

    req.dealer = dealer;
    req.dealerId = dealer._id;
    req.dealerEmployee = employee;
    req.dealerPrincipal = {
      isOwner: false,
      isEmployee: true,
      employeeId: employee._id,
      name: employee.name,
      role: employee.role,
      // Resolved live, so a dealer changing a permission takes effect on the
      // employee's next request rather than at their next login.
      permissions: resolveDealerEmployeePermissions(employee, dealer),
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * Owner-only guard.
 *
 * Some actions belong to the account holder alone — the dealer cannot delegate
 * them, and they are not in the permission catalog at all. Granting a
 * `team.access` employee the ability to reset another employee's login is fine;
 * letting them act as the dealer is not.
 */
export const protectDealerOwner = (req, res, next) => {
  if (!req.dealerPrincipal?.isOwner) {
    return forbidden(res, 'Only the dealer account owner can perform this action.', 'OWNER_ONLY');
  }
  return next();
};

export default protectDealer;
