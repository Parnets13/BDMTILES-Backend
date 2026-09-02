import { Router } from 'express';
import mongoose from 'mongoose';
import Complaint from '../models/Complaint.js';
import ComplaintEvidence from '../models/ComplaintEvidence.js';
import Dealer from '../models/Dealer.js';
import SalesOrder from '../models/SalesOrder.js';
import Invoice from '../models/Invoice.js';
import SalesReturn from '../models/SalesReturn.js';
import User from '../models/User.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { getAccessPolicyScope } from '../services/accessPolicyService.js';
import { createNotificationEvent } from '../services/notificationService.js';
import { createAndPostComplaintSalesReturn, routeError } from '../services/salesReturnService.js';
import { uploadComplaintEvidence } from '../middleware/upload.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const WAREHOUSE_CONDITIONS = ['resaleable', 'damaged', 'scrap'];
const PRODUCT_CONDITIONS = ['intact', 'minor_damage', 'major_damage', 'broken', 'wrong_item', 'missing'];
const RECOMMENDATIONS = ['replace', 'credit_note', 'repair', 'reject_claim', 'partial_credit'];
const FINANCE_DECISIONS = ['approved', 'partial_approved', 'rejected', 'hold'];
const ADJUSTMENT_TYPES = ['credit_note', 'refund', 'replacement'];
const getComplaintScope = (req, resourceKey = '*') => getAccessPolicyScope({
  user: req.user,
  branchId: req.branchId,
  module: 'complaint',
  resourceKey,
});
const emitNotification = async (payload) => {
  try {
    await createNotificationEvent(payload);
  } catch (error) {
    console.error('Complaint notification error:', error.message);
  }
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const trimmed = (value) => String(value || '').trim();
const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const finiteNonNegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;

async function getCommittedReturnQuantities(invoiceId, branchId, options = {}) {
  let query = SalesReturn.find({
    branch: branchId,
    invoice: invoiceId,
    status: { $nin: ['cancelled', 'reversed'] },
  }).select('items').lean();
  if (options.session) query = query.session(options.session);
  const quantities = new Map();
  for (const salesReturn of await query) {
    for (const item of salesReturn.items || []) {
      if (!item.invoiceItem) continue;
      const key = String(item.invoiceItem);
      quantities.set(key, (quantities.get(key) || 0) + Number(item.returnQty || 0));
    }
  }
  return quantities;
}

async function getPendingComplaintQuantities(invoiceId, branchId, excludeId, options = {}) {
  let query = Complaint.find({
    branch: branchId,
    invoice: invoiceId,
    _id: { $ne: excludeId },
    status: { $in: ['warehouse_pending', 'warehouse_verified', 'finance_review'] },
    $or: [{ salesReturn: { $exists: false } }, { salesReturn: null }],
  }).select('products').lean();
  if (options.session) query = query.session(options.session);
  const quantities = new Map();
  for (const complaint of await query) {
    for (const item of complaint.products || []) {
      if (!item.invoiceItem) continue;
      const key = String(item.invoiceItem);
      quantities.set(key, (quantities.get(key) || 0) + Number(item.quantity || 0));
    }
  }
  return quantities;
}

const findAssignableUser = (userId, branchId) => User.findOne({
  _id: userId,
  status: 'Active',
  $or: [
    { assignedBranches: branchId },
    { role: { $in: ['super_admin', 'owner'] } },
  ],
}).select('name role').lean();

const populateComplaint = (query) => query
  .populate('dealer', 'businessName dealerCode mobile')
  .populate('assignedTo', 'name')
  .populate('salesReturn', 'returnNumber status adjustmentType grandTotal creditNoteNumber creditNoteDate approvalDate')
  .populate('purchaseReturn', 'debitNoteNumber status grandTotal')
  .populate('warehouseVerification.items.warehouse', 'name')
  .populate('resolutionHistory.resolvedBy', 'name');

const projectPostedReturn = (complaint) => {
  if (!complaint?.salesReturn?.status) return complaint;
  const issued = complaint.salesReturn.status === 'credit_issued' && Boolean(complaint.salesReturn.creditNoteNumber);
  return {
    ...complaint,
    creditNoteIssued: issued,
    creditNoteAmount: issued ? Number(complaint.salesReturn.grandTotal || 0) : 0,
    creditNoteNumber: issued ? complaint.salesReturn.creditNoteNumber : undefined,
  };
};

router.get('/', requirePermission('complaint.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority, category, dealer } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, parseInt(limit, 10) || 20);
    const filter = await getComplaintScope(req);
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ complaintNumber: regex }, { dealerName: regex }, { orderNumber: regex }, { invoiceNumber: regex }];
    }
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;
    if (dealer) filter.dealer = dealer;
    const [data, total] = await Promise.all([
      Complaint.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('assignedTo', 'name')
        .populate('salesReturn', 'status adjustmentType grandTotal creditNoteNumber')
        .lean(),
      Complaint.countDocuments(filter),
    ]);
    return res.json({ success: true, data: data.map(projectPostedReturn), pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/stats', requirePermission('complaint.management'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const [total, open, inProgress, resolved, closed, critical] = await Promise.all([
      Complaint.countDocuments(scope),
      Complaint.countDocuments({ ...scope, status: 'open' }),
      Complaint.countDocuments({ ...scope, status: 'in_progress' }),
      Complaint.countDocuments({ ...scope, status: 'resolved' }),
      Complaint.countDocuments({ ...scope, status: 'closed' }),
      Complaint.countDocuments({ ...scope, priority: 'critical', status: { $nin: ['resolved', 'closed', 'rejected'] } }),
    ]);
    return res.json({ success: true, data: { total, open, inProgress, resolved, closed, critical } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/pending-verification', requirePermission('warehouse.verification'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const complaints = await Complaint.find({ ...scope, status: 'warehouse_pending' })
      .sort({ priority: -1, createdAt: -1 }).populate('dealer', 'businessName').lean();
    return res.json({ success: true, data: complaints });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/pending-finance', requirePermission('finance.management'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const complaints = await Complaint.find({ ...scope, status: { $in: ['warehouse_verified', 'finance_review'] } })
      .sort({ priority: -1, createdAt: -1 })
      .populate('dealer', 'businessName')
      .populate('salesReturn', 'returnNumber status adjustmentType grandTotal creditNoteNumber')
      .lean();
    return res.json({ success: true, data: complaints.map(projectPostedReturn) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/evidence', requireAnyPermission('complaint.management', 'warehouse.verification'), (req, res) => {
  uploadComplaintEvidence(req, res, async (error) => {
    if (error) return res.status(400).json({ success: false, message: error.message });
    if (!req.files?.length) return res.status(400).json({ success: false, message: 'At least one evidence image is required.' });
    try {
      const documents = await ComplaintEvidence.insertMany(req.files.map((file) => ({
        branch: req.branchId,
        uploadedBy: req.user._id,
        url: `/uploads/complaints/${file.filename}`,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      })));
      const data = documents.map((evidence) => ({ id: evidence._id, url: evidence.url }));
      return res.json({ success: true, message: `${data.length} evidence image(s) uploaded.`, data });
    } catch (persistenceError) {
      return res.status(500).json({ success: false, message: `Evidence metadata could not be persisted: ${persistenceError.message}` });
    }
  });
});

router.get('/sources/dealer/:dealerId', requirePermission('complaint.management'), async (req, res) => {
  try {
    const invoices = await Invoice.find({
      branch: req.branchId,
      dealer: req.params.dealerId,
      status: { $in: ['generated', 'sent'] },
      invoiceType: 'tax_invoice',
      salesOrder: { $ne: null },
    }).select('invoiceNumber invoiceDate salesOrder orderNumber items status').sort({ invoiceDate: -1 }).limit(50).lean();
    const orders = await SalesOrder.find({
      _id: { $in: invoices.map((invoice) => invoice.salesOrder) },
      branch: req.branchId,
      dealer: req.params.dealerId,
      status: { $in: ['dispatched', 'delivered'] },
    }).select('_id').lean();
    const eligible = new Set(orders.map((order) => String(order._id)));
    const eligibleInvoices = invoices.filter((invoice) => eligible.has(String(invoice.salesOrder)));
    const data = [];
    for (const invoice of eligibleInvoices) {
      const committed = await getCommittedReturnQuantities(invoice._id, req.branchId);
      const items = (invoice.items || []).map((item) => ({
        ...item,
        remainingReturnQty: Math.max(0, Number(item.quantity || 0) - (committed.get(String(item._id)) || 0)),
      })).filter((item) => item.remainingReturnQty > 0);
      if (items.length > 0) data.push({ ...invoice, items });
    }
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.name === 'CastError' ? 'Invalid dealer identifier.' : error.message });
  }
});

