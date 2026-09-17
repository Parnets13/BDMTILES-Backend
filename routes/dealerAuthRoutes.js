import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import Dealer, { normalizeDealerMobile } from '../models/Dealer.js';
import OtpChallenge from '../models/OtpChallenge.js';
import { generateDealerToken } from '../utils/jwt.js';
import { protectDealer } from '../middleware/dealerAuth.js';

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

// Generic response so an attacker cannot enumerate which numbers are registered.
const OTP_REQUEST_RESPONSE = 'If that number is a registered BDMTILES dealer, an OTP has been sent.';
const sixDigitOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const hashOtp = (code, dealerId) => crypto
  .createHash('sha256')
  .update(`${code}:${dealerId}:${process.env.JWT_SECRET || 'otp'}`)
  .digest('hex');
// Until DLT/SMS is provisioned, echo the OTP to the client. Flip to 'false' once SMS is live.
const exposeOtpCode = () => String(process.env.OTP_EXPOSE_CODE ?? 'true').toLowerCase() !== 'false';

const dealerProfile = (dealer) => ({
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
  creditLimit: dealer.creditLimit,
  creditDays: dealer.creditDays,
  currentOutstanding: dealer.currentOutstanding,
  biometricEnabled: Boolean(dealer.biometricEnabled),
  hasPin: Boolean(dealer.pinHash),
  assignedSalesExecutive: dealer.assignedSalesExecutive
    ? { name: dealer.assignedSalesExecutive.name, phone: dealer.assignedSalesExecutive.phone }
    : null,
});

// SOW 17.1 "Device registration" — upsert the calling device onto the dealer.
// The client supplies a stable deviceId; without one we simply skip registration
// rather than inventing duplicate rows on every login.
const registerDevice = (dealerDoc, device) => {
  const deviceId = String(device?.deviceId || '').trim().slice(0, 200);
  if (!deviceId) return;
  const now = new Date();
  const existing = (dealerDoc.appDevices || []).find(d => d.deviceId === deviceId);
  if (existing) {
    existing.lastSeenAt = now;
    if (device.deviceName) existing.deviceName = String(device.deviceName).slice(0, 120);
    if (device.platform) existing.platform = String(device.platform).slice(0, 40);
    if (device.osVersion) existing.osVersion = String(device.osVersion).slice(0, 40);
    if (device.appVersion) existing.appVersion = String(device.appVersion).slice(0, 40);
    return;
  }
  dealerDoc.appDevices = [
    ...(dealerDoc.appDevices || []),
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

const loginResponse = async (res, dealerDoc, message, device = null) => {
  dealerDoc.appLastLoginAt = new Date();
  if (device) registerDevice(dealerDoc, device);
  await dealerDoc.save({ validateBeforeSave: false });
  const full = await Dealer.findById(dealerDoc._id)
    .populate('dealerType', 'name pricingTier')
    .populate('assignedSalesExecutive', 'name phone')
    .lean();
  const token = generateDealerToken(dealerDoc._id, dealerDoc.tokenVersion || 0);
  return res.json({ success: true, message, token, dealer: dealerProfile(full) });
};

// POST /api/v1/dealer-app/auth/otp/request  { mobile }
router.post('/otp/request', otpRequestLimiter, async (req, res) => {
  try {
    const normalized = normalizeDealerMobile(req.body?.mobile);
    if (normalized.length < 10) {
      return res.status(422).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
    }
    const dealer = await Dealer.findOne({ mobileNormalized: normalized, status: 'active', appAccess: true });
    // Always return the generic response, but only create a challenge for a real dealer.
    if (dealer) {
      const code = sixDigitOtp();
      await OtpChallenge.create({
        phone: normalized,
        dealer: dealer._id,
        codeHash: hashOtp(code, dealer._id),
        purpose: 'dealer_login',
        expiresAt: new Date(Date.now() + numberFromEnv('OTP_EXPIRE_MINUTES', 5) * 60 * 1000),
        ip: req.ip || '',
        userAgent: String(req.get('user-agent') || '').slice(0, 500),
      });
      // TODO: send via DLT SMS provider.
      const payload = { success: true, message: OTP_REQUEST_RESPONSE };
      if (exposeOtpCode()) payload.devOtp = code;
      return res.json(payload);
    }
    return res.json({ success: true, message: OTP_REQUEST_RESPONSE });
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
    const dealer = await Dealer.findOne({ _id: challenge.dealer, status: 'active', appAccess: true });
    if (!dealer) {
      await OtpChallenge.deleteOne({ _id: challenge._id });
      return res.status(403).json({ success: false, message: 'This account cannot use the app.' });
    }
    challenge.consumedAt = new Date();
    await challenge.save({ validateBeforeSave: false });
    await OtpChallenge.deleteMany({ dealer: dealer._id, consumedAt: null });
    return loginResponse(res, dealer, 'Login successful', req.body?.device);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

// POST /api/v1/dealer-app/auth/pin/set  { pin }   (requires an authenticated dealer)
router.post('/pin/set', protectDealer, async (req, res) => {
  try {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(422).json({ success: false, message: 'PIN must be 4 to 6 digits.' });
    }
    const dealer = await Dealer.findById(req.dealerId);
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });
    dealer.pinHash = await bcrypt.hash(pin, 10);
    if (typeof req.body?.biometricEnabled === 'boolean') dealer.biometricEnabled = req.body.biometricEnabled;
    await dealer.save({ validateBeforeSave: false });
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
    const dealer = await Dealer.findOne({ mobileNormalized: normalized, status: 'active', appAccess: true }).select('+pinHash');
    if (!dealer || !dealer.pinHash || !(await bcrypt.compare(pin, dealer.pinHash))) {
      return res.status(401).json({ success: false, message: 'Incorrect mobile or PIN.' });
    }
    return loginResponse(res, dealer, 'Login successful', req.body?.device);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

// GET /api/v1/dealer-app/auth/me
router.get('/me', protectDealer, (req, res) => {
  res.json({ success: true, dealer: dealerProfile(req.dealer) });
});

// POST /api/v1/dealer-app/auth/logout  (logout from all devices by bumping tokenVersion)
router.post('/logout', protectDealer, async (req, res) => {
  try {
    if (req.body?.allDevices) {
      // Bumping tokenVersion invalidates every issued token, so also clear the
      // registered device list — nothing is signed in any more.
      await Dealer.updateOne(
        { _id: req.dealerId },
        { $inc: { tokenVersion: 1 }, $set: { appDevices: [] } },
      );
    }
    return res.json({ success: true, message: 'Logged out.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Logout failed.' });
  }
});

// GET /api/v1/dealer-app/auth/devices — registered devices (SOW 17.1)
router.get('/devices', protectDealer, async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.dealerId).select('appDevices').lean();
    const devices = [...(dealer?.appDevices || [])]
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
    await Dealer.updateOne(
      { _id: req.dealerId },
      { $pull: { appDevices: { deviceId } } },
    );
    return res.json({ success: true, message: 'Device removed.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not remove the device.' });
  }
});

export default router;
