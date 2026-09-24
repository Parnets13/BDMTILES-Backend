import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import Dealer, { normalizeDealerMobile } from '../models/Dealer.js';
import DealerEmployee from '../models/DealerEmployee.js';
import OtpChallenge from '../models/OtpChallenge.js';
import { generateDealerToken, generateDealerEmployeeToken } from '../utils/jwt.js';
import { protectDealer } from '../middleware/dealerAuth.js';
import {
  resolveDealerEmployeePermissions,
} from '../config/dealerPermissions.js';

const router = Router();

const numberFromEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const otpRequestLimiter = rateLimit({
  windowMs: numberFromEnv('DEALER_OTP_REQUEST_WINDOW_MINUTES', 15) * 60 * 1000,
  limit: numberFromEnv('DEALER_OTP_REQUEST_MAX', 12),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many OTP requests. Try again later.' }),
});

const otpVerifyLimiter = rateLimit({
  windowMs: numberFromEnv('DEALER_OTP_VERIFY_WINDOW_MINUTES', 15) * 60 * 1000,
  limit: numberFromEnv('DEALER_OTP_VERIFY_MAX', 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many attempts. Try again later.' }),
});

const OTP_SENT_RESPONSE = 'OTP sent to your mobile number.';
const sixDigitOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const hashOtp = (code, dealerId) => crypto
  .createHash('sha256')
  .update(`${code}:${dealerId}:${process.env.JWT_SECRET || 'otp'}`)
  .digest('hex');
// Until DLT/SMS is provisioned, echo the OTP to the client. Flip to 'false' once SMS is live.
const exposeOtpCode = () => String(process.env.OTP_EXPOSE_CODE ?? 'true').toLowerCase() !== 'false';

/**
 * Resolve a mobile number to the single principal that owns it.
 *
 * The dealer owner is checked first: their number is the account's own number.
 * An employee is only consulted when no dealer owns the number. This ordering
 * matters because the mobile-identity guard keeps the two sets disjoint — if a
 * number somehow exists in both, the dealer wins, which is the safer failure.
 *
 * @returns {Promise<null | {dealer: object, employee: object|null}>}
 */
const resolveLoginPrincipal = async (normalized) => {
  const dealer = await Dealer.findOne({ mobileNormalized: normalized });
  if (dealer) return { dealer, employee: null };

  const employee = await DealerEmployee.findOne({ mobileNormalized: normalized }).populate('dealer');
  if (employee?.dealer) return { dealer: employee.dealer, employee };

  return null;
};

/**
 * Why this principal may not sign in, or null when they may.
 *
 * Returned as data rather than thrown so the caller can pick the status code and
 * the message the app shows.
 */
const principalLoginBlock = (dealer, employee) => {
  if (dealer.status !== 'active') {
    return {
      code: 'DEALER_INACTIVE',
      message: 'Your dealer account is inactive. Contact your BDMTILES sales executive.',
    };
  }
  if (!dealer.appAccess) {
    return {
      code: 'APP_ACCESS_DISABLED',
      message: 'Your dealer account does not have app access yet. Contact your BDMTILES sales executive to enable it.',
    };
  }
  if (!employee) return null;

  // Only an explicit `false` disables employee logins — see models/Dealer.js.
  if (dealer.employeeAccessEnabled === false) {
    return {
      code: 'EMPLOYEE_ACCESS_DISABLED',
      message: 'Employee app logins are not enabled for this dealer account. Ask your dealer to contact BDMTILES.',
    };
  }
  if (employee.status !== 'active') {
    return {
      code: 'EMPLOYEE_INACTIVE',
      message: 'Your account has been deactivated by your dealer.',
    };
  }
  if (!employee.loginEnabled) {
    return {
      code: 'EMPLOYEE_LOGIN_DISABLED',
      message: 'App access has been turned off for your account. Ask your dealer to enable it.',
    };
  }
  return null;
};

/**
 * The profile the app stores after login.
 *
 * For an employee, finance fields are redacted unless the dealer granted the
 * matching permission. Redacting at the source — rather than hiding the values in
 * the UI — is what actually enforces "a dealer employee must not automatically
 * receive credit limit, outstanding or ledger information".
 */
const dealerProfile = (dealer, employee = null) => {
  const permissions = employee ? resolveDealerEmployeePermissions(employee, dealer) : ['*'];
  const canSee = (permission) => !employee || permissions.includes(permission) || permissions.includes('*');

  const profile = {
    id: dealer._id,
    dealerCode: dealer.dealerCode,
    businessName: dealer.businessName,
    ownerName: dealer.ownerName,
    mobile: dealer.mobile,
    email: dealer.email,
    dealerType: dealer.dealerType?.name || null,
    pricingTier: dealer.dealerType?.pricingTier || 'dealerRate',
    city: dealer.city,
    state: dealer.state,
    biometricEnabled: Boolean(employee ? employee.biometricEnabled : dealer.biometricEnabled),
    hasPin: Boolean(employee ? employee.pinHash : dealer.pinHash),
    assignedSalesExecutive: dealer.assignedSalesExecutive
      ? { name: dealer.assignedSalesExecutive.name, phone: dealer.assignedSalesExecutive.phone }
      : null,

    // ── Principal ────────────────────────────────────────────────────────────
    // Who is signed in, and what they may do. The app drives its whole UI from
    // this, so an employee never sees a tab that would only 403.
    isOwner: !employee,
    permissions,
    employee: employee
      ? {
        id: employee._id,
        name: employee.name,
        employeeCode: employee.employeeCode,
        designation: employee.designation,
        role: employee.role,
        assignedArea: employee.assignedArea || '',
      }
      : null,
  };

  // ── Finance, redacted per permission ───────────────────────────────────────
  if (canSee('finance.creditLimit')) {
    profile.creditLimit = dealer.creditLimit;
    profile.creditDays = dealer.creditDays;
  } else {
    profile.creditLimit = null;
    profile.creditDays = null;
    profile.creditLimitHidden = true;
  }

  if (canSee('finance.outstanding')) {
    profile.currentOutstanding = dealer.currentOutstanding;
  } else {
    profile.currentOutstanding = null;
    profile.currentOutstandingHidden = true;
  }

  return profile;
};

/**
 * SOW 17.1 "Device registration" — upsert the calling device onto whichever
 * principal signed in. The client supplies a stable deviceId; without one we
 * simply skip registration rather than inventing duplicate rows on every login.
 */
const registerDevice = (doc, device) => {
  const deviceId = String(device?.deviceId || '').trim().slice(0, 200);
  if (!deviceId) return;
  const now = new Date();
  const existing = (doc.appDevices || []).find(d => d.deviceId === deviceId);
  if (existing) {
    existing.lastSeenAt = now;
    if (device.deviceName) existing.deviceName = String(device.deviceName).slice(0, 120);
    if (device.platform) existing.platform = String(device.platform).slice(0, 40);
    if (device.osVersion) existing.osVersion = String(device.osVersion).slice(0, 40);
    if (device.appVersion) existing.appVersion = String(device.appVersion).slice(0, 40);
    return;
  }
  doc.appDevices = [
    ...(doc.appDevices || []),
    {
      deviceId,
      deviceName: String(device.deviceName || '').slice(0, 120),
      platform: String(device.platform || '').slice(0, 40),
      osVersion: String(device.osVersion || '').slice(0, 40),
      appVersion: String(device.appVersion || '').slice(0, 40),
      firstSeenAt: now,
      lastSeenAt: now,
    },
  // Keep the list bounded; drop the least recently seen beyond 10.
  ].sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt)).slice(0, 10);
};