router.get('/:id', requireAnyPermission('complaint.management', 'warehouse.verification', 'finance.management'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const complaint = await populateComplaint(Complaint.findOne({ _id: req.params.id, ...scope })).lean();
    if (!complaint) return res.status(404).json({ success: false, message: 'Complaint not found.' });
    return res.json({ success: true, data: projectPostedReturn(complaint) });
  } catch (error) {
    return res.status(error.name === 'CastError' ? 422 : 500).json({ success: false, message: error.name === 'CastError' ? 'Invalid complaint identifier.' : error.message });
  }
});

router.post('/', requirePermission('complaint.management'), async (req, res) => {
  try {
    const data = {
      branch: req.branchId,
      dealer: req.body.dealer,
      salesOrder: req.body.salesOrder,
      invoice: req.body.invoice,
      products: Array.isArray(req.body.products) ? req.body.products : [],
      category: req.body.category,
      description: trimmed(req.body.description),
      priority: req.body.priority,
      assignedTo: req.body.assignedTo,
      complaintPhotos: Array.isArray(req.body.complaintPhotos)
        ? req.body.complaintPhotos.map((photo) => ({ url: trimmed(photo?.url), caption: trimmed(photo?.caption) })).filter((photo) => photo.url)
        : [],
      status: 'open',
      requiresReturn: false,
      returnReceived: false,
      creditNoteIssued: false,
      creditNoteAmount: 0,
      createdBy: req.user._id,
      createdByName: req.user.name,
    };
    if (!data.description) throw routeError(422, 'Complaint description is required.');

    let order = null;
    let invoice = null;
    if (data.salesOrder) {
      order = await SalesOrder.findOne({ _id: data.salesOrder, branch: req.branchId }).select('orderNumber dealer dealerName status').lean();
      if (!order) throw routeError(422, 'Sales Order is not available in the selected branch.');
    }
    if (data.invoice) {
      invoice = await Invoice.findOne({
        _id: data.invoice,
        branch: req.branchId,
        status: { $in: ['generated', 'sent'] },
        invoiceType: 'tax_invoice',
      }).lean();
      if (!invoice) throw routeError(422, 'An active tax invoice is required in the selected branch.');
      if (!order && invoice.salesOrder) {
        order = await SalesOrder.findOne({ _id: invoice.salesOrder, branch: req.branchId, dealer: invoice.dealer })
          .select('orderNumber dealer dealerName status').lean();
      }
    }
    if (invoice && (!order || !['dispatched', 'delivered'].includes(order.status))) {
      throw routeError(422, 'Complaint returns require an invoiced, dispatched or delivered sales order.');
    }
    if (order && invoice?.salesOrder && String(invoice.salesOrder) !== String(order._id)) {
      throw routeError(422, 'Invoice does not belong to the supplied Sales Order.');
    }
    if (order?.dealer && invoice?.dealer && String(order.dealer) !== String(invoice.dealer)) {
      throw routeError(422, 'Sales Order and Invoice belong to different dealers.');
    }

    const linkedDealerId = order?.dealer || invoice?.dealer || null;
    if (data.dealer && linkedDealerId && String(data.dealer) !== String(linkedDealerId)) {
      throw routeError(422, 'Dealer does not match the linked Sales Order or Invoice.');
    }
    const dealerId = data.dealer || linkedDealerId;
    const dealer = dealerId ? await Dealer.findById(dealerId).select('businessName').lean() : null;
    if (dealerId && !dealer) throw routeError(422, 'Dealer not found.');

    if (data.products.length > 0) {
      if (!invoice) throw routeError(422, 'Complaint products require an authoritative sales invoice.');
      const invoiceLines = new Map((invoice.items || []).map((item) => [String(item._id), item]));
      const committed = await getCommittedReturnQuantities(invoice._id, req.branchId);
      const seen = new Set();
      data.products = data.products.map((item, index) => {
        const source = invoiceLines.get(String(item.invoiceItem || ''));
        const quantity = Number(item.quantity);
        const remainingQuantity = Number(source?.quantity || 0) - (committed.get(String(source?._id || '')) || 0);
        if (!source || !finitePositive(quantity) || quantity > remainingQuantity + 1e-9) {
          throw routeError(422, `products[${index}] requires a valid invoiceItem and quantity within its remaining returnable quantity.`);
        }
        if (seen.has(String(source._id))) throw routeError(422, 'Complaint products contain a duplicate invoice line.');
        seen.add(String(source._id));
        return {
          invoiceItem: source._id,
          product: source.product,
          productName: source.productName,
          productCode: source.productCode,
          productImage: source.productImage,
          quantity,
          shade: source.shade,
          batch: source.batch,
        };
      });
    }

    if (data.assignedTo) {
      const assignee = await findAssignableUser(data.assignedTo, req.branchId);
      if (!assignee) throw routeError(422, 'Assignee must be active and assigned to the selected branch.');
      data.assignedToName = assignee.name;
    } else {
      delete data.assignedTo;
    }
    if (order) {
      data.salesOrder = order._id;
      data.orderNumber = order.orderNumber;
    } else if (invoice?.salesOrder) {
      data.salesOrder = invoice.salesOrder;
      data.orderNumber = invoice.orderNumber;
    } else {
      delete data.salesOrder;
    }
    if (invoice) {
      data.invoice = invoice._id;
      data.invoiceNumber = invoice.invoiceNumber;
    } else {
      delete data.invoice;
    }
    if (dealerId) {
      data.dealer = dealerId;
      data.dealerName = dealer?.businessName || order?.dealerName || invoice?.buyerName || '';
    } else {
      delete data.dealer;
    }

    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    data.complaintNumber = await generateUniqueCode(Complaint, 'complaintNumber', 'CMP-', 5);
    const complaint = await Complaint.create(data);
    await emitNotification({
      branch: req.branchId,
      module: 'complaint',
      event: 'complaint_raised',
      eventKey: `complaint:${complaint._id}:raised`,
      title: `Complaint ${complaint.complaintNumber} raised`,
      body: `${complaint.dealerName || 'A customer'} raised a ${complaint.priority || 'normal'} priority complaint.`,
      deepLink: '/complaints/dashboard',
      data: { complaintId: complaint._id, complaintNumber: complaint.complaintNumber },
      actor: req.user._id,
      recipientUserIds: complaint.assignedTo ? [complaint.assignedTo] : [],
    });
    return res.status(201).json({ success: true, message: `Complaint ${complaint.complaintNumber} raised.`, data: complaint });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  }
});

