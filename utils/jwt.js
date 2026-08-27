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
