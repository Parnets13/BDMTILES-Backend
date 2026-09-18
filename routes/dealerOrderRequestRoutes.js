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
  orderRequestFingerprint,
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
      // Advisory delivery preference, same as the dealer app captures. Previously
      // dropped here, which made the field look empty for every SE-raised request.
      deliveryAddress: String(req.body?.deliveryAddress || '').trim().slice(0, 500),
      expectedDeliveryDate: req.body?.expectedDeliveryDate ? new Date(req.body.expectedDeliveryDate) : null,
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
    // Spread the Set rather than calling .map() on its iterator — iterator helpers
    // are Node 22+, and this route should not depend on the runtime version.
    const byStatus = Object.fromEntries([...VALID_STATUSES].map(status => [status, 0]));
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

// PATCH /:id — adjust what the dealer asked for before it becomes a quotation.
//
// A request carries demand only (no rates), so an edit can change quantities, add
// or drop products, and correct the advisory delivery details. Two rules keep the
// downstream contract intact:
//   1. Only 'submitted' or 'approved' requests can be edited. Once a quotation
//      exists the products and quantities are frozen by design (the quotation
//      routes assert against approvedFingerprint), and rejected/cancelled are
//      terminal.
//   2. Editing an already-approved request sends it back to 'submitted' and
//      clears the approval, because approvedFingerprint must always describe the
//      items as they were at the moment somebody approved them. Re-approving
//      re-freezes it.
router.patch('/:id', requirePermission('dealer.order_request.approve'), async (req, res) => {
  try {
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision) || revision < 0) throw routeError(422, 'A valid revision is required. Refresh the request and try again.');

    const current = await DealerOrderRequest.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!current) throw routeError(404, 'Dealer order request not found.');
    if (!['submitted', 'approved'].includes(current.status)) {
      throw routeError(409, `A request in "${current.status}" status can no longer be edited.`);
    }
    if (current.revision !== revision) throw routeError(409, 'Request changed since it was loaded. Refresh and try again.');

    const hasItems = Array.isArray(req.body?.items);
    const nextItems = hasItems
      ? await buildTrustedRequestItems(req.body.items)
      : current.items;

    // Describe the change in the dealer's terms, before we overwrite anything.
    const changes = [];
    if (hasItems) {
      const before = new Map(current.items.map(item => [String(item.product), item]));
      const after = new Map(nextItems.map(item => [String(item.product), item]));
      for (const [key, item] of after) {
        const previous = before.get(key);
        if (!previous) changes.push({ type: 'added', productName: item.productName, from: null, to: item.quantity });
        else if (Math.abs(Number(previous.quantity) - Number(item.quantity)) > 1e-6) {
          changes.push({ type: 'quantity', productName: item.productName, from: previous.quantity, to: item.quantity });
        }
      }
      for (const [key, item] of before) {
        if (!after.has(key)) changes.push({ type: 'removed', productName: item.productName, from: item.quantity, to: null });
      }
    }

    const set = {
      items: nextItems,
      requestFingerprint: orderRequestFingerprint(current.dealer, nextItems),
      editedAt: new Date(),
      editedBy: req.user._id,
    };
    if (req.body?.remarks !== undefined) set.remarks = String(req.body.remarks || '').trim().slice(0, 2000);
    if (req.body?.deliveryAddress !== undefined) set.deliveryAddress = String(req.body.deliveryAddress || '').trim().slice(0, 500);
    if (req.body?.expectedDeliveryDate !== undefined) {
      if (!req.body.expectedDeliveryDate) set.expectedDeliveryDate = null;
      else {
        const when = new Date(req.body.expectedDeliveryDate);
        if (Number.isNaN(when.getTime())) throw routeError(422, 'expectedDeliveryDate must be a valid date.');
        set.expectedDeliveryDate = when;
      }
    }
    // Send an approved request back for review so approvedFingerprint is never
    // left describing items that have since changed.
    if (current.status === 'approved') {
      set.status = 'submitted';
      set.approvedFingerprint = '';
      set.approvedBy = null;
      set.approvedAt = null;
      set.approvalRemarks = '';
    }

    const push = changes.length
      ? {
        editHistory: {
          at: new Date(),
          by: req.user._id,
          byName: req.user.name || '',
          reason: String(req.body?.reason || '').trim().slice(0, 500),
          changes,
        },
      }
      : undefined;

    const updated = await DealerOrderRequest.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, status: current.status, revision },
      { $set: set, $inc: { revision: 1 }, ...(push ? { $push: push } : {}) },
      { new: true, runValidators: true },
    );
    if (!updated) throw routeError(409, 'Request was changed by another user. Refresh the queue.');
    return res.json({
      success: true,
      message: current.status === 'approved'
        ? `Request ${updated.requestNumber} updated and sent back for review.`
        : `Request ${updated.requestNumber} updated.`,
      data: await populateRequest(DealerOrderRequest.findById(updated._id)).lean(),
    });
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
            // unit travels with the line: POST /quotations requires it, so a
            // caller that posts this prefill straight back must not have to
            // re-derive it from the product master.
            unit: item.unit,
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
