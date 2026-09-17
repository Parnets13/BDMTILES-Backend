import { verifyToken } from '../utils/jwt.js';
import Dealer from '../models/Dealer.js';

// Dealer App authentication. Verifies the dealer access token (type
// 'dealer_access'), loads the active dealer, and exposes it as req.dealer /
// req.dealerId. Also sets req.branchId to the dealer's own branch context is
// derived per-record, so dealer reads are always scoped to their own data.
const tokenFromRequest = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.split(' ')[1];
  return null;
};

export const protectDealer = async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authorized. Please sign in.' });
    }

    let decoded;
    try {
      decoded = verifyToken(token);
      if (decoded.type !== 'dealer_access' || decoded.role !== 'dealer' || !decoded.dealerId) {
        throw new Error('Wrong token type');
      }
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
    }

    const dealer = await Dealer.findById(decoded.dealerId)
      .populate('dealerType', 'name pricingTier')
      .populate('assignedSalesExecutive', 'name phone')
      .lean();

    if (!dealer) return res.status(401).json({ success: false, message: 'Dealer account not found.' });
    if (dealer.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Your dealer account is not active. Contact BDMTILES.' });
    }
    if (!dealer.appAccess) {
      return res.status(403).json({ success: false, message: 'App access is not enabled for your account yet.' });
    }
    if (Number(decoded.tokenVersion || 0) !== Number(dealer.tokenVersion || 0)) {
      return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.' });
    }

    req.dealer = dealer;
    req.dealerId = dealer._id;
    return next();
  } catch (error) {
    return next(error);
  }
};

export default protectDealer;
