import {
  dealerPrincipalHasAnyPermission,
  dealerPrincipalHasPermission,
} from '../config/dealerPermissions.js';

/**
 * Permission gates for the Dealer App.
 *
 * These read `req.dealerPrincipal`, which middleware/dealerAuth.js sets. The
 * dealer account owner always passes; an employee passes only when the dealer
 * granted the permission (directly or through a role preset).
 *
 * The denial message is written for an employee to act on — "ask your dealer" —
 * because the person who sees it is not the person who can fix it.
 */

const deny = (res, permissions) => res.status(403).json({
  success: false,
  code: 'DEALER_PERMISSION_DENIED',
  message: permissions.length > 1
    ? 'Your dealer has not given you access to this. Ask your dealer to grant it from Team settings.'
    : 'Your dealer has not given you access to this. Ask your dealer to grant it from Team settings.',
  requiredPermissions: permissions,
});

/** Require one permission. */
export const requireDealerPermission = (permission) => (req, res, next) => {
  if (!dealerPrincipalHasPermission(req.dealerPrincipal, permission)) {
    return deny(res, [permission]);
  }
  return next();
};

/** Require any one of several permissions. */
export const requireAnyDealerPermission = (...permissions) => (req, res, next) => {
  if (!dealerPrincipalHasAnyPermission(req.dealerPrincipal, permissions)) {
    return deny(res, permissions);
  }
  return next();
};

/**
 * Require the account owner.
 *
 * Used for endpoints an employee must never reach even with a broad grant —
 * managing other employees' access being the main one.
 */
export const requireDealerOwner = (req, res, next) => {
  if (!req.dealerPrincipal?.isOwner) {
    return res.status(403).json({
      success: false,
      code: 'OWNER_ONLY',
      message: 'Only the dealer account owner can do this.',
    });
  }
  return next();
};

export default requireDealerPermission;
