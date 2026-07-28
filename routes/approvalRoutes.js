import { Router } from 'express';
import ApprovalRequest from '../models/ApprovalRequest.js';
import SalesOrder from '../models/SalesOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/approvals
router.get('/', requirePermission('dashboard.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    const [data, total] = await Promise.all([
      ApprovalRequest.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('requestedBy', 'name').populate('approvedBy', 'name').lean(),
      ApprovalRequest.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/approvals/stats
router.get('/stats', requirePermission('dashboard.view'), async (req, res) => {
  try {
    const [total, pending, approved, rejected] = await Promise.all([
      ApprovalRequest.countDocuments(),
      ApprovalRequest.countDocuments({ status: 'pending' }),
      ApprovalRequest.countDocuments({ status: 'approved' }),
      ApprovalRequest.countDocuments({ status: 'rejected' }),
    ]);
    // Pending by type
    const byType = await ApprovalRequest.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);
    res.json({ success: true, data: { total, pending, approved, rejected, byType } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/approvals — create request
router.post('/', protect, async (req, res) => {
  try {
    const data = { ...req.body, requestedBy: req.user._id, requestedByName: req.user.name };
    const count = await ApprovalRequest.countDocuments();
    data.requestNumber = `APR-${String(count + 1).padStart(5, '0')}`;
    const req_ = await ApprovalRequest.create(data);
    res.status(201).json({ success: true, message: 'Approval request submitted.', data: req_ });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/approvals/:id/approve
router.patch('/:id/approve', requirePermission('dashboard.view'), async (req, res) => {
  try {
    const approval = await ApprovalRequest.findById(req.params.id);
    if (!approval) return res.status(404).json({ success: false, message: 'Not found.' });
    if (approval.status !== 'pending') return res.status(400).json({ success: false, message: 'Already actioned.' });
    approval.status = 'approved';
    approval.approvedBy = req.user._id;
    approval.approvedAt = new Date();
    approval.approvalRemarks = req.body.remarks || '';
    await approval.save();

    // Auto-action: if SO credit limit approval → mark SO approved
    if (approval.type === 'sales_order' && approval.referenceId) {
      await SalesOrder.findByIdAndUpdate(approval.referenceId, {
        approvalStatus: 'approved', approvedBy: req.user._id, approvalDate: new Date(),
        approvalRemarks: req.body.remarks,
      });
    }

    res.json({ success: true, message: 'Approved.', data: approval });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/approvals/:id/reject
router.patch('/:id/reject', requirePermission('dashboard.view'), async (req, res) => {
  try {
    const approval = await ApprovalRequest.findById(req.params.id);
    if (!approval) return res.status(404).json({ success: false, message: 'Not found.' });
    approval.status = 'rejected';
    approval.approvedBy = req.user._id;
    approval.approvedAt = new Date();
    approval.approvalRemarks = req.body.remarks || '';
    await approval.save();

    // Auto-action: if SO → mark rejected
    if (approval.type === 'sales_order' && approval.referenceId) {
      await SalesOrder.findByIdAndUpdate(approval.referenceId, {
        approvalStatus: 'rejected', approvalRemarks: req.body.remarks,
      });
    }

    res.json({ success: true, message: 'Rejected.', data: approval });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