router.patch('/:id/resolve', requirePermission('complaint.management'), async (_req, res) => res.status(405).json({
  success: false,
  message: 'Generic resolution is disabled. Use the warehouse and finance workflow commands.',
}));

router.patch('/:id/status', requirePermission('complaint.management'), async (req, res) => {
  try {
    const requestedStatus = trimmed(req.body.status);
    const allowedTransitions = { open: ['acknowledged', 'in_progress'], acknowledged: ['in_progress'] };
    const scope = await getComplaintScope(req);
    const complaint = await Complaint.findOne({ _id: req.params.id, ...scope });
    if (!complaint) return res.status(404).json({ success: false, message: 'Complaint not found.' });
    if (!allowedTransitions[complaint.status]?.includes(requestedStatus)) {
      return res.status(409).json({ success: false, message: 'That transition is not allowed. Use an explicit workflow command.' });
    }
    complaint.status = requestedStatus;
    if (hasOwn(req.body, 'assignedTo')) {
      if (req.body.assignedTo) {
        const assignee = await findAssignableUser(req.body.assignedTo, req.branchId);
        if (!assignee) throw routeError(422, 'Assignee must be active and assigned to the selected branch.');
        complaint.assignedTo = assignee._id;
        complaint.assignedToName = assignee.name;
      } else {
        complaint.assignedTo = undefined;
        complaint.assignedToName = '';
      }
    }
    complaint.resolutionHistory.push({
      action: `Complaint ${requestedStatus.replace(/_/g, ' ')}`,
      resolvedBy: req.user._id,
      resolvedByName: req.user.name,
      notes: trimmed(req.body.remarks),
    });
    await complaint.save();
    return res.json({ success: true, message: `Complaint moved to ${requestedStatus}.`, data: complaint });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.message });
  }
});

