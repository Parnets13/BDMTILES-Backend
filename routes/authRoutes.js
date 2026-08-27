import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import { generateToken, verifyRefreshToken } from '../utils/jwt.js';
import { authenticateOnly, buildAuthUser } from '../middleware/auth.js';
import {
  REFRESH_COOKIE_NAME,
  boundedSessions,
  clearRefreshCookie,
  createRefreshCredential,
  maxRefreshSessions,
  randomToken,
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
        refreshSessions: {
          $elemMatch: { tokenHash, jtiHash, expiresAt: { $gt: now } },
        },
      },
      [{
        $set: {
          refreshSessions: {
            $slice: [
              {
                $concatArrays: [
                  {
                    $filter: {
                      input: { $ifNull: ['$refreshSessions', []] },
                      as: 'session',
                      cond: { $ne: ['$$session.tokenHash', tokenHash] },
                    },
                  },
                  [nextCredential.session],
                ],
              },
              -maxRefreshSessions(),
            ],
          },
        },
      }],
      { new: true }
    ).select('role tokenVersion');

    if (!user) throw new Error('Refresh session was already used or revoked');

    const token = generateToken(user._id, user.role, user.tokenVersion || 0);
    const userObj = await buildAuthUser(user._id);
    setRefreshCookie(res, nextCredential.token);
    return res.json({ success: true, token, user: userObj });
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
