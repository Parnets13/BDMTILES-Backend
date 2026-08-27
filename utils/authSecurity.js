import crypto from 'crypto';
import { generateRefreshToken } from './jwt.js';

export const REFRESH_COOKIE_NAME = 'bdmtiles_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const maxRefreshSessions = () => positiveInteger(process.env.MAX_REFRESH_SESSIONS, 5);

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

export const validateStrongPassword = (password) => {
  const value = String(password || '');
  const minimumLength = positiveInteger(process.env.PASSWORD_MIN_LENGTH, 10);
  if (value.length < minimumLength
    || !/[a-z]/.test(value)
    || !/[A-Z]/.test(value)
    || !/\d/.test(value)
    || !/[^A-Za-z0-9]/.test(value)) {
    return `Password must be at least ${minimumLength} characters and include uppercase, lowercase, number, and special characters.`;
  }
  return null;
};

export const refreshCookieOptions = () => {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: positiveInteger(process.env.JWT_REFRESH_DAYS, 30) * 24 * 60 * 60 * 1000,
  };
};

export const clearRefreshCookie = (res) => {
  const { maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options);
};

export const createRefreshCredential = (user, req) => {
  const jti = randomToken();
  const { token, expiresAt } = generateRefreshToken(
    user._id,
    user.tokenVersion || 0,
    jti
  );
  const now = new Date();
  return {
    token,
    session: {
      tokenHash: sha256(token),
      jtiHash: sha256(jti),
      expiresAt,
      createdAt: now,
      lastUsedAt: now,
      userAgent: String(req.get('user-agent') || '').slice(0, 500),
      ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 100),
    },
  };
};

export const setRefreshCookie = (res, token) => {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
};

export const boundedSessions = (sessions, nextSession) => [
  ...(sessions || []).filter((session) => session.expiresAt > new Date()),
  nextSession,
].slice(-maxRefreshSessions());