router.patch('/:id/send-to-warehouse', requirePermission('complaint.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let complaint;
    await session.withTransaction(async () => {
      const scope = await getComplaintScope(req);
      const current = await Complaint.findOne({
        _id: req.params.id,
        ...scope,
        status: { $in: ['open', 'acknowledged', 'in_progress'] },
      }).session(session);
      if (!current) throw routeError(404, 'Complaint not found or cannot be sent to warehouse.');
      if (!current.invoice || !current.salesOrder || !current.dealer || !current.products?.length
        || current.products.some((item) => !item.invoiceItem || !item.product || !finitePositive(item.quantity))) {
        throw routeError(422, 'Warehouse return verification requires exact invoice-linked complaint products.');
      }
      const [invoice, order, committed, pending] = await Promise.all([
        Invoice.findOne({
          _id: current.invoice,
          branch: req.branchId,
          dealer: current.dealer,
          status: { $in: ['generated', 'sent'] },
          invoiceType: 'tax_invoice',
        }).session(session).lean(),
        SalesOrder.findOne({
          _id: current.salesOrder,
          branch: req.branchId,
          dealer: current.dealer,
          status: { $in: ['dispatched', 'delivered'] },
        }).session(session).lean(),
        getCommittedReturnQuantities(current.invoice, req.branchId, { session }),
        getPendingComplaintQuantities(current.invoice, req.branchId, current._id, { session }),
      ]);
      if (!invoice || !order || String(invoice.salesOrder) !== String(order._id)) {
        throw routeError(422, 'The source must remain an active tax invoice for a dispatched or delivered order.');
      }
      const invoiceLines = new Map((invoice.items || []).map((item) => [String(item._id), item]));
      for (const item of current.products) {
        const key = String(item.invoiceItem);
        const source = invoiceLines.get(key);
        const remaining = Number(source?.quantity || 0) - (committed.get(key) || 0) - (pending.get(key) || 0);
        if (!source || Number(item.quantity || 0) > remaining + 1e-9) {
          throw routeError(409, 'One or more complaint lines no longer has sufficient uncommitted invoice quantity.');
        }
      }
      complaint = await Complaint.findOneAndUpdate(
        { _id: current._id, status: current.status, __v: current.__v },
        {
          $set: {
            status: 'warehouse_pending',
            requiresReturn: true,
            sentToWarehouseBy: req.user._id,
            sentToWarehouseByName: req.user.name,
            sentToWarehouseAt: new Date(),
          },
          $push: {
            resolutionHistory: {
              action: 'Sent to warehouse for return verification',
              resolvedBy: req.user._id,
              resolvedByName: req.user.name,
              notes: trimmed(req.body.remarks),
            },
          },
          $inc: { __v: 1 },
        },
        { new: true, runValidators: true, session }
      );
      if (!complaint) throw routeError(409, 'Complaint changed before warehouse handoff; refresh and retry.');
    });
    return res.json({ success: true, message: 'Sent to warehouse for verification.', data: complaint });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
});

