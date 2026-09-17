import { Router } from 'express';
import DealerOrderRequest from '../models/DealerOrderRequest.js';
import Dealer from '../models/Dealer.js';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import Quotation from '../models/Quotation.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { assertIdempotentReplay, getIdempotencyContext } from '../utils/idempotency.js';
import {
  buildTrustedRequestItems,
  refreshAndFingerprintRequest,
} from '../services/dealerOrderRequestService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const VALID_STATUSES = new Set(['submitted', 'approved', 'rejected', 'quotation_linked', 'cancelled']);
const routeError = (status, message) => Object.assign(new Error(message), { status });
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errorStatus = error => error.status || (error.code === 11000 ? 409 : ['CastError', 'ValidationError'].includes(error.name) ? 422 : 500);

function listPagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit };
}

function populateRequest(query) {
  return query
    .populate('dealer', 'businessName dealerCode ownerName mobile city status dealerType')
    .populate('salesExecutive', 'name mobile email')
    .populate('approvedBy rejectedBy linkedBy', 'name')
    .populate('sourceQuotation', 'quotationNumber status grandTotal');
}

async function listRequests(req, res, ownerOnly) {
  try {
    const { page, limit } = listPagination(req.query);
    const filter = {
      branch: req.branchId,
      ...(ownerOnly ? { salesExecutive: req.user._id } : {}),
    };
    if (req.query.status) {
      if (!VALID_STATUSES.has(req.query.status)) throw routeError(422, 'Invalid request status.');
      filter.status = req.query.status;
    }
    if (req.query.dealer) filter.dealer = req.query.dealer;
    if (req.query.salesExecutive && !ownerOnly) filter.salesExecutive = req.query.salesExecutive;
    if (req.query.search && String(req.query.search).trim()) {
      const regex = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      filter.$or = [
        { requestNumber: regex },
        { 'dealerSnapshot.businessName': regex },
        { 'dealerSnapshot.dealerCode': regex },
        { salesExecutiveName: regex },
      ];
    }
    const [data, total] = await Promise.all([
      populateRequest(DealerOrderRequest.find(filter))
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      DealerOrderRequest.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
        hasMore: page * limit < total,
      },
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
}

router.get('/options/dealers', requirePermission('dealer.order_request.create'), async (req, res) => {
  try {
    const { page, limit } = listPagination(req.query);
    const filter = {
      assignedSalesExecutive: req.user._id,
      status: 'active',
    };
    if (req.query.search && String(req.query.search).trim()) {
      const regex = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      filter.$or = [
        { businessName: regex },
        { dealerCode: regex },
        { mobile: regex },
        { ownerName: regex },
        { city: regex },
      ];
    }
    const [data, total] = await Promise.all([
      Dealer.find(filter).sort({ businessName: 1, _id: 1 }).skip((page - 1) * limit).limit(limit)
        .select('businessName dealerCode ownerName mobile city status dealerType')
        .populate('dealerType', 'name pricingTier status').lean(),
      Dealer.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
        hasMore: page * limit < total,
      },
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/options/products', requirePermission('dealer.order_request.create'), async (req, res) => {
  try {
    const dealer = await Dealer.findOne({
      _id: req.query.dealer,
      assignedSalesExecutive: req.user._id,
      status: 'active',
    }).select('_id').lean();
    if (!dealer) throw routeError(404, 'Dealer not found, inactive, or not assigned to you.');

    const { page, limit } = listPagination(req.query);
    const filter = { status: 'active' };
    if (req.query.search && String(req.query.search).trim()) {
      const regex = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      filter.$or = [
        { itemName: regex },
        { productCode: regex },
        { aliasName: regex },
        { barcode: regex },
      ];
    }
    const [products, total] = await Promise.all([
      Product.find(filter).sort({ itemName: 1, _id: 1 }).skip((page - 1) * limit).limit(limit)
        .select('itemName productCode aliasName tileSize finish unit piecesPerBox sqftPerBox status').lean(),
      Product.countDocuments(filter),
    ]);
    const productIds = products.map(product => product._id);
    const stockRows = productIds.length ? await Stock.aggregate([
      { $match: { branch: req.branchId, product: { $in: productIds } } },
      { $group: { _id: '$product', stockAvailable: { $sum: '$availableQty' } } },
    ]) : [];
    const stockByProduct = new Map(stockRows.map(row => [String(row._id), Number(row.stockAvailable || 0)]));
    const data = products.map(product => ({
      ...product,
      stockAvailable: stockByProduct.get(String(product._id)) || 0,
    }));
    return res.json({
      success: true,
      data,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
        hasMore: page * limit < total,
      },
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.post('/', requirePermission('dealer.order_request.create'), async (req, res) => {
  let idempotency;
  try {
    if (req.user.role !== 'sales_executive') throw routeError(403, 'Only Sales Executives can submit dealer order requests.');
    idempotency = getIdempotencyContext(req);
    const existing = await DealerOrderRequest.findOne({ sourceKey: idempotency.sourceKey });
    if (existing) {
      assertIdempotentReplay(existing, idempotency.requestFingerprint);
      return res.json({ success: true, idempotent: true, message: 'Dealer order request already submitted.', data: existing });
    }

    const dealer = await Dealer.findOne({
      _id: req.body?.dealer,
      assignedSalesExecutive: req.user._id,
      status: 'active',
    }).lean();
    if (!dealer) throw routeError(404, 'Dealer not found, inactive, or not assigned to you.');

    const items = await buildTrustedRequestItems(req.body?.items);
    const request = await DealerOrderRequest.create({
      requestNumber: await generateBranchNumber(req.branchId, 'dealerOrderRequest'),
      branch: req.branchId,
      dealer: dealer._id,
      dealerSnapshot: {
        businessName: dealer.businessName,
        dealerCode: dealer.dealerCode || '',
        ownerName: dealer.ownerName || '',
        mobile: dealer.mobile || '',
        address: dealer.address || '',
        city: dealer.city || '',
      },
      salesExecutive: req.user._id,
      salesExecutiveName: req.user.name || '',
      items,
      remarks: String(req.body?.remarks || '').trim(),
      status: 'submitted',
      sourceKey: idempotency.sourceKey,
      requestFingerprint: idempotency.requestFingerprint,
      createdBy: req.user._id,
    });
    return res.status(201).json({ success: true, message: `Request ${request.requestNumber} submitted.`, data: request });
  } catch (error) {
    if (error.code === 11000 && idempotency?.sourceKey) {
      const existing = await DealerOrderRequest.findOne({ sourceKey: idempotency.sourceKey });
      if (existing) {
        try {
          assertIdempotentReplay(existing, idempotency.requestFingerprint);
          return res.json({ success: true, idempotent: true, message: 'Dealer order request already submitted.', data: existing });
        } catch (replayError) {
          return res.status(errorStatus(replayError)).json({ success: false, message: replayError.message });
        }
      }
    }
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/mine', requirePermission('dealer.order_request.create'), (req, res) => listRequests(req, res, true));

router.get('/mine/:id', requirePermission('dealer.order_request.create'), async (req, res) => {
  try {
    const request = await populateRequest(DealerOrderRequest.findOne({
      _id: req.params.id,
      branch: req.branchId,
      salesExecutive: req.user._id,
    })).lean();
    if (!request) throw routeError(404, 'Dealer order request not found.');
    return res.json({ success: true, data: request });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/stats', requirePermission('dealer.order_request.review'), async (req, res) => {
  try {
    const rows = await DealerOrderRequest.aggregate([
      { $match: { branch: req.branchId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = Object.fromEntries(VALID_STATUSES.values().map(status => [status, 0]));
    rows.forEach(row => { byStatus[row._id] = row.count; });
    return res.json({
      success: true,
      data: { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), ...byStatus },
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/', requirePermission('dealer.order_request.review'), (req, res) => listRequests(req, res, false));

router.post('/:id/approve', requirePermission('dealer.order_request.approve'), async (req, res) => {
  try {
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision) || revision < 0) throw routeError(422, 'A valid revision is required. Refresh the request and try again.');
    const current = await DealerOrderRequest.findOne({ _id: req.params.id, branch: req.branchId });
    if (!current) throw routeError(404, 'Dealer order request not found.');
    if (current.status !== 'submitted') throw routeError(409, `Request is already in "${current.status}" status.`);
    if (current.revision !== revision) throw routeError(409, 'Request changed since it was loaded. Refresh and try again.');

    const dealer = await Dealer.findOne({ _id: current.dealer, status: 'active' }).lean();
    if (!dealer) throw routeError(422, 'The request dealer is no longer active.');
    const refreshed = await refreshAndFingerprintRequest(current);
    const approved = await DealerOrderRequest.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, status: 'submitted', revision },
      {
        $set: {
          status: 'approved',
          items: refreshed.items,
          approvedFingerprint: refreshed.fingerprint,
          approvedBy: req.user._id,
          approvedAt: new Date(),
          approvalRemarks: String(req.body?.remarks || '').trim(),
        },
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true },
    );
    if (!approved) throw routeError(409, 'Request was already reviewed by another user. Refresh the queue.');
    return res.json({ success: true, message: `Request ${approved.requestNumber} approved.`, data: approved });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.post('/:id/reject', requirePermission('dealer.order_request.approve'), async (req, res) => {
  try {
    const revision = Number(req.body?.revision);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isInteger(revision) || revision < 0) throw routeError(422, 'A valid revision is required. Refresh the request and try again.');
    if (!reason) throw routeError(422, 'Rejection reason is required.');
    const rejected = await DealerOrderRequest.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'submitted', revision },
      {
        $set: { status: 'rejected', rejectedBy: req.user._id, rejectedAt: new Date(), rejectionReason: reason },
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true },
    );
    if (!rejected) throw routeError(409, 'Request is stale, missing, or already reviewed. Refresh the queue.');
    return res.json({ success: true, message: `Request ${rejected.requestNumber} rejected.`, data: rejected });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/:id/quotation-prefill', requirePermission('dealer.order_request.review'), async (req, res) => {
  try {
    const request = await DealerOrderRequest.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!request) throw routeError(404, 'Dealer order request not found.');
    if (request.status === 'quotation_linked' && request.sourceQuotation) {
      const quotation = await Quotation.findOne({
        _id: request.sourceQuotation,
        branch: req.branchId,
        sourceDealerOrderRequest: request._id,
      }).select('quotationNumber status grandTotal').lean();
      if (!quotation) throw routeError(409, 'Linked quotation could not be verified.');
      return res.json({ success: true, alreadyLinked: true, data: { request, quotation } });
    }
    if (request.status !== 'approved') throw routeError(409, 'Only approved requests can prefill a quotation.');
    const refreshed = await refreshAndFingerprintRequest(request);
    if (refreshed.fingerprint !== request.approvedFingerprint) throw routeError(409, 'Approved request details changed. Review the request again.');
    return res.json({
      success: true,
      data: {
        request: {
          _id: request._id,
          requestNumber: request.requestNumber,
          revision: request.revision,
          remarks: request.remarks,
        },
        quotation: {
          sourceDealerOrderRequest: request._id,
          dealer: request.dealer,
          customerType: 'dealer',
          items: refreshed.items.map(item => ({
            product: item.product,
            quantity: item.quantity,
            boxes: item.boxes,
            pieces: item.pieces,
            sqft: item.sqft,
          })),
          remarks: request.remarks,
        },
      },
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/:id', requirePermission('dealer.order_request.review'), async (req, res) => {
  try {
    const request = await populateRequest(DealerOrderRequest.findOne({ _id: req.params.id, branch: req.branchId })).lean();
    if (!request) throw routeError(404, 'Dealer order request not found.');
    return res.json({ success: true, data: request });
  } catch (error) {
    return res.status(errorStatus(error)).json({ success: false, message: error.message });
  }
});

export default router;
