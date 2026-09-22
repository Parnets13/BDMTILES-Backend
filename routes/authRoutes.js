import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import OtpChallenge from '../models/OtpChallenge.js';
import { generateToken, verifyRefreshToken } from '../utils/jwt.js';
import { authenticateOnly, buildAuthUser } from '../middleware/auth.js';
import {
  REFRESH_COOKIE_NAME,
  boundedSessions,
  clearRefreshCookie,
  createRefreshCredential,
  maxRefreshSessions,
  randomToken,
  refreshRotationGraceMs,
  setRefreshCookie,
  sha256,
  validateStrongPassword,
} from '../utils/authSecurity.js';
import { sendPasswordResetEmail } from '../services/mailService.js';

const router = Router();
const INVALID_CREDENTIALS = 'Invalid credentials.';
const FORGOT_RESPONSE = 'If an account matches that email, password reset instructions will be sent.';
const numberFromEnv = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const loginLimiter = rateLimit({
  windowMs: numberFromEnv('LOGIN_RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000,
  limit: numberFromEnv('LOGIN_RATE_LIMIT_MAX', 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many login attempts. Try again later.' }),
});

const passwordResetLimiter = rateLimit({
  windowMs: numberFromEnv('PASSWORD_RESET_RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000,
  limit: numberFromEnv('PASSWORD_RESET_RATE_LIMIT_MAX', 10),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many requests. Try again later.' }),
});

const otpRequestLimiter = rateLimit({
  windowMs: numberFromEnv('OTP_REQUEST_RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000,
  limit: numberFromEnv('OTP_REQUEST_RATE_LIMIT_MAX', 12),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many OTP requests. Try again later.' }),
});

const otpVerifyLimiter = rateLimit({
  windowMs: numberFromEnv('OTP_VERIFY_RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000,
  limit: numberFromEnv('OTP_VERIFY_RATE_LIMIT_MAX', 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many attempts. Try again later.' }),
});

// Roles permitted to sign in through the phone + OTP field-app flow.
const OTP_LOGIN_ROLES = new Set(['sales_executive']);
// Generic response so an attacker cannot enumerate which phone numbers exist.
const OTP_REQUEST_RESPONSE = 'If that number is registered for the field app, an OTP has been sent.';
const normalizePhone = (value) => String(value || '').replace(/[^\d]/g, '').slice(-15);
const sixDigitOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const hashOtp = (code, userId) => crypto
  .createHash('sha256')
  .update(`${code}:${userId}:${process.env.JWT_SECRET || 'otp'}`)
  .digest('hex');
// Until DLT/SMS is provisioned, the generated OTP is echoed to the client so the
// executive can complete login. Flip OTP_EXPOSE_CODE to 'false' once SMS is live.
const exposeOtpCode = () => String(process.env.OTP_EXPOSE_CODE ?? 'true').toLowerCase() !== 'false';

const invalidCredentials = (res) => res.status(401).json({ success: false, message: INVALID_CREDENTIALS });

const resetExpiredLock = async (user) => {
  if (!user.loginLockedUntil || user.loginLockedUntil > new Date()) return;
  user.failedLoginAttempts = 0;
  user.loginLockedUntil = undefined;
  await user.save({ validateBeforeSave: false });
};

const recordFailedLogin = async (userId) => {
  const maxAttempts = numberFromEnv('LOGIN_MAX_FAILED_ATTEMPTS', 5);
  const lockUntil = new Date(Date.now() + numberFromEnv('LOGIN_LOCK_MINUTES', 15) * 60 * 1000);
  await User.updateOne(
    { _id: userId },
    [{
      $set: {
        failedLoginAttempts: { $add: [{ $ifNull: ['$failedLoginAttempts', 0] }, 1] },
        loginLockedUntil: {
          $cond: [
            { $gte: [{ $add: [{ $ifNull: ['$failedLoginAttempts', 0] }, 1] }, maxAttempts] },
            lockUntil,
            '$loginLockedUntil',
          ],
        },
      },
    }]
  );
};

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const identifier = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }

    const user = await User.findOne({
      $or: [{ email: identifier }, { username: identifier }],
    }).select('+password +refreshSessions');

    if (!user) return invalidCredentials(res);
    await resetExpiredLock(user);
    if (user.loginLockedUntil && user.loginLockedUntil > new Date()) return invalidCredentials(res);

    if (!await user.comparePassword(password)) {
      await recordFailedLogin(user._id);
      return invalidCredentials(res);
    }
    if (user.status !== 'Active') return invalidCredentials(res);

    user.failedLoginAttempts = 0;
    user.loginLockedUntil = undefined;
    user.lastLogin = new Date();
    const credential = createRefreshCredential(user, req);
    user.refreshSessions = boundedSessions(user.refreshSessions, credential.session);
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user._id, user.role, user.tokenVersion || 0);
    const userObj = await buildAuthUser(user._id);
    setRefreshCookie(res, credential.token);
    return res.json({ success: true, message: 'Login successful', token, user: userObj });
  } catch (error) {
    console.error('Login error:', error.message);
    return res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

router.post('/otp/request', otpRequestLimiter, async (req, res) => {
  const response = { success: true, message: OTP_REQUEST_RESPONSE };
  try {
    const phone = normalizePhone(req.body?.phone);
    if (phone.length < 10) {
      return res.status(400).json({ success: false, message: 'A valid phone number is required.' });
    }
    // Match the field-app roles on the trailing digits so stored formats
    // (with or without country code/spaces) still resolve.
    const candidates = await User.find({
      status: 'Active',
      role: { $in: [...OTP_LOGIN_ROLES] },
    }).select('_id phone role name');
    const user = candidates.find((candidate) => normalizePhone(candidate.phone) === phone);
    if (!user) return res.json(response);

    const code = sixDigitOtp();
    const ttlMinutes = numberFromEnv('OTP_EXPIRE_MINUTES', 5);
    await OtpChallenge.deleteMany({ user: user._id, consumedAt: null });
    await OtpChallenge.create({
      phone,
      user: user._id,
      codeHash: hashOtp(code, user._id),
      purpose: 'se_login',
      maxAttempts: numberFromEnv('OTP_MAX_ATTEMPTS', 5),
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
      ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 100),
      userAgent: String(req.get('user-agent') || '').slice(0, 500),
    });

    // TODO: dispatch `code` via DLT-approved SMS once the provider is configured.
    if (exposeOtpCode()) {
      response.devOtp = code;
      response.expiresInSeconds = ttlMinutes * 60;
    }
    return res.json(response);
  } catch (error) {
    console.error('OTP request error:', error.message);
    return res.json(response);
  }
});

router.post('/otp/verify', otpVerifyLimiter, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.otp || req.body?.code || '').trim();
    if (phone.length < 10 || !/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ success: false, message: 'Phone number and OTP are required.' });
    }

    const challenge = await OtpChallenge.findOne({
      phone,
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

    if (hashOtp(code, challenge.user) !== challenge.codeHash) {
      challenge.attempts += 1;
      await challenge.save({ validateBeforeSave: false });
      return res.status(401).json({ success: false, message: 'Incorrect OTP.' });
    }

    const user = await User.findOne({ _id: challenge.user, status: 'Active' }).select('+refreshSessions role tokenVersion');
    if (!user || !OTP_LOGIN_ROLES.has(user.role)) {
      await OtpChallenge.deleteOne({ _id: challenge._id });
      return res.status(401).json({ success: false, message: 'This account cannot use app login.' });
    }

    challenge.consumedAt = new Date();
    await challenge.save({ validateBeforeSave: false });
    await OtpChallenge.deleteMany({ user: user._id, consumedAt: null });

    user.lastLogin = new Date();
    const credential = createRefreshCredential(user, req);
    user.refreshSessions = boundedSessions(user.refreshSessions, credential.session);
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user._id, user.role, user.tokenVersion || 0);
    const userObj = await buildAuthUser(user._id);
    setRefreshCookie(res, credential.token);
    return res.json({ success: true, message: 'Login successful', token, user: userObj });
  } catch (error) {
    console.error('OTP verify error:', error.message);
    return res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

router.get('/me', authenticateOnly, async (req, res) => {
  res.json({ success: true, user: req.user });
});

router.post('/refresh-token', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    clearRefreshCookie(res);
    return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
  }

  let claimsVerified = false;
  try {
    const decoded = verifyRefreshToken(refreshToken);
    if (decoded.type !== 'refresh' || !decoded.jti || !Number.isInteger(decoded.tokenVersion)) {
      throw new Error('Invalid refresh token claims');
    }
    claimsVerified = true;

    const now = new Date();
    const tokenHash = sha256(refreshToken);
    const jtiHash = sha256(decoded.jti);
    const nextCredential = createRefreshCredential({
      _id: decoded.userId,
      tokenVersion: decoded.tokenVersion,
    }, req);

    const user = await User.findOneAndUpdate(
      {
        _id: decoded.userId,
        status: 'Active',
        tokenVersion: decoded.tokenVersion,
        // replacedByHash must still be null: a session that was already rotated
        // away by an earlier call is never rotated a second time, or the same
        // dead token could be replayed indefinitely, each time minting a new
        // "current" session. It is still allowed to satisfy the RACE-LOSER lookup
        // below during its grace window — it simply can't win the primary match.
        refreshSessions: {
          $elemMatch: { tokenHash, jtiHash, expiresAt: { $gt: now }, replacedByHash: null },
        },
      },
      [{
        $set: {
          refreshSessions: {
            $slice: [
              {
                $concatArrays: [
                  {
                    $map: {
                      input: { $ifNull: ['$refreshSessions', []] },
                      as: 'session',
                      // The rotated-away session is kept, not dropped, with a
                      // breadcrumb pointing at its replacement. A second request
                      // racing in with the same now-dead token can then be handed
                      // the replacement below instead of being rejected outright.
                      in: {
                        $cond: [
                          { $eq: ['$$session.tokenHash', tokenHash] },
                          {
                            $mergeObjects: ['$$session', {
                              replacedByHash: nextCredential.session.tokenHash,
                              replacedAt: now,
                            }],
                          },
                          '$$session',
                        ],
                      },
                    },
                  },
                  [nextCredential.session],
                ],
              },
              -(maxRefreshSessions() + 1),
            ],
          },
        },
      }],
      { new: true }
    ).select('role tokenVersion');

    if (user) {
      const token = generateToken(user._id, user.role, user.tokenVersion || 0);
      const userObj = await buildAuthUser(user._id);
      setRefreshCookie(res, nextCredential.token);
      return res.json({ success: true, token, user: userObj });
    }

    // No live session matched this token outright. Before treating it as reuse of
    // a dead token, check whether this exact token was the one JUST rotated away
    // by a concurrent request, within a short grace window. Two browser tabs
    // waking from idle together — or a burst of requests that all 401 at once and
    // each independently call refresh — is the common case, not an attack, and
    // should not force a full logout when the rotation actually succeeded.
    const graceCutoff = new Date(now.getTime() - refreshRotationGraceMs());
    const raceLoser = await User.findOne({
      _id: decoded.userId,
      status: 'Active',
      tokenVersion: decoded.tokenVersion,
      refreshSessions: {
        $elemMatch: { tokenHash, replacedByHash: { $ne: null }, replacedAt: { $gt: graceCutoff } },
      },
    }).select('role tokenVersion refreshSessions').lean();
    const replacedEntry = raceLoser?.refreshSessions?.find((session) => session.tokenHash === tokenHash);
    const currentSession = replacedEntry
      && raceLoser.refreshSessions.find((session) => session.tokenHash === replacedEntry.replacedByHash);

    if (raceLoser && currentSession) {
      // The winning concurrent request already rotated the cookie via its own
      // Set-Cookie header, and cookies are shared per-origin across tabs — so this
      // response does not need to (and cannot) reissue one. It only needs to hand
      // this losing request a valid access token so the page it came from does
      // not treat "refresh failed" as "session is dead" and log the user out.
      const token = generateToken(raceLoser._id, raceLoser.role, raceLoser.tokenVersion || 0);
      const userObj = await buildAuthUser(raceLoser._id);
      return res.json({ success: true, token, user: userObj, rotationRace: true });
    }

    throw new Error('Refresh session was already used or revoked');
  } catch {
    // A valid-but-consumed token may be a losing cross-tab rotation request. Do not
    // clear the replacement cookie another concurrent request may already have set.
    if (!claimsVerified) clearRefreshCookie(res);
    return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
  }
});

