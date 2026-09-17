import jwt from 'jsonwebtoken';

export const generateToken = (userId, role, tokenVersion = 0) => jwt.sign(
  { userId, role, type: 'access', tokenVersion },
  process.env.JWT_SECRET,
  { expiresIn: '15m' }
);

export const generateRefreshToken = (userId, tokenVersion = 0, jti) => {
  const token = jwt.sign(
    { userId, type: 'refresh', tokenVersion },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: `${Number.parseInt(process.env.JWT_REFRESH_DAYS, 10) || 30}d`,
      jwtid: jti,
    }
  );
  const decoded = jwt.decode(token);
  return { token, expiresAt: new Date(decoded.exp * 1000) };
};

export const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);
export const verifyRefreshToken = (token) => jwt.verify(token, process.env.JWT_REFRESH_SECRET);

// Dealer App access token — a distinct principal ('dealer') so it can never be
// mistaken for a staff User token by the staff `protect` middleware.
export const generateDealerToken = (dealerId, tokenVersion = 0) => jwt.sign(
  { dealerId, role: 'dealer', type: 'dealer_access', tokenVersion },
  process.env.JWT_SECRET,
  { expiresIn: process.env.DEALER_TOKEN_EXPIRY || '30d' }
);

/**
 * Short-lived, single-document download token.
 *
 * PDF links are opened by the device's browser / viewer, which cannot send an
 * Authorization header. Instead the app asks for a token bound to one document
 * and one dealer, valid for a few minutes, and passes it in the query string.
 */
export const generateDownloadToken = (dealerId, docType, docId, expiresIn = '5m') => jwt.sign(
  { dealerId, docType, docId, type: 'dealer_download' },
  process.env.JWT_SECRET,
  { expiresIn }
);

export const verifyDownloadToken = (token, docType, docId) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.type !== 'dealer_download') throw new Error('Wrong token type');
  if (decoded.docType !== docType) throw new Error('Token is not valid for this document type');
  if (String(decoded.docId) !== String(docId)) throw new Error('Token is not valid for this document');
  return decoded;
};
