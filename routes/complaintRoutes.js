import { Router } from 'express';
import Complaint from '../models/Complaint.js';
import Dealer from '../models/Dealer.js';
import SalesOrder from '../models/SalesOrder.js';
import Invoice from '../models/Invoice.js';
import User from '../models/User.js';
import { protect, requirePermission, requireAnyPermission, getDataAccessFilter } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const getComplaintScope = (req) => getDataAccessFilter(req.user, 'complaint', req.branchId);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const findAssignableUser = (userId, branchId) => User.findOne({
  _id: userId,
  status: 'Active',
  $or: [
    { assignedBranches: branchId },
    { role: { $in: ['super_admin', 'owner'] } },
  ],
}).select('name role').lean();

// GET /api/v1/complaints
router.get('/', requirePermission('complaint.management'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority, category, dealer } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    const filter = await getComplaintScope(req);
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ complaintNumber: r }, { dealerName: r }, { orderNumber: r }, { invoiceNumber: r }];
    }
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;
    if (dealer) filter.dealer = dealer;

    const [data, total] = await Promise.all([
      Complaint.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('assignedTo', 'name').lean(),
      Complaint.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/complaints/stats
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
    res.json({ success: true, data: { total, open, inProgress, resolved, closed, critical } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/complaints/pending-verification — warehouse pending items (MUST be before /:id)
router.get('/pending-verification', requirePermission('stock.adjustment'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const complaints = await Complaint.find({ ...scope, status: 'warehouse_pending' })
      .sort({ priority: -1, createdAt: -1 }).populate('dealer', 'businessName').lean();
    res.json({ success: true, data: complaints });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/complaints/pending-finance — finance pending items (MUST be before /:id)
router.get('/pending-finance', requirePermission('finance.management'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const complaints = await Complaint.find({ ...scope, status: { $in: ['warehouse_verified', 'finance_review'] } })
      .sort({ priority: -1, createdAt: -1 }).populate('dealer', 'businessName').lean();
    res.json({ success: true, data: complaints });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/complaints/:id
router.get('/:id', requireAnyPermission('complaint.management', 'stock.adjustment', 'finance.management'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const c = await Complaint.findOne({ _id: req.params.id, ...scope })
      .populate('dealer', 'businessName dealerCode mobile')
      .populate('assignedTo', 'name')
      .populate('resolutionHistory.resolvedBy', 'name').lean();
    if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/complaints — create
router.post('/', requirePermission('complaint.management'), async (req, res) => {
  try {
    const data = {
      ...req.body,
      branch: req.branchId,
      createdBy: req.user._id,
      createdByName: req.user.name,
    };
    delete data.complaintNumber;

    let order = null;
    let invoice = null;
    if (data.salesOrder) {
      order = await SalesOrder.findOne({ _id: data.salesOrder, branch: req.branchId })
        .select('orderNumber dealer dealerName').lean();
      if (!order) {
        return res.status(422).json({ success: false, message: 'Sales Order is not available in the selected branch.' });
      }
    }
    if (data.invoice) {
      invoice = await Invoice.findOne({ _id: data.invoice, branch: req.branchId })
        .select('invoiceNumber salesOrder orderNumber dealer buyerName').lean();
      if (!invoice) {
        return res.status(422).json({ success: false, message: 'Invoice is not available in the selected branch.' });
      }
    }

    if (order && invoice?.salesOrder && String(invoice.salesOrder) !== String(order._id)) {
      return res.status(422).json({ success: false, message: 'Invoice does not belong to the supplied Sales Order.' });
    }
    if (order && invoice?.orderNumber && invoice.orderNumber !== order.orderNumber) {
      return res.status(422).json({ success: false, message: 'Invoice order does not match the supplied Sales Order.' });
    }
    if (order?.dealer && invoice?.dealer && String(order.dealer) !== String(invoice.dealer)) {
      return res.status(422).json({ success: false, message: 'Sales Order and Invoice belong to different dealers.' });
    }

    const linkedDealerId = order?.dealer || invoice?.dealer || null;
    if (data.dealer && linkedDealerId && String(data.dealer) !== String(linkedDealerId)) {
      return res.status(422).json({ success: false, message: 'Dealer does not match the linked Sales Order or Invoice.' });
    }

    const dealerId = data.dealer || linkedDealerId;
    let dealer = null;
    if (dealerId) {
      dealer = await Dealer.findById(dealerId).select('businessName').lean();
      if (!dealer) return res.status(422).json({ success: false, message: 'Dealer not found.' });
    }

    if (data.assignedTo) {
      const assignee = await findAssignableUser(data.assignedTo, req.branchId);
      if (!assignee) {
        return res.status(422).json({ success: false, message: 'Assignee must be active and assigned to the selected branch.' });
      }
      data.assignedToName = assignee.name;
    } else {
      delete data.assignedTo;
      delete data.assignedToName;
    }

    if (order) {
      data.salesOrder = order._id;
      data.orderNumber = order.orderNumber;
    } else if (invoice?.salesOrder) {
      data.salesOrder = invoice.salesOrder;
      data.orderNumber = invoice.orderNumber;
    } else {
      delete data.orderNumber;
    }
    if (invoice) {
      data.invoice = invoice._id;
      data.invoiceNumber = invoice.invoiceNumber;
    } else {
      delete data.invoiceNumber;
    }
    if (dealerId) {
      data.dealer = dealerId;
      data.dealerName = dealer?.businessName || order?.dealerName || invoice?.buyerName || '';
    } else {
      delete data.dealerName;
    }

    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    data.complaintNumber = await generateUniqueCode(Complaint, 'complaintNumber', 'CMP-', 5);

    const complaint = await Complaint.create(data);
    res.status(201).json({ success: true, message: `Complaint ${complaint.complaintNumber} raised.`, data: complaint });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/complaints/:id/resolve — add resolution step
router.patch('/:id/resolve', requirePermission('complaint.management'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const c = await Complaint.findOne({
      _id: req.params.id,
      ...scope,
      status: { $nin: ['closed', 'rejected'] },
    });
    if (!c) return res.status(404).json({ success: false, message: 'Not found or complaint is already closed.' });
    c.resolutionHistory.push({
      ...req.body,
      resolvedBy: req.user._id,
      resolvedByName: req.user.name,
    });
    c.status = req.body.closeComplaint ? 'closed' : 'resolved';
    c.resolutionNotes = req.body.notes;
    c.resolvedAt = new Date();
    if (req.body.creditNoteAmount) {
      c.creditNoteIssued = true;
      c.creditNoteAmount = req.body.creditNoteAmount;
    }
    await c.save();
    res.json({ success: true, message: 'Resolution recorded.', data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/complaints/:id/status
router.patch('/:id/status', requirePermission('complaint.management'), async (req, res) => {
  try {
    if (!req.body.status) return res.status(400).json({ success: false, message: 'Status is required.' });
    const scope = await getComplaintScope(req);
    const update = { status: req.body.status };

    if (hasOwn(req.body, 'assignedTo')) {
      if (req.body.assignedTo) {
        const assignee = await findAssignableUser(req.body.assignedTo, req.branchId);
        if (!assignee) {
          return res.status(422).json({ success: false, message: 'Assignee must be active and assigned to the selected branch.' });
        }
        update.assignedTo = assignee._id;
        update.assignedToName = assignee.name;
      } else {
        update.assignedTo = null;
        update.assignedToName = '';
      }
    }

    const c = await Complaint.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: `Status → ${req.body.status}`, data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// WAREHOUSE VERIFICATION
// ═══════════════════════════════════════

// PATCH /api/v1/complaints/:id/send-to-warehouse — send complaint for warehouse verification
router.patch('/:id/send-to-warehouse', requirePermission('complaint.management'), async (req, res) => {
  try {
    const scope = await getComplaintScope(req);
    const c = await Complaint.findOne({
      _id: req.params.id,
      ...scope,
      status: { $in: ['open', 'acknowledged', 'in_progress'] },
    });
    if (!c) return res.status(404).json({ success: false, message: 'Not found or complaint cannot be sent to warehouse.' });
    c.status = 'warehouse_pending';
    c.requiresReturn = true;
    await c.save();
    res.json({ success: true, message: 'Sent to warehouse for verification.', data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/complaints/:id/warehouse-verify — warehouse staff submits verification
router.patch('/:id/warehouse-verify', requirePermission('stock.adjustment'), async (req, res) => {
  try {
    const { problemConfirmed, problemDescription, severity, photos, productCondition, isResaleable, quantityReceived, quantityDamaged, recommendation, recommendedAmount, remarks } = req.body;
    const scope = await getComplaintScope(req);
    const c = await Complaint.findOne({
      _id: req.params.id,
      ...scope,
      status: 'warehouse_pending',
    });
    if (!c) return res.status(404).json({ success: false, message: 'Not found or not pending warehouse verification.' });

    c.warehouseVerification = {
      verifiedBy: req.user._id,
      verifiedByName: req.user.name,
      verifiedAt: new Date(),
      problemConfirmed: problemConfirmed ?? true,
      problemDescription: problemDescription || '',
      severity: severity || 'moderate',
      photos: photos || [],
      productCondition: productCondition || 'minor_damage',
      isResaleable: isResaleable ?? false,
      quantityReceived: quantityReceived || 0,
      quantityDamaged: quantityDamaged || 0,
      recommendation: recommendation || 'credit_note',
      recommendedAmount: recommendedAmount || 0,
      remarks: remarks || '',
    };
    c.status = 'warehouse_verified';
    c.returnReceived = true;

    await c.save();
    res.json({ success: true, message: 'Warehouse verification completed. Sent for finance review.', data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════
// ACCOUNTANT / FINANCE REVIEW
// ═══════════════════════════════════════

// PATCH /api/v1/complaints/:id/finance-review — accountant reviews and decides
router.patch('/:id/finance-review', requirePermission('finance.management'), async (req, res) => {
  try {
    const { decision, approvedAmount, adjustmentType, remarks } = req.body;
    const scope = await getComplaintScope(req);
    const c = await Complaint.findOne({
      _id: req.params.id,
      ...scope,
      status: { $in: ['warehouse_verified', 'finance_review'] },
    });
    if (!c) return res.status(404).json({ success: false, message: 'Not found or not pending finance review.' });

    c.accountantReview = {
      reviewedBy: req.user._id,
      reviewedByName: req.user.name,
      reviewedAt: new Date(),
      decision: decision || 'approved',
      approvedAmount: approvedAmount || c.warehouseVerification?.recommendedAmount || 0,
      adjustmentType: adjustmentType || 'credit_note',
      remarks: remarks || '',
    };

    if (decision === 'approved' || decision === 'partial_approved') {
      c.status = 'resolved';
      c.resolvedAt = new Date();
      c.creditNoteAmount = approvedAmount || c.warehouseVerification?.recommendedAmount || 0;
      c.resolutionType = adjustmentType || 'credit_note';

      if (adjustmentType === 'credit_note' && c.creditNoteAmount > 0) {
        c.creditNoteIssued = true;
        // TODO: Auto-generate credit note number and update dealer outstanding
      }
    } else if (decision === 'rejected') {
      c.status = 'rejected';
      c.resolutionType = 'rejected';
    } else {
      c.status = 'finance_review';
    }

    c.resolutionHistory.push({
      action: `Finance ${decision}: ${adjustmentType || 'no_action'} — ₹${approvedAmount || 0}`,
      resolvedBy: req.user._id,
      resolvedByName: req.user.name,
      notes: remarks || '',
    });

    await c.save();
    res.json({ success: true, message: `Complaint ${decision}. ${adjustmentType === 'credit_note' ? `Credit Note ₹${approvedAmount} issued.` : ''}`, data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
