import { Router } from 'express';
import mongoose from 'mongoose';
import SalesOrder from '../models/SalesOrder.js';
import Dealer from '../models/Dealer.js';
import DealerLedger from '../models/DealerLedger.js';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import DealerType from '../models/DealerType.js';
import { deriveOrderPricing, addCreditApproval } from '../services/orderPricingService.js';
import { resolvePricing } from '../services/pricingResolver.js';
import { releaseSalesOrderReservation } from '../utils/releaseSalesOrderReservation.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';
import { getIdempotencyContext, assertIdempotentReplay } from '../utils/idempotency.js';
import { syncAutomaticApprovalRequest, approvalExposureFingerprint } from '../services/approvalRequestService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const SALES_ORDER_STATUSES = new Set([
  'draft', 'confirmed', 'approved', 'processing', 'partial_dispatch',
  'dispatched', 'delivered', 'cancelled', 'expired',
]);
const USER_STATUS_TRANSITIONS = {
  draft: new Set(['confirmed', 'cancelled']), confirmed: new Set(['cancelled']),
  approved: new Set(['cancelled']), processing: new Set(['cancelled']),
  partial_dispatch: new Set([]), dispatched: new Set([]), delivered: new Set([]),
  cancelled: new Set([]), expired: new Set([]),
};
const SERVER_MANAGED_ORDER_FIELDS = new Set([
  'orderNumber', 'branch', 'legacyBranch', 'createdBy', 'status', 'paymentStatus',
  'subtotal', 'totalDiscount', 'totalSchemeDiscount', 'totalTax', 'roundOff', 'grandTotal', 'balanceAmount',
  'dealerTypeSnapshot', 'dealerName', 'dealerCode', 'creditLimitExceeded', 'approvalStatus', 'approvalReasons',
  'approvedBy', 'approvalDate', 'approvalRemarks', 'sourceQuotation', 'sourceKey', 'requestFingerprint', 'cancellationReason', 'modificationLogs',
  'tallySyncStatus', 'tallyVoucherNumber', 'tallyGUID', 'tallySyncDate', 'tallySyncError',
  'createdAt', 'updatedAt', '_id', '__v',
]);
const validationError = (message) => Object.assign(new Error(message), { status: 422 });
function withoutServerManagedFields(body = {}) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SERVER_MANAGED_ORDER_FIELDS.has(key)));
}
async function findDealer(dealerId, session = null) {
  if (!dealerId || !mongoose.isValidObjectId(dealerId)) return null;
  let query = Dealer.findById(dealerId).populate('dealerType', 'name pricingTier status');
  if (session) query = query.session(session);
  const dealer = await query.lean();
  if (dealer && dealer.status !== 'active') throw validationError('Dealer is not active.');
  if (dealer?.dealerType && dealer.dealerType.status !== 'active') throw validationError('DealerType is not active.');
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
function pricingContext(data, dealer) {
  if (dealer) {
    return {
      dealerId: dealer._id,
      dealerTypeId: dealer.dealerType?._id,
      scope: 'dealer',
      orderType: data.orderType || 'dealer',
    };
  }
  if (data.dealerType) {
    return { dealerTypeId: data.dealerType, scope: 'dealer_type', orderType: data.orderType || 'retail' };
  }
  return { scope: 'walk_in', orderType: data.orderType === 'online' ? 'online' : 'retail' };
}
async function authoritativeOrderData(data, dealer, branchOutstanding, branchId, session, existingReasons = []) {
  const context = pricingContext(data, dealer);
  const priced = await deriveOrderPricing({
    branchId, ...context, pricingDate: data.orderDate || new Date(), items: data.items,
    freightCharges: data.freightCharges, loadingCharges: data.loadingCharges,
    installationCharges: data.installationCharges, otherCharges: data.otherCharges,
    advanceAmount: data.advanceAmount, existingApprovalReasons: existingReasons,
    preserveBelowMinimumApprovals: existingReasons.length > 0, session,
  });
  const credit = addCreditApproval(priced, dealer, branchOutstanding, existingReasons, {
    preserveBelowMinimum: existingReasons.length > 0,
  });
  return {
    ...priced,
    dealerType: dealer?.dealerType?._id || priced.dealerType,
    dealerTypeSnapshot: dealer?.dealerType
      ? { name: dealer.dealerType.name, pricingTier: dealer.dealerType.pricingTier }
      : priced.dealerTypeSnapshot,
    ...credit,
    resolutions: undefined,
  };
}

router.get('/', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealer, paymentStatus, dateFrom, dateTo, salesExecutive } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Number.parseInt(limit, 10) || 20);
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ orderNumber: regex }, { dealerName: regex }, { dealerCode: regex }];
    }
    if (status) filter.status = status;
    if (dealer) filter.dealer = dealer;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (salesExecutive) filter.salesExecutive = salesExecutive;
    if (dateFrom || dateTo) {
      filter.orderDate = {};
      if (dateFrom) filter.orderDate.$gte = new Date(dateFrom);
      if (dateTo) filter.orderDate.$lte = new Date(dateTo);
    }
    const [orders, total] = await Promise.all([
      SalesOrder.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode mobile city').populate('dealerType', 'name pricingTier')
        .populate('salesExecutive', 'name').lean(),
      SalesOrder.countDocuments(filter),
    ]);
    return res.json({ success: true, data: orders, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.get('/stats', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, draft, confirmed, processing, dispatched, delivered, cancelled] = await Promise.all([
      SalesOrder.countDocuments(scope), SalesOrder.countDocuments({ ...scope, status: 'draft' }),
      SalesOrder.countDocuments({ ...scope, status: 'confirmed' }), SalesOrder.countDocuments({ ...scope, status: 'processing' }),
      SalesOrder.countDocuments({ ...scope, status: 'dispatched' }), SalesOrder.countDocuments({ ...scope, status: 'delivered' }),
      SalesOrder.countDocuments({ ...scope, status: 'cancelled' }),
    ]);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayOrders = await SalesOrder.aggregate([
      { $match: { ...scope, orderDate: { $gte: today }, status: { $nin: ['cancelled', 'draft'] } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    ]);
    return res.json({ success: true, data: { total, draft, confirmed, processing, dispatched, delivered, cancelled, todaySales: todayOrders[0]?.total || 0, todayCount: todayOrders[0]?.count || 0 } });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.get('/search-dealers', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { q, page = 1, limit = 20, pricingTier, dealerTypeId } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Number.parseInt(limit, 10) || 20);
    const filter = { status: 'active' };
    if (q && q.length >= 2) {
      const regex = new RegExp(q, 'i');
      filter.$or = [{ businessName: regex }, { dealerCode: regex }, { mobile: regex }, { ownerName: regex }];
    }
    if (dealerTypeId) {
      if (!mongoose.isValidObjectId(dealerTypeId)) throw validationError('dealerTypeId is invalid.');
      filter.dealerType = dealerTypeId;
    } else if (pricingTier) {
      const matchingTypes = await DealerType.find({ pricingTier, status: 'active' }).select('_id').lean();
      if (!matchingTypes.length) return res.json({ success: true, data: [] });
      filter.dealerType = { $in: matchingTypes.map((type) => type._id) };
    }
    const dealers = await Dealer.find(filter).sort({ businessName: 1 }).skip((p - 1) * l).limit(l)
      .select('businessName dealerCode ownerName mobile city creditLimit creditDays currentOutstanding priceTier dealerType')
      .populate('dealerType', 'name pricingTier').lean();
    return res.json({ success: true, data: dealers });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.get('/search-products', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const { q, brand, category, subcategory, page = 1, limit = 20, dealerId, dealerTypeId, scope } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(50, Number.parseInt(limit, 10) || 20);
    const filter = { status: 'active' };
    if (q && q.length >= 2) {
      const regex = new RegExp(q, 'i');
      filter.$or = [{ itemName: regex }, { productCode: regex }, { aliasName: regex }, { barcode: regex }];
    }
    if (brand) filter.brand = brand;
    if (category) filter.category = category;
    if (subcategory) filter.subcategory = subcategory;
    const products = await Product.find(filter).sort({ itemName: 1 }).skip((p - 1) * l).limit(l)
      .select('productCode itemName tileSize finish colour unit mrp dealerRate wholesaleRate retailRate distributorRate builderRate projectRate minimumSellingRate gst piecesPerBox sqftPerBox images brand category subcategory status')
      .populate('brand', 'name').populate('category', 'name').populate('subcategory', 'name').lean();
    const productIds = products.map((product) => product._id);
    const stockData = await Stock.aggregate([
      { $match: { branch: req.branchId, product: { $in: productIds } } },
      { $group: { _id: '$product', availableQty: { $sum: '$availableQty' } } },
    ]);
    const stockMap = new Map(stockData.map((row) => [String(row._id), row.availableQty]));
    const quantity = req.query.quantity || 1;
    const legacyOrderType = req.query.dealerType && !mongoose.isValidObjectId(req.query.dealerType)
      ? req.query.dealerType : undefined;
    const inferredScope = scope || (dealerId ? 'dealer' : dealerTypeId ? 'dealer_type' : 'walk_in');
    const data = await Promise.all(products.map(async (product) => {
      const pricing = await resolvePricing({
        branchId: req.branchId, dealerId, dealerTypeId, scope: inferredScope, product,
        quantity, pricingDate: req.query.date || new Date(), orderAmount: req.query.orderAmount,
        orderType: legacyOrderType || (inferredScope === 'walk_in' ? 'retail' : 'dealer'),
      });
      return {
        ...product,
        stockAvailable: stockMap.get(String(product._id)) || 0,
        baseTier: pricing.requestedTier,
        rateField: pricing.rateField,
        baseRate: pricing.baseRate,
        effectiveRate: pricing.effectiveRate,
        minimumSellingRate: pricing.minimumSellingRate,
        belowMinimum: pricing.belowMinimum,
        pricingSource: pricing.source,
        overrideScope: pricing.overrideScope,
        discount: {
          regularPerUnit: pricing.regularDiscountPerUnit,
          schemePerUnit: pricing.schemeDiscountPerUnit,
          rule: pricing.rule,
        },
      };
    }));
    return res.json({ success: true, data });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

router.post('/price-preview', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const data = withoutServerManagedFields(req.body);
    const dealer = data.dealer ? await findDealer(data.dealer) : null;
    if (data.dealer && !dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });
    if (!dealer && !data.customerName) throw validationError('customerName is required for walk-in sales.');
    const outstanding = dealer ? await getBranchOutstanding(req.branchId, dealer._id) : 0;
    const priced = await authoritativeOrderData(data, dealer, outstanding, req.branchId, null, []);
    return res.json({ success: true, data: priced });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
});

router.get('/:id', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const order = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode mobile city creditLimit creditDays currentOutstanding gstin address')
      .populate('dealerType', 'name pricingTier').populate('salesExecutive', 'name phone')
      .populate('items.product', 'productCode itemName tileSize finish unit').populate('items.warehouse', 'name').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    return res.json({ success: true, data: order });
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

router.post('/', requirePermission('sales.order.create'), async (req, res) => {
  const session = await mongoose.startSession();
  let idempotency;
  try {
    idempotency = getIdempotencyContext(req);
    const existingOrder = await SalesOrder.findOne({ branch: req.branchId, sourceKey: idempotency.sourceKey });
    if (existingOrder) {
      assertIdempotentReplay(existingOrder, idempotency.requestFingerprint);
      return res.json({ success: true, message: 'Sales Order already created.', data: existingOrder });
    }
    const requestedStatus = req.body.status ?? 'draft';
    if (!['draft', 'confirmed'].includes(requestedStatus)) throw validationError('Sales orders can only be created as draft or confirmed.');
    const data = withoutServerManagedFields(req.body);
    if (data.orderType === 'walk_in') data.orderType = 'retail';
    data.branch = req.branchId; data.createdBy = req.user._id; data.tallySyncStatus = 'not_synced';
    data.sourceKey = idempotency.sourceKey; data.requestFingerprint = idempotency.requestFingerprint;
    data.orderNumber = await generateBranchNumber(req.branchId, 'salesOrder', data.orderDate || new Date());
    let order;
    let forcedPendingDraft = false;
    await session.withTransaction(async () => {
      await assertWarehousesInBranch((data.items || []).map((item) => item.warehouse), req.branchId, { session });
      const dealer = data.dealer ? await findDealer(data.dealer, session) : null;
      if (data.dealer && !dealer) throw Object.assign(new Error('Dealer not found.'), { status: 404 });
      if (!dealer && !data.customerName) throw validationError('customerName is required for walk-in sales.');
      const outstanding = dealer ? await getBranchOutstanding(req.branchId, dealer._id, session) : 0;
      const authoritative = await authoritativeOrderData(data, dealer, outstanding, req.branchId, session, []);
      Object.assign(data, authoritative, {
        dealerName: dealer?.businessName || '', dealerCode: dealer?.dealerCode || '',
      });
      forcedPendingDraft = requestedStatus === 'confirmed' && ['pending', 'rejected'].includes(data.approvalStatus);
      data.status = forcedPendingDraft ? 'draft' : requestedStatus;
      [order] = await SalesOrder.create([data], { session });
      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'sales_order',
        referenceModel: 'SalesOrder',
        referenceId: order._id,
        referenceNumber: order.orderNumber,
        title: `Sales Order ${order.orderNumber} requires approval`,
        reasons: order.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: order.grandTotal,
        document: order,
        session,
      });
      if (order.status === 'confirmed' && order.approvalStatus !== 'pending' && order.approvalStatus !== 'rejected' && order.dealer && order.grandTotal > 0) {
        await postSubledgerEntry({
          session, branch: req.branchId, partyType: 'dealer', partyId: order.dealer,
          amount: order.grandTotal, side: 'debit', postingKey: `sales-order:${order._id}:confirmed`,
          entryType: 'invoice', entryDate: order.orderDate,
          description: `Receivable for Sales Order ${order.orderNumber}`,
          referenceNumber: order.orderNumber, referenceModel: 'SalesOrder', referenceId: order._id, createdBy: req.user._id,
        });
      }
    });
    return res.status(201).json({
      success: true,
      message: forcedPendingDraft ? 'Sales Order created as draft pending approval.' : 'Sales Order created.',
      data: order,
    });
  } catch (error) {
    if (error.code === 11000 && idempotency?.sourceKey) {
      const replay = await SalesOrder.findOne({ branch: req.branchId, sourceKey: idempotency.sourceKey });
      if (replay) {
        if (replay.requestFingerprint && replay.requestFingerprint !== idempotency.requestFingerprint) {
          return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different request payload.' });
        }
        return res.json({ success: true, message: 'Sales Order already created.', data: replay });
      }
    }
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'Order number exists.' });
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message });
  } finally { await session.endSession(); }
});