router.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    await User.updateOne(
      { 'refreshSessions.tokenHash': sha256(refreshToken) },
      { $pull: { refreshSessions: { tokenHash: sha256(refreshToken) } } }
    ).catch(() => undefined);
  }
  clearRefreshCookie(res);
  return res.json({ success: true, message: 'Logged out.' });
});

router.post('/logout-all', authenticateOnly, async (req, res) => {
  await User.updateOne(
    { _id: req.user._id },
    { $inc: { tokenVersion: 1 }, $set: { refreshSessions: [] } }
  );
  clearRefreshCookie(res);
  return res.json({ success: true, message: 'Logged out from all devices.' });
});

router.post('/change-password', authenticateOnly, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const passwordError = validateStrongPassword(newPassword);
    if (!currentPassword || passwordError) {
      return res.status(422).json({ success: false, message: passwordError || 'Current password is required.' });
    }

    const user = await User.findById(req.user._id).select('+password +refreshSessions');
    if (!user || !await user.comparePassword(currentPassword)) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }
    if (await user.comparePassword(newPassword)) {
      return res.status(422).json({ success: false, message: 'New password must be different from the current password.' });
    }

    user.password = newPassword;
    user.mustChangePassword = false;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.failedLoginAttempts = 0;
    user.loginLockedUntil = undefined;
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
    const credential = createRefreshCredential(user, req);
    user.refreshSessions = [credential.session];
    await user.save();

    const token = generateToken(user._id, user.role, user.tokenVersion);
    const userObj = await buildAuthUser(user._id);
    setRefreshCookie(res, credential.token);
    return res.json({ success: true, message: 'Password changed successfully.', token, user: userObj });
  } catch (error) {
    console.error('Change password error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to change password.' });
  }
});

