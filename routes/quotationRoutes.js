import { Router } from 'express';
import mongoose from 'mongoose';
import Quotation from '../models/Quotation.js';
import SalesOrder from '../models/SalesOrder.js';
import Dealer from '../models/Dealer.js';
import DealerLedger from '../models/DealerLedger.js';
import { deriveOrderPricing, addCreditApproval } from '../services/orderPricingService.js';
import { getDealerCreditExposure } from '../services/dealerCreditService.js';
import { syncAutomaticApprovalRequest } from '../services/approvalRequestService.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { reserveSalesOrderInventory } from '../utils/salesOrderInventory.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const SERVER_MANAGED_FIELDS = new Set([
  'quotationNumber', 'branch', 'legacyBranch', 'createdBy', 'dealerName', 'dealerCode', 'dealerTypeSnapshot',
  'subtotal', 'totalDiscount', 'totalSchemeDiscount', 'totalTax', 'roundOff', 'grandTotal',
  'status', 'approvalRequired', 'approvalStatus', 'approvalReasons', 'approvedBy', 'approvalDate', 'approvalRemarks',
  'convertedToSO', 'convertedAt', 'version', 'previousVersion', 'tallySyncStatus', 'createdAt', 'updatedAt', '_id', '__v',
]);
const STATUS_TRANSITIONS = {
  draft: new Set(['sent', 'cancelled']),
  pending_approval: new Set(['cancelled']),
  approved: new Set(['sent', 'accepted', 'cancelled']),
  sent: new Set(['accepted', 'cancelled']),
  accepted: new Set(['cancelled']),
  converted: new Set([]), expired: new Set([]), cancelled: new Set([]),
};
const routeError = (status, message) => Object.assign(new Error(message), { status });
function editableBody(body = {}) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SERVER_MANAGED_FIELDS.has(key)));
}
async function findActiveDealer(id, session = null) {
  if (!id || !mongoose.isValidObjectId(id)) return null;
  let query = Dealer.findById(id).populate('dealerType', 'name pricingTier status');
  if (session) query = query.session(session);
  const dealer = await query.lean();
  if (dealer && dealer.status !== 'active') throw routeError(422, 'Dealer is not active.');
  if (dealer?.dealerType && dealer.dealerType.status !== 'active') throw routeError(422, 'DealerType is not active.');
  return dealer;
}
async function getBranchOutstanding(branchId, dealerId, session = null) {
  let aggregate = DealerLedger.aggregate([
    { $match: { branch: branchId, dealer: dealerId } },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  if (session) aggregate = aggregate.session(session);
  const [branchLedger] = await aggregate;
  return Number((branchLedger?.debit || 0) - (branchLedger?.credit || 0));
}
function quotationContext(data, dealer) {
  if (dealer) return { dealerId: dealer._id, dealerTypeId: dealer.dealerType?._id, scope: 'dealer', orderType: data.customerType || 'dealer' };
  if (data.dealerType) return { dealerTypeId: data.dealerType, scope: 'dealer_type', orderType: data.customerType || 'retail' };
  return { scope: 'walk_in', orderType: 'retail' };
}
function quotationPricingFields(priced, dealer) {
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
async function priceQuotation(data, dealer, branchId, session = null, existingReasons = [], options = {}) {
  const priced = await deriveOrderPricing({
    branchId, ...quotationContext(data, dealer), pricingDate: data.quotationDate || new Date(),
    items: data.items, freightCharges: data.freightCharges, loadingCharges: data.loadingCharges,
    installationCharges: data.installationCharges, otherCharges: data.otherCharges,
    existingApprovalReasons: existingReasons, preserveSnapshots: Boolean(options.preserveSnapshots),
    preserveBelowMinimumApprovals: Boolean(options.preserveBelowMinimumApprovals), session,
  });
  return { priced, fields: quotationPricingFields(priced, dealer) };
}
async function findLinkedConvertedOrder(quotation, branchId, session = null) {
  if (!quotation?.convertedToSO) return null;
  let query = SalesOrder.findOne({
    _id: quotation.convertedToSO,
    branch: branchId,
    sourceQuotation: quotation._id,
  });
  if (session) query = query.session(session);
  return query;
}
function conversionSuccess(quotation, salesOrder, idempotent = false) {
  return {
    success: true,
    idempotent,
    message: idempotent
      ? `Quotation was already converted to ${salesOrder.orderNumber}.`
      : salesOrder.status === 'draft'
        ? `Converted to ${salesOrder.orderNumber} as draft pending approval.`
        : `Converted to ${salesOrder.orderNumber}.`,
    data: { quotation, salesOrder },
  };
}

router.get('/', requirePermission('quotation.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealer } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Number.parseInt(limit, 10) || 20);
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ quotationNumber: regex }, { dealerName: regex }, { customerName: regex }];
    }
    if (status) filter.status = status;
    if (dealer) filter.dealer = dealer;
    const [data, total] = await Promise.all([
      Quotation.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode mobile').populate('dealerType', 'name pricingTier').lean(),
      Quotation.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.get('/stats', requirePermission('quotation.management'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, draft, pendingApproval, sent, accepted, converted, expired, cancelled] = await Promise.all([
      Quotation.countDocuments(scope), Quotation.countDocuments({ ...scope, status: 'draft' }),
      Quotation.countDocuments({ ...scope, status: 'pending_approval' }), Quotation.countDocuments({ ...scope, status: 'sent' }),
      Quotation.countDocuments({ ...scope, status: 'accepted' }), Quotation.countDocuments({ ...scope, status: 'converted' }),
      Quotation.countDocuments({ ...scope, status: 'expired' }), Quotation.countDocuments({ ...scope, status: 'cancelled' }),
    ]);
    const totalValue = await Quotation.aggregate([
      { $match: { ...scope, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]);
    return res.json({ success: true, data: { total, draft, pendingApproval, sent, accepted, converted, expired, cancelled, totalValue: totalValue[0]?.total || 0 } });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.post('/price-preview', requireAnyPermission('sales.order.create', 'quotation.management'), async (req, res) => {
  try {
    const data = editableBody(req.body);
    const dealer = data.dealer ? await findActiveDealer(data.dealer) : null;
    if (data.dealer && !dealer) throw routeError(404, 'Dealer not found.');
    if (!dealer && !data.customerName) throw routeError(422, 'customerName is required for walk-in quotations.');
    await assertWarehousesInBranch((data.items || []).map(item => item.warehouse), req.branchId);
    const { fields } = await priceQuotation(data, dealer, req.branchId);
    return res.json({ success: true, data: fields });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

router.get('/:id', requirePermission('quotation.management'), async (req, res) => {
  try {
    const quotation = await Quotation.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode mobile city gstin')
      .populate('dealerType', 'name pricingTier')
      .populate('items.product', 'productCode itemName tileSize finish').lean();
    if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found.' });
    return res.json({ success: true, data: quotation });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.post('/', requirePermission('quotation.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let quotation;
    await session.withTransaction(async () => {
      const data = editableBody(req.body);
      if (data.customerType === 'walk_in') data.customerType = 'retail';
      const dealer = data.dealer ? await findActiveDealer(data.dealer, session) : null;
      if (data.dealer && !dealer) throw routeError(404, 'Dealer not found.');
      if (!dealer && !data.customerName) throw routeError(422, 'customerName is required for walk-in quotations.');
      await assertWarehousesInBranch((data.items || []).map(item => item.warehouse), req.branchId, { session });
      const { fields } = await priceQuotation(data, dealer, req.branchId, session);
      Object.assign(data, fields, {
        branch: req.branchId,
        createdBy: req.user._id,
        quotationNumber: await generateBranchNumber(req.branchId, 'quotation', data.quotationDate || new Date()),
        dealerName: dealer?.businessName || '',
        dealerCode: dealer?.dealerCode || '',
        tallySyncStatus: 'not_synced',
      });
      data.status = fields.approvalRequired ? 'pending_approval' : (req.body.status === 'sent' ? 'sent' : 'draft');
      if (!data.validUntil) {
        const validUntil = new Date(data.quotationDate || new Date());
        validUntil.setDate(validUntil.getDate() + 30);
        data.validUntil = validUntil;
      }
      [quotation] = await Quotation.create([data], { session });
      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'quotation',
        referenceModel: 'Quotation',
        referenceId: quotation._id,
        referenceNumber: quotation.quotationNumber,
        title: `Quotation ${quotation.quotationNumber} requires pricing approval`,
        reasons: quotation.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: quotation.grandTotal,
        document: quotation,
        session,
      });
    });
    return res.status(201).json({ success: true, message: `Quotation ${quotation.quotationNumber} created.`, data: quotation });
  } catch (error) { return res.status(error.status || (error.code === 11000 ? 409 : ['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.put('/:id', requirePermission('quotation.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let quotation;
    await session.withTransaction(async () => {
      quotation = await Quotation.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!quotation) throw routeError(404, 'Quotation not found.');
      if (!['draft', 'pending_approval'].includes(quotation.status)) throw routeError(409, `Cannot edit quotation in "${quotation.status}" status.`);
      const updates = editableBody(req.body);
      if (updates.customerType === 'walk_in') updates.customerType = 'retail';
      const data = { ...quotation.toObject(), ...updates };
      const dealer = data.dealer ? await findActiveDealer(data.dealer, session) : null;
      if (data.dealer && !dealer) throw routeError(404, 'Dealer not found.');
      if (!dealer && !data.customerName) throw routeError(422, 'customerName is required for walk-in quotations.');
      await assertWarehousesInBranch((data.items || []).map(item => item.warehouse), req.branchId, { session });
      const { fields } = await priceQuotation(data, dealer, req.branchId, session, quotation.approvalReasons || []);
      Object.assign(quotation, updates, fields, {
        dealerName: dealer?.businessName || '', dealerCode: dealer?.dealerCode || '',
        status: fields.approvalRequired ? 'pending_approval' : 'draft',
      });
      if (quotation.tallySyncStatus === 'synced') quotation.tallySyncStatus = 'pending';
      await quotation.save({ session });
      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'quotation',
        referenceModel: 'Quotation',
        referenceId: quotation._id,
        referenceNumber: quotation.quotationNumber,
        title: `Quotation ${quotation.quotationNumber} requires pricing approval`,
        reasons: quotation.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: quotation.grandTotal,
        document: quotation,
        session,
      });
    });
    return res.json({ success: true, message: 'Quotation updated.', data: quotation });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.patch('/:id/status', requirePermission('quotation.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { status } = req.body;
    let quotation;
    await session.withTransaction(async () => {
      const current = await Quotation.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Quotation not found.');
      if (!STATUS_TRANSITIONS[current.status]?.has(status)) throw routeError(409, `Cannot change quotation from "${current.status}" to "${status}".`);
      if (status === 'accepted' && ['pending', 'rejected'].includes(current.approvalStatus)) throw routeError(409, 'Quotation cannot be accepted before pricing approval.');
      quotation = await Quotation.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: current.status, updatedAt: current.updatedAt },
        { $set: { status } },
        { new: true, runValidators: true, session }
      );
      if (!quotation) throw routeError(409, 'Quotation changed before the status update could be applied.');
      if (status === 'cancelled') {
        await syncAutomaticApprovalRequest({
          branchId: req.branchId,
          type: 'quotation',
          referenceModel: 'Quotation',
          referenceId: quotation._id,
          reasons: [],
          session,
        });
      }
    });
    return res.json({ success: true, message: `Quotation marked as ${status}.`, data: quotation });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.post('/:id/convert', requirePermission('quotation.management'), requirePermission('sales.order.create'), async (req, res) => {
  let preflight;
  try {
    preflight = await Quotation.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!preflight) throw routeError(404, 'Quotation not found.');
    if (preflight.convertedToSO || preflight.convertedAt || preflight.status === 'converted') {
      const existingOrder = await findLinkedConvertedOrder(preflight, req.branchId);
      if (existingOrder) return res.json(conversionSuccess(preflight, existingOrder, true));
      throw routeError(409, 'Quotation is already marked as converted, but its linked Sales Order could not be verified.');
    }
    if (!['accepted', 'approved'].includes(preflight.status)) throw routeError(409, 'Only accepted or approved quotations can be converted.');
    if (preflight.approvalRequired && preflight.approvalStatus !== 'approved') throw routeError(409, 'Quotation pricing approval is required before conversion.');
    if (preflight.validUntil && new Date(preflight.validUntil) < new Date()) throw routeError(409, 'Expired quotation cannot be converted.');
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }

  let soNumber;
  try { soNumber = await generateBranchNumber(preflight.branch, 'salesOrder', new Date()); }
  catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }

  const session = await mongoose.startSession();
  try {
    let quotation;
    let salesOrder;
    let idempotent = false;
    await session.withTransaction(async () => {
      const current = await Quotation.findOne({ _id: req.params.id, branch: req.branchId }).session(session).lean();
      if (!current) throw routeError(404, 'Quotation not found.');
      if (current.convertedToSO || current.convertedAt || current.status === 'converted') {
        const existingOrder = await findLinkedConvertedOrder(current, req.branchId, session);
        if (!existingOrder) throw routeError(409, 'Quotation is already marked as converted, but its linked Sales Order could not be verified.');
        quotation = current;
        salesOrder = existingOrder;
        idempotent = true;
        return;
      }
      if (!['accepted', 'approved'].includes(current.status)) throw routeError(409, 'Quotation is no longer convertible.');
      if (current.approvalRequired && current.approvalStatus !== 'approved') throw routeError(409, 'Quotation pricing approval is required before conversion.');
      if (current.validUntil && new Date(current.validUntil) < new Date()) throw routeError(409, 'Expired quotation cannot be converted.');
      const dealer = current.dealer ? await findActiveDealer(current.dealer, session) : null;
      if (current.dealer && !dealer) throw routeError(404, 'Dealer not found.');
      await assertWarehousesInBranch((current.items || []).map(item => item.warehouse), req.branchId, { session });
      const { priced } = await priceQuotation(current, dealer, req.branchId, session, current.approvalReasons || [], {
        preserveSnapshots: true,
        preserveBelowMinimumApprovals: true,
      });
      const outstanding = dealer ? await getBranchOutstanding(req.branchId, dealer._id, session) : 0;
      const creditExposure = dealer ? await getDealerCreditExposure({ branchId: req.branchId, dealer, asOf: new Date(), session }) : null;
      const approval = addCreditApproval(priced, dealer, outstanding, current.approvalReasons || [], {
        preserveBelowMinimum: true,
        creditExposure,
      });
      const salesOrderId = new mongoose.Types.ObjectId();
      quotation = await Quotation.findOneAndUpdate(
        {
          _id: current._id,
          branch: req.branchId,
          status: current.status,
          convertedToSO: null,
          convertedAt: null,
        },
        { $set: { status: 'converted', convertedToSO: salesOrderId, convertedAt: new Date() } },
        { new: true, runValidators: true, session }
      );
      if (!quotation) throw routeError(409, 'Quotation status changed before conversion.');
      const orderStatus = ['pending', 'rejected'].includes(approval.approvalStatus) ? 'draft' : 'confirmed';
      [salesOrder] = await SalesOrder.create([{
        _id: salesOrderId,
        orderNumber: soNumber,
        branch: current.branch,
        orderDate: new Date(),
        dealer: current.dealer || undefined,
        dealerType: dealer?.dealerType?._id || priced.dealerType,
        dealerTypeSnapshot: dealer?.dealerType
          ? { name: dealer.dealerType.name, pricingTier: dealer.dealerType.pricingTier }
          : priced.dealerTypeSnapshot,
        dealerName: dealer?.businessName || current.customerName || '',
        dealerCode: dealer?.dealerCode || '',
        customerName: current.customerName || '',
        customerPhone: current.customerPhone || '',
        deliveryAddress: current.customerAddress || '',
        orderType: dealer ? (current.customerType || 'dealer') : 'retail',
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
        balanceAmount: priced.grandTotal,
        paymentStatus: 'pending',
        status: orderStatus,
        confirmationRequested: true,
        sourceQuotation: current._id,
        remarks: `Converted from ${current.quotationNumber}. ${current.remarks || ''}`.trim(),
        tallySyncStatus: 'not_synced',
        ...approval,
        createdBy: req.user._id,
      }], { session });
      if (salesOrder.status === 'confirmed') await reserveSalesOrderInventory(salesOrder, { session });
      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'sales_order',
        referenceModel: 'SalesOrder',
        referenceId: salesOrder._id,
        referenceNumber: salesOrder.orderNumber,
        title: `Sales Order ${salesOrder.orderNumber} requires approval`,
        reasons: salesOrder.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: salesOrder.grandTotal,
        document: salesOrder,
        session,
      });
      if (salesOrder.status === 'confirmed' && salesOrder.dealer && salesOrder.grandTotal > 0) {
        await postSubledgerEntry({
          session, branch: req.branchId, partyType: 'dealer', partyId: salesOrder.dealer,
          amount: salesOrder.grandTotal, side: 'debit', postingKey: `sales-order:${salesOrder._id}:confirmed`,
          entryType: 'invoice', entryDate: salesOrder.orderDate,
          description: `Receivable for Sales Order ${salesOrder.orderNumber}`,
          referenceNumber: salesOrder.orderNumber, referenceModel: 'SalesOrder', referenceId: salesOrder._id, createdBy: req.user._id,
        });
      }
    });
    return res.json(conversionSuccess(quotation, salesOrder, idempotent));
  } catch (error) {
    if (error.code === 11000) {
      const authoritativeQuotation = await Quotation.findOne({ _id: req.params.id, branch: req.branchId }).lean();
      const existingOrder = await findLinkedConvertedOrder(authoritativeQuotation, req.branchId);
      if (existingOrder) return res.json(conversionSuccess(authoritativeQuotation, existingOrder, true));
    }
    return res.status(error.status || (error.code === 11000 ? 409 : 500)).json({ success: false, message: error.message });
  }
  finally { await session.endSession(); }
});

router.delete('/:id', requirePermission('quotation.management'), async (req, res) => {
  try {
    const existing = await Quotation.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!existing) throw routeError(404, 'Quotation not found.');
    if (!['draft', 'cancelled'].includes(existing.status)) throw routeError(409, 'Only draft or cancelled quotations can be deleted.');
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Quotation, req.params.id, {
      user: req.user, module: 'quotation', titleField: 'dealerName', codeField: 'quotationNumber', scope: { branch: req.branchId },
    });
    return res.status(result.status || 200).json(result);
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

export default router;