router.put('/:id', requirePermission('sales.order.create'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      order = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (order.status !== 'draft') throw Object.assign(new Error(`Cannot edit financial details in "${order.status}" status.`), { status: 409 });
      const editable = withoutServerManagedFields(req.body);
      if (editable.orderType === 'walk_in') editable.orderType = 'retail';
      const candidate = { ...order.toObject(), ...editable };
      await assertWarehousesInBranch((candidate.items || []).map((item) => item.warehouse), req.branchId, { session });
      const dealer = candidate.dealer ? await findDealer(candidate.dealer, session) : null;
      if (candidate.dealer && !dealer) throw Object.assign(new Error('Dealer not found.'), { status: 404 });
      if (!dealer && !candidate.customerName) throw validationError('customerName is required for walk-in sales.');
      const previousExposure = approvalExposureFingerprint(order);
      const outstanding = dealer ? await getBranchOutstanding(req.branchId, dealer._id, session) : 0;
      const authoritative = await authoritativeOrderData(candidate, dealer, outstanding, req.branchId, session, order.approvalReasons || []);
      const nextExposure = approvalExposureFingerprint({ ...candidate, ...authoritative });
      if (previousExposure !== nextExposure && authoritative.approvalReasons.length) {
        authoritative.approvalReasons = authoritative.approvalReasons.map((reason) => ({ ...reason, status: 'pending' }));
        authoritative.approvalStatus = 'pending';
      }
      const updateData = {
        ...editable, ...authoritative,
        dealerName: dealer?.businessName || '', dealerCode: dealer?.dealerCode || '',
      };
      const changes = [];
      for (const [key, newValue] of Object.entries(updateData)) {
        const oldValue = order.get(key);
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes.push({ field: key, oldValue, newValue, changedBy: req.user._id, changedAt: new Date() });
        }
      }
      Object.assign(order, updateData);
      if (changes.length) order.modificationLogs.push(...changes);
      if (order.tallySyncStatus === 'synced') order.tallySyncStatus = 'pending';
      await order.save({ session });
      await syncAutomaticApprovalRequest({
        branchId: req.branchId,
        type: 'sales_order',
        referenceModel: 'SalesOrder',
        referenceId: order._id,
        referenceNumber: order.orderNumber,
        title: `Sales Order ${order.orderNumber} requires approval`,
        reasons: order.approvalReasons || [],
        requestedBy: req.user._id,
        requestedByName: req.user.name || '',
        requestedValue: order.grandTotal,
        document: order,
        session,
      });
    });
    return res.json({ success: true, message: 'Order updated.', data: order });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.patch('/:id/status', requirePermission('sales.order.dashboard'), async (req, res) => {
  const { status, cancellationReason } = req.body;
  if (!SALES_ORDER_STATUSES.has(status)) return res.status(422).json({ success: false, message: 'Unknown sales order status.' });
  const session = await mongoose.startSession();
  try {
    let order;
    let alreadyUpdated = false;
    await session.withTransaction(async () => {
      const current = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw Object.assign(new Error('Order not found.'), { status: 404 });
      if (current.status === status) { order = current; alreadyUpdated = true; return; }
      if (!USER_STATUS_TRANSITIONS[current.status]?.has(status)) {
        throw Object.assign(new Error(`Cannot change Sales Order from "${current.status}" to "${status}" manually. Warehouse and delivery transitions are system-managed.`), { status: 409 });
      }
      if (status === 'confirmed' && ['pending', 'rejected'].includes(current.approvalStatus)) {
        throw Object.assign(new Error(`Sales Order cannot be confirmed while approval is ${current.approvalStatus}.`), { status: 409 });
      }
      const oldStatus = current.status;
      if (status === 'cancelled') await releaseSalesOrderReservation(current._id, { session });
      const setFields = { status };
      if (status === 'cancelled') setFields.cancellationReason = cancellationReason || '';
      if (current.tallySyncStatus === 'synced') setFields.tallySyncStatus = 'pending';
      order = await SalesOrder.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: oldStatus },
        { $set: setFields, $push: { modificationLogs: { field: 'status', oldValue: oldStatus, newValue: status, changedBy: req.user._id, changedAt: new Date(), reason: status === 'cancelled' ? cancellationReason : undefined } } },
        { new: true, runValidators: true, session }
      );
      if (!order) throw Object.assign(new Error('Sales Order status changed before the update could be applied.'), { status: 409 });
      if (status === 'cancelled') {
        await syncAutomaticApprovalRequest({
          branchId: req.branchId,
          type: 'sales_order',
          referenceModel: 'SalesOrder',
          referenceId: order._id,
          reasons: [],
          session,
        });
      }
      if (status === 'confirmed' && order.dealer && order.grandTotal > 0) {
        await postSubledgerEntry({
          session, branch: req.branchId, partyType: 'dealer', partyId: order.dealer,
          amount: order.grandTotal, side: 'debit', postingKey: `sales-order:${order._id}:confirmed`,
          entryType: 'invoice', entryDate: order.orderDate,
          description: `Receivable for Sales Order ${order.orderNumber}`,
          referenceNumber: order.orderNumber, referenceModel: 'SalesOrder', referenceId: order._id, createdBy: req.user._id,
        });
      }
      if (status === 'cancelled' && order.dealer) {
        const originalPostingKey = `sales-order:${order._id}:confirmed`;
        const originalPosting = await DealerLedger.findOne({ branch: req.branchId, dealer: order.dealer, postingKey: originalPostingKey }).session(session).select('_id').lean();
        if (originalPosting) {
          await postSubledgerEntry({
            session, branch: req.branchId, partyType: 'dealer', partyId: order.dealer,
            postingKey: `sales-order:${order._id}:cancelled`, reversalOfPostingKey: originalPostingKey,
            entryType: 'credit_note', entryDate: new Date(),
            description: `Cancellation reversal for Sales Order ${order.orderNumber}`,
            referenceNumber: order.orderNumber, referenceModel: 'SalesOrder', referenceId: order._id, createdBy: req.user._id,
          });
        }
      }
    });
    return res.json({ success: true, message: alreadyUpdated ? `Order is already in "${status}" status.` : `Order status updated to "${status}".`, data: order });
  } catch (error) { return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
});

router.delete('/:id', requirePermission('sales.order.create'), async (req, res) => {
  try {
    const existing = await SalesOrder.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Order not found.' });
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(SalesOrder, req.params.id, {
      user: req.user, module: 'sales_order', titleField: 'dealerName', codeField: 'orderNumber', scope: { branch: req.branchId },
    });
    return res.status(result.status || 200).json(result);
  } catch (error) { return res.status(500).json({ success: false, message: error.message }); }
});

export default router;