router.patch('/:id/warehouse-verify', requirePermission('warehouse.verification'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const complaint = await Complaint.findOne({ _id: req.params.id, ...scope, status: 'warehouse_pending' });
    if (!complaint) return res.status(404).json({ success: false, message: 'Complaint not found or not pending warehouse verification.' });
    if (complaint.createdBy && String(complaint.createdBy) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Maker-checker violation: the complaint creator cannot verify its warehouse return.' });
    }
    if (complaint.sentToWarehouseBy && String(complaint.sentToWarehouseBy) === String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Maker-checker violation: the warehouse handoff maker cannot verify the same return.' });
    }

    const problemDescription = trimmed(req.body.problemDescription);
    const remarks = trimmed(req.body.remarks);
    const quantityReceived = Number(req.body.quantityReceived);
    const quantityDamaged = Number(req.body.quantityDamaged);
    const rawPhotos = Array.isArray(req.body.photos) ? req.body.photos : [];
    const evidenceIds = [...new Set(rawPhotos.map((photo) => trimmed(photo?.evidence)).filter(Boolean))];
    if (evidenceIds.length !== rawPhotos.length) {
      throw routeError(422, 'Every warehouse photo requires a unique uploaded evidence identifier.');
    }
    const evidenceRecords = await ComplaintEvidence.find({
      _id: { $in: evidenceIds },
      branch: req.branchId,
      uploadedBy: req.user._id,
      status: 'uploaded',
    }).lean();
    if (evidenceRecords.length !== evidenceIds.length) {
      throw routeError(422, 'Warehouse evidence must belong to the active branch and current verifier, and must not already be attached.');
    }
    const evidenceById = new Map(evidenceRecords.map((evidence) => [String(evidence._id), evidence]));
    const photos = rawPhotos.map((photo) => {
      const evidence = evidenceById.get(trimmed(photo.evidence));
      return { evidence: evidence._id, url: evidence.url, caption: trimmed(photo.caption) };
    });
    if (!problemDescription) throw routeError(422, 'A trimmed issue description is required.');
    if (!remarks) throw routeError(422, 'Warehouse remarks are required.');
    if (!finitePositive(quantityReceived)) throw routeError(422, 'Received quantity must be finite and greater than zero.');
    if (!finiteNonNegative(quantityDamaged) || quantityDamaged > quantityReceived) {
      throw routeError(422, 'Damaged quantity must be finite, non-negative, and no greater than received quantity.');
    }
    if (typeof req.body.problemConfirmed !== 'boolean') throw routeError(422, 'Problem confirmation must be explicit.');
    if (!PRODUCT_CONDITIONS.includes(req.body.productCondition)) throw routeError(422, 'An explicit valid product condition is required.');
    if (!RECOMMENDATIONS.includes(req.body.recommendation)) throw routeError(422, 'An explicit valid recommendation is required.');
    if (!['minor', 'moderate', 'major', 'critical'].includes(req.body.severity)) throw routeError(422, 'An explicit valid severity is required.');
    if (photos.length === 0) throw routeError(422, 'At least one persisted photo or evidence URL is required.');
    if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
      throw routeError(422, 'Exact invoice-linked warehouse verification items are required.');
    }

    const complaintItems = new Map((complaint.products || []).map((item) => [String(item.invoiceItem || ''), item]));
    const seen = new Set();
    const items = req.body.items.map((item, index) => {
      const key = String(item.invoiceItem || '');
      const source = complaintItems.get(key);
      const receivedQty = Number(item.receivedQty);
      const damagedQty = Number(item.damagedQty);
      const returnQty = Number(item.returnQty);
      if (!source || !key) throw routeError(422, `items[${index}] does not match an invoice-linked complaint item.`);
      if (seen.has(key)) throw routeError(422, 'Warehouse verification contains a duplicate invoice line.');
      seen.add(key);
      if (!finitePositive(receivedQty) || receivedQty > Number(source.quantity || 0) + 1e-9) {
        throw routeError(422, `items[${index}].receivedQty must be positive and within the complained quantity.`);
      }
      if (!finiteNonNegative(damagedQty) || damagedQty > receivedQty) {
        throw routeError(422, `items[${index}].damagedQty must be between zero and receivedQty.`);
      }
      if (!finitePositive(returnQty) || returnQty > receivedQty) {
        throw routeError(422, `items[${index}].returnQty must be positive and no greater than receivedQty.`);
      }
      if (!WAREHOUSE_CONDITIONS.includes(item.condition)) throw routeError(422, `items[${index}] requires an explicit valid stock condition.`);
      if (!item.warehouse) throw routeError(422, `items[${index}] requires an exact receiving warehouse.`);
      return {
        complaintItem: source._id,
        invoiceItem: source.invoiceItem,
        product: source.product,
        warehouse: item.warehouse,
        receivedQty,
        damagedQty,
        returnQty,
        condition: item.condition,
        remarks: trimmed(item.remarks),
      };
    });
    const receivedTotal = items.reduce((sum, item) => sum + item.receivedQty, 0);
    const damagedTotal = items.reduce((sum, item) => sum + item.damagedQty, 0);
    if (Math.abs(receivedTotal - quantityReceived) > 1e-9 || Math.abs(damagedTotal - quantityDamaged) > 1e-9) {
      throw routeError(422, 'Aggregate received and damaged quantities must equal the verified item totals.');
    }
    await assertWarehousesInBranch(items.map((item) => item.warehouse), req.branchId);

    const warehouseVerification = {
      verifiedBy: req.user._id,
      verifiedByName: req.user.name,
      verifiedAt: new Date(),
      problemConfirmed: req.body.problemConfirmed,
      problemDescription,
      severity: req.body.severity,
      photos,
      items,
      productCondition: req.body.productCondition,
      isResaleable: req.body.isResaleable === true,
      quantityReceived,
      quantityDamaged,
      recommendation: req.body.recommendation,
      recommendedAmount: 0,
      remarks,
    };
    const session = await mongoose.startSession();
    let updated;
    try {
      await session.withTransaction(async () => {
        const attachedAt = new Date();
        const evidenceUpdate = await ComplaintEvidence.updateMany(
          {
            _id: { $in: evidenceIds },
            branch: req.branchId,
            uploadedBy: req.user._id,
            status: 'uploaded',
          },
          { $set: { status: 'attached', complaint: complaint._id, attachedAt } },
          { session }
        );
        if (evidenceUpdate.modifiedCount !== evidenceIds.length) {
          throw routeError(409, 'One or more evidence images were already attached; upload fresh evidence and retry.');
        }
        updated = await Complaint.findOneAndUpdate(
          { _id: complaint._id, branch: req.branchId, status: 'warehouse_pending', __v: complaint.__v },
          {
            $set: { warehouseVerification, status: 'finance_review', returnReceived: true },
            $push: {
              resolutionHistory: {
                action: 'Warehouse verification completed; sent to finance review',
                resolvedBy: req.user._id,
                resolvedByName: req.user.name,
                notes: remarks,
              },
            },
            $inc: { __v: 1 },
          },
          { new: true, runValidators: true, session }
        );
        if (!updated) throw routeError(409, 'Complaint was already verified or changed; refresh the queue.');
      });
    } finally {
      await session.endSession();
    }
    return res.json({ success: true, message: 'Warehouse verification completed and sent to finance review.', data: updated });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.message });
  }
});