const loginResponse = async (res, dealerDoc, employeeDoc, message, device = null) => {
  const now = new Date();

  if (employeeDoc) {
    employeeDoc.appLastLoginAt = now;
    if (device) registerDevice(employeeDoc, device);
    await employeeDoc.save({ validateBeforeSave: false });
  } else {
    dealerDoc.appLastLoginAt = now;
    if (device) registerDevice(dealerDoc, device);
    await dealerDoc.save({ validateBeforeSave: false });
  }

  const full = await Dealer.findById(dealerDoc._id)
    .populate('dealerType', 'name pricingTier')
    .populate('assignedSalesExecutive', 'name phone')
    .lean();

  const token = employeeDoc
    ? generateDealerEmployeeToken(employeeDoc._id, dealerDoc._id, employeeDoc.tokenVersion || 0)
    : generateDealerToken(dealerDoc._id, dealerDoc.tokenVersion || 0);

  return res.json({
    success: true,
    message,
    token,
    dealer: dealerProfile(full, employeeDoc),
  });
};

const notRegistered = (res) => res.status(404).json({
  success: false,
  code: 'DEALER_NOT_FOUND',
  message: 'This mobile number is not registered. Contact your BDMTILES sales executive.',
});

// POST /api/v1/dealer-app/auth/otp/request  { mobile }
//
// Tells the caller plainly whether the number is not registered at all, or is a
// real account without app access, rather than the previous anti-enumeration
// response that silently "succeeded" either way. Mobile numbers are onboarded by
// staff (not self-registered secrets), so the enumeration risk is low, and a
// clear message here avoids someone waiting forever for an OTP that was never
// going to arrive.
router.post('/otp/request', otpRequestLimiter, async (req, res) => {
  try {
    const normalized = normalizeDealerMobile(req.body?.mobile);
    if (normalized.length < 10) {
      return res.status(422).json({ success: false, code: 'INVALID_MOBILE', message: 'Enter a valid 10-digit mobile number.' });
    }

    const principal = await resolveLoginPrincipal(normalized);
    if (!principal) return notRegistered(res);

    const blocked = principalLoginBlock(principal.dealer, principal.employee);
    if (blocked) return res.status(403).json({ success: false, ...blocked });

    const code = sixDigitOtp();
    await OtpChallenge.create({
      phone: normalized,
      dealer: principal.dealer._id,
      codeHash: hashOtp(code, principal.dealer._id),
      purpose: 'dealer_login',
      expiresAt: new Date(Date.now() + numberFromEnv('OTP_EXPIRE_MINUTES', 5) * 60 * 1000),
      ip: req.ip || '',
      userAgent: String(req.get('user-agent') || '').slice(0, 500),
    });
    // TODO: send via DLT SMS provider.
    const payload = { success: true, code: 'OTP_SENT', message: OTP_SENT_RESPONSE };
    if (exposeOtpCode()) payload.devOtp = code;
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not send OTP. Please try again.' });
  }
});