router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const response = { success: true, message: FORGOT_RESPONSE };
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = email ? await User.findOne({ email, status: 'Active' }) : null;
    if (!user) return res.json(response);

    const resetToken = randomToken();
    user.passwordResetTokenHash = sha256(resetToken);
    user.passwordResetExpiresAt = new Date(
      Date.now() + numberFromEnv('PASSWORD_RESET_EXPIRE_MINUTES', 30) * 60 * 1000
    );
    await user.save({ validateBeforeSave: false });

    const frontendUrl = String(process.env.FRONTEND_URL || 'http://localhost:5173')
      .split(',')[0]
      .trim()
      .replace(/\/$/, '');
    const resetUrl = `${frontendUrl}/reset-password/${encodeURIComponent(resetToken)}`;
    try {
      await sendPasswordResetEmail({ email: user.email, name: user.name, resetUrl });
    } catch (error) {
      console.error('Password reset email error:', error.message);
    }

    if (process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_RESET_TOKEN === 'true') {
      response.devResetToken = resetToken;
    }
    return res.json(response);
  } catch (error) {
    console.error('Forgot password error:', error.message);
    return res.json(response);
  }
});

router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const resetToken = String(req.body?.token || '');
    const newPassword = String(req.body?.newPassword || '');
    const passwordError = validateStrongPassword(newPassword);
    if (!resetToken || passwordError) {
      return res.status(422).json({ success: false, message: passwordError || 'Reset token is required.' });
    }

    const resetTokenHash = sha256(resetToken);
    const tokenFilter = {
      passwordResetTokenHash: resetTokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
      status: 'Active',
    };
    const user = await User.findOne(tokenFilter).select('+password +refreshSessions +passwordResetTokenHash +passwordResetExpiresAt');

    if (!user) {
      return res.status(400).json({ success: false, message: 'Reset link is invalid or expired.' });
    }
    if (await user.comparePassword(newPassword)) {
      return res.status(422).json({ success: false, message: 'New password must be different from the current password.' });
    }

    const passwordHash = await (await import('bcrypt')).default.hash(newPassword, 12);
    const updatedUser = await User.findOneAndUpdate(
      { _id: user._id, ...tokenFilter },
      {
        $set: {
          password: passwordHash,
          mustChangePassword: false,
          refreshSessions: [],
          failedLoginAttempts: 0,
        },
        $unset: {
          passwordResetTokenHash: 1,
          passwordResetExpiresAt: 1,
          loginLockedUntil: 1,
        },
        $inc: { tokenVersion: 1 },
      },
      { new: true }
    );
    if (!updatedUser) {
      return res.status(400).json({ success: false, message: 'Reset link is invalid or expired.' });
    }

    clearRefreshCookie(res);
    return res.json({ success: true, message: 'Password reset successfully. Please login.' });
  } catch (error) {
    console.error('Reset password error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to reset password.' });
  }
});

export default router;