router.patch('/:id/finance-review', requirePermission('finance.management'), async (req, res) => {
  const decision = trimmed(req.body.decision);
  const adjustmentType = trimmed(req.body.adjustmentType);
  const remarks = trimmed(req.body.remarks);
  if (!FINANCE_DECISIONS.includes(decision)) {
    return res.status(422).json({ success: false, message: 'An explicit valid finance decision is required.' });
  }
  if (!remarks) return res.status(422).json({ success: false, message: 'Finance remarks are required.' });
  if (['approved', 'partial_approved'].includes(decision) && !ADJUSTMENT_TYPES.includes(adjustmentType)) {
    return res.status(422).json({ success: false, message: 'Approved outcomes require credit_note, refund, or replacement.' });
  }

  const session = await mongoose.startSession();
  try {
    let complaint;
    await session.withTransaction(async () => {
      const scope = await getComplaintScope(req);
      const current = await Complaint.findOne({
        _id: req.params.id,
        ...scope,
        status: { $in: ['warehouse_verified', 'finance_review'] },
      }).session(session);
      if (!current) throw routeError(404, 'Complaint not found or not pending finance review.');
      if (current.createdBy && String(current.createdBy) === String(req.user._id)) {
        throw routeError(403, 'Maker-checker violation: the complaint creator cannot perform finance review.');
      }
      if (current.warehouseVerification?.verifiedBy
        && String(current.warehouseVerification.verifiedBy) === String(req.user._id)) {
        throw routeError(403, 'Maker-checker violation: the warehouse verifier cannot perform finance review.');
      }

      let salesReturn = null;
      if (['approved', 'partial_approved'].includes(decision)) {
        salesReturn = await createAndPostComplaintSalesReturn({
          complaint: current,
          decision,
          adjustmentType,
          financeItems: req.body.items,
          approver: req.user._id,
          remarks,
          session,
        });
        current.salesReturn = salesReturn._id;
        current.status = salesReturn.status === 'credit_issued' ? 'resolved' : salesReturn.status;
        current.resolvedAt = salesReturn.status === 'credit_issued' ? new Date() : undefined;
        current.resolutionType = adjustmentType === 'replacement' ? 'replaced' : adjustmentType;
        current.creditNoteIssued = salesReturn.status === 'credit_issued' && Boolean(salesReturn.creditNoteNumber);
        current.creditNoteAmount = current.creditNoteIssued ? salesReturn.grandTotal : 0;
        current.creditNoteNumber = current.creditNoteIssued ? salesReturn.creditNoteNumber : undefined;
      } else if (decision === 'rejected') {
        current.status = 'rejected';
        current.resolvedAt = new Date();
        current.resolutionType = 'rejected';
        current.creditNoteIssued = false;
        current.creditNoteAmount = 0;
        current.creditNoteNumber = undefined;
      } else {
        current.status = 'finance_review';
        current.creditNoteIssued = false;
        current.creditNoteAmount = 0;
        current.creditNoteNumber = undefined;
      }

      current.accountantReview = {
        reviewedBy: req.user._id,
        reviewedByName: req.user.name,
        reviewedAt: new Date(),
        decision,
        approvedAmount: salesReturn?.grandTotal || 0,
        adjustmentType: salesReturn?.adjustmentType || 'no_action',
        remarks,
      };
      current.resolutionHistory.push({
        action: salesReturn
          ? `Finance ${decision}: posted Sales Return ${salesReturn.returnNumber} (${salesReturn.status})`
          : `Finance ${decision}`,
        resolvedBy: req.user._id,
        resolvedByName: req.user.name,
        notes: remarks,
      });
      await current.save({ session });
      complaint = current;
    });
    const populated = await populateComplaint(Complaint.findById(complaint._id)).lean();
    return res.json({
      success: true,
      message: decision === 'hold' ? 'Complaint remains on finance hold.' : `Finance decision ${decision} recorded.`,
      data: projectPostedReturn(populated),
    });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : 500);
    return res.status(status).json({ success: false, message: error.name === 'CastError' ? 'Invalid identifier.' : error.message });
  } finally {
    await session.endSession();
  }
});

export default router;