// POST /api/v1/dealer-app/auth/otp/verify  { mobile, otp }
router.post('/otp/verify', otpVerifyLimiter, async (req, res) => {
  try {
    const normalized = normalizeDealerMobile(req.body?.mobile);
    const code = String(req.body?.otp || req.body?.code || '').trim();
    if (normalized.length < 10 || !/^\d{4,8}$/.test(code)) {
      return res.status(422).json({ success: false, message: 'Enter the OTP sent to your mobile.' });
    }
    const challenge = await OtpChallenge.findOne({
      phone: normalized,
      purpose: 'dealer_login',
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!challenge) {
      return res.status(401).json({ success: false, message: 'OTP is invalid or has expired. Request a new one.' });
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      await OtpChallenge.deleteOne({ _id: challenge._id });
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Request a new OTP.' });
    }
    if (hashOtp(code, challenge.dealer) !== challenge.codeHash) {
      challenge.attempts += 1;
      await challenge.save({ validateBeforeSave: false });
      return res.status(401).json({ success: false, message: 'Incorrect OTP.' });
    }

    // Re-resolve rather than trusting the challenge: the account may have been
    // deactivated, or the employee's access revoked, while the OTP was in flight.
    const principal = await resolveLoginPrincipal(normalized);
    if (!principal) {
      await OtpChallenge.deleteOne({ _id: challenge._id });
      return notRegistered(res);
    }
    const blocked = principalLoginBlock(principal.dealer, principal.employee);
    if (blocked) {
      await OtpChallenge.deleteOne({ _id: challenge._id });
      return res.status(403).json({ success: false, ...blocked });
    }

    challenge.consumedAt = new Date();
    await challenge.save({ validateBeforeSave: false });
    await OtpChallenge.deleteMany({ dealer: principal.dealer._id, consumedAt: null });

    return loginResponse(res, principal.dealer, principal.employee, 'Login successful', req.body?.device);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

// POST /api/v1/dealer-app/auth/pin/set  { pin }   (requires an authenticated principal)
router.post('/pin/set', protectDealer, async (req, res) => {
  try {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(422).json({ success: false, message: 'PIN must be 4 to 6 digits.' });
    }
    const hash = await bcrypt.hash(pin, 10);
    const biometricEnabled = typeof req.body?.biometricEnabled === 'boolean' ? req.body.biometricEnabled : undefined;

    // The PIN belongs to whoever is signed in, so an employee setting a PIN never
    // touches the dealer owner's PIN.
    if (req.dealerEmployee) {
      await DealerEmployee.updateOne(
        { _id: req.dealerEmployee._id },
        { $set: { pinHash: hash, ...(biometricEnabled === undefined ? {} : { biometricEnabled }) } },
      );
    } else {
      await Dealer.updateOne(
        { _id: req.dealerId },
        { $set: { pinHash: hash, ...(biometricEnabled === undefined ? {} : { biometricEnabled }) } },
      );
    }
    return res.json({ success: true, message: 'PIN set successfully.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not set PIN.' });
  }
});

// POST /api/v1/dealer-app/auth/pin/login  { mobile, pin }
router.post('/pin/login', otpVerifyLimiter, async (req, res) => {
  try {
    const normalized = normalizeDealerMobile(req.body?.mobile);
    const pin = String(req.body?.pin || '').trim();
    if (normalized.length < 10 || !/^\d{4,6}$/.test(pin)) {
      return res.status(422).json({ success: false, message: 'Enter your mobile and PIN.' });
    }

    const principal = await resolveLoginPrincipal(normalized);
    if (!principal) return notRegistered(res);

    const blocked = principalLoginBlock(principal.dealer, principal.employee);
    if (blocked) return res.status(403).json({ success: false, ...blocked });

    // pinHash is `select: false`, so it has to be pulled explicitly.
    const stored = principal.employee
      ? await DealerEmployee.findById(principal.employee._id).select('+pinHash').lean()
      : await Dealer.findById(principal.dealer._id).select('+pinHash').lean();

    if (!stored?.pinHash || !(await bcrypt.compare(pin, stored.pinHash))) {
      return res.status(401).json({ success: false, code: 'INCORRECT_PIN', message: 'Incorrect PIN.' });
    }

    return loginResponse(res, principal.dealer, principal.employee, 'Login successful', req.body?.device);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

// GET /api/v1/dealer-app/auth/me
router.get('/me', protectDealer, (req, res) => {
  // Re-read the employee so `hasPin` reflects the stored hash rather than the
  // lean copy the middleware loaded (which excludes it).
  if (req.dealerEmployee) {
    return DealerEmployee.findById(req.dealerEmployee._id)
      .select('+pinHash')
      .lean()
      .then((employee) => res.json({ success: true, dealer: dealerProfile(req.dealer, employee) }))
      .catch(() => res.status(500).json({ success: false, message: 'Could not load your profile.' }));
  }
  return res.json({ success: true, dealer: dealerProfile(req.dealer) });
});

// POST /api/v1/dealer-app/auth/logout  (logout from all devices by bumping tokenVersion)
router.post('/logout', protectDealer, async (req, res) => {
  try {
    if (req.body?.allDevices) {
      // Bumping tokenVersion invalidates every issued token, so also clear the
      // registered device list — nothing is signed in any more. An employee's
      // bump is scoped to that employee, so it does not sign the dealer out.
      if (req.dealerEmployee) {
        await DealerEmployee.updateOne(
          { _id: req.dealerEmployee._id },
          { $inc: { tokenVersion: 1 }, $set: { appDevices: [] } },
        );
      } else {
        await Dealer.updateOne(
          { _id: req.dealerId },
          { $inc: { tokenVersion: 1 }, $set: { appDevices: [] } },
        );
      }
    }
    return res.json({ success: true, message: 'Logged out.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Logout failed.' });
  }
});

// GET /api/v1/dealer-app/auth/devices — registered devices (SOW 17.1)
router.get('/devices', protectDealer, async (req, res) => {
  try {
    const source = req.dealerEmployee
      ? await DealerEmployee.findById(req.dealerEmployee._id).select('appDevices').lean()
      : await Dealer.findById(req.dealerId).select('appDevices').lean();
    const devices = [...(source?.appDevices || [])]
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
    return res.json({ success: true, data: devices });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load your devices.' });
  }
});

// DELETE /api/v1/dealer-app/auth/devices/:deviceId — remove one device entry.
// Note: this de-registers the device. Because tokens are validated by
// tokenVersion (not per device), fully signing a single device out requires
// "log out from all devices"; that limitation is surfaced in the app.
router.delete('/devices/:deviceId', protectDealer, async (req, res) => {
  try {
    const deviceId = String(req.params.deviceId || '');
    const filter = req.dealerEmployee ? { _id: req.dealerEmployee._id } : { _id: req.dealerId };
    const Model = req.dealerEmployee ? DealerEmployee : Dealer;
    await Model.updateOne(filter, { $pull: { appDevices: { deviceId } } });
    return res.json({ success: true, message: 'Device removed.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not remove the device.' });
  }
});

export default router;
