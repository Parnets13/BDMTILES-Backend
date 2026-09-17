import Customer from '../models/Customer.js';
import { verifyCustomerToken } from '../utils/customerJwt.js';

/**
 * Storefront customer authentication.
 * Accepts ONLY tokens of `type: 'customer'` (issued by utils/customerJwt.js).
 * Staff access tokens are rejected here, and customer tokens are rejected by
 * the staff `protect` middleware — the two auth worlds stay isolated.
 */
const tokenFromRequest = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.customerToken || null;
};

export const protectCustomer = async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'Please log in to continue.' });
    }

    let decoded;
    try {
      decoded = verifyCustomerToken(token);
      if (decoded.type !== 'customer') throw new Error('Wrong token type');
    } catch {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }

    const customer = await Customer.findById(decoded.customerId)
      .select('name contactNumber whatsappNumber email city state pinCode billingAddress deliveryAddress status')
      .lean();
    if (!customer || customer.status !== 'active') {
      return res.status(401).json({ success: false, message: 'Account not found.' });
    }

    req.customer = customer;
    return next();
  } catch (error) {
    return next(error);
  }
};
