import jwt from 'jsonwebtoken';

/**
 * Customer-facing JWT (storefront).
 * Deliberately separate from staff tokens (utils/jwt.js) so a customer token
 * can NEVER authenticate against staff/CRM/warehouse routes: it carries
 * `type: 'customer'` and is verified only by middleware/customerAuth.js.
 */
export const generateCustomerToken = (customerId, phone) => jwt.sign(
  { customerId, phone, type: 'customer' },
  process.env.JWT_SECRET,
  { expiresIn: process.env.CUSTOMER_JWT_EXPIRE || '30d' }
);

export const verifyCustomerToken = (token) => jwt.verify(token, process.env.JWT_SECRET);
