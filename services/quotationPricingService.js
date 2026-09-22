import mongoose from 'mongoose';
import Dealer from '../models/Dealer.js';
import DealerLedger from '../models/DealerLedger.js';
import { deriveOrderPricing } from './orderPricingService.js';

// Pricing helpers shared by the quotation routes and the quotation conversion
// service. These used to live inside routes/quotationRoutes.js; the conversion
// core was lifted out so dealer order processing can reuse it, and duplicating
// pricing was not an option — two copies of discount and approval derivation
// would drift and quietly produce different money for the same request.

const pricingError = (status, message) => Object.assign(new Error(message), { status });

export async function findActiveDealer(id, session = null) {
  if (!id || !mongoose.isValidObjectId(id)) return null;
  let query = Dealer.findById(id).populate('dealerType', 'name pricingTier status');
  if (session) query = query.session(session);
  const dealer = await query.lean();
  if (dealer && dealer.status !== 'active') throw pricingError(422, 'Dealer is not active.');
  if (dealer?.dealerType && dealer.dealerType.status !== 'active') throw pricingError(422, 'DealerType is not active.');
  return dealer;
}

export async function getBranchOutstanding(branchId, dealerId, session = null) {
  let aggregate = DealerLedger.aggregate([
    { $match: { branch: branchId, dealer: dealerId } },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  if (session) aggregate = aggregate.session(session);
  const [branchLedger] = await aggregate;
  return Number((branchLedger?.debit || 0) - (branchLedger?.credit || 0));
}

export function quotationContext(data, dealer) {
  if (dealer) return { dealerId: dealer._id, dealerTypeId: dealer.dealerType?._id, scope: 'dealer', orderType: data.customerType || 'dealer' };
  if (data.dealerType) return { dealerTypeId: data.dealerType, scope: 'dealer_type', orderType: data.customerType || 'retail' };
  return { scope: 'walk_in', orderType: 'retail' };
}

export function quotationPricingFields(priced, dealer) {
  return {
    items: priced.items,
    subtotal: priced.subtotal,
    totalDiscount: priced.totalDiscount,
    totalSchemeDiscount: priced.totalSchemeDiscount,
    totalTax: priced.totalTax,
    freightCharges: priced.freightCharges,
    loadingCharges: priced.loadingCharges,
    installationCharges: priced.installationCharges,
    otherCharges: priced.otherCharges,
    roundOff: priced.roundOff,
    grandTotal: priced.grandTotal,
    dealerType: dealer?.dealerType?._id || priced.dealerType,
    dealerTypeSnapshot: dealer?.dealerType
      ? { name: dealer.dealerType.name, pricingTier: dealer.dealerType.pricingTier }
      : priced.dealerTypeSnapshot,
    approvalReasons: priced.approvalReasons,
    approvalRequired: priced.approvalReasons.length > 0,
    approvalStatus: priced.approvalStatus,
  };
}

export async function priceQuotation(data, dealer, branchId, session = null, existingReasons = [], options = {}) {
  const priced = await deriveOrderPricing({
    branchId, ...quotationContext(data, dealer), pricingDate: data.quotationDate || new Date(),
    items: data.items, freightCharges: data.freightCharges, loadingCharges: data.loadingCharges,
    installationCharges: data.installationCharges, otherCharges: data.otherCharges,
    existingApprovalReasons: existingReasons, preserveSnapshots: Boolean(options.preserveSnapshots),
    preserveBelowMinimumApprovals: Boolean(options.preserveBelowMinimumApprovals), requireItemUnit: true, session,
  });
  return { priced, fields: quotationPricingFields(priced, dealer) };
}
