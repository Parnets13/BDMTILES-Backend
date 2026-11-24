import { Router } from 'express';
import mongoose from 'mongoose';
import PartnerCommission from '../models/PartnerCommission.js';
import SalesOrder from '../models/SalesOrder.js';
import User from '../models/User.js';
import { protect, requirePermission } from '../middleware/auth.js';

/**
 * Partner commissions.
 *
 * A channel partner is an external person who brings business and earns a cut. They
 * hold the `partner` role, which carries exactly two permissions, and every read
 * here is filtered to their own rows — a partner can never see another partner's
 * ledger, and cannot record or approve anything at all.
 *
 * This is the in-system half of item 35. The separate partner application in E9 is
 * a different, much larger piece of work and is not built here.
 */
const router = Router();
router.use(protect);

const routeError = (status, message) => Object.assign(new Error(message), { status });

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const isPartnerOnly = (req) => req.user.role === 'partner';

/**
 * Who may read whose rows. A partner sees only their own; anyone with the
 * management permission sees everything in scope.
 */
const readScope = (req) => (isPartnerOnly(req) ? { partner: req.user._id } : {});

const writeScope = (req) => {
  if (req.allBranches) return {};
  return {
    $or: [
      { branch: req.branchScope },
      { branch: null },
      { branch: { $exists: false } },
    ],
  };
};

// GET /api/v1/partners/commissions
router.get('/commissions', requirePermission('partner.commission.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status, partner, search, dateFrom, dateTo } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));

    const extra = { ...readScope(req) };
    if (status) extra.status = status;
    if (partner && !isPartnerOnly(req)) {
      if (!mongoose.isValidObjectId(partner)) throw routeError(422, 'partner is invalid.');
      extra.partner = partner;
    }
    if (search) {
      const r = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      extra.$or = [{ orderNumber: r }, { partnerName: r }, { customerName: r }];
    }
    if (dateFrom || dateTo) {
      extra.orderDate = {};
      if (dateFrom) {
        const start = new Date(dateFrom);
        if (Number.isNaN(start.getTime())) throw routeError(422, 'dateFrom is invalid.');
        extra.orderDate.$gte = start;
      }
      if (dateTo) {
        const end = new Date(dateTo);
        if (Number.isNaN(end.getTime())) throw routeError(422, 'dateTo is invalid.');
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo))) end.setUTCHours(23, 59, 59, 999);
        extra.orderDate.$lte = end;
      }
    }

    const filter = Object.keys(extra).length ? { $and: [extra, writeScope(req)] } : writeScope(req);
    const [data, total, summaryRows] = await Promise.all([
      PartnerCommission.find(filter)
        .populate('partner', 'name email phone')
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      PartnerCommission.countDocuments(filter),
      PartnerCommission.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            rows: { $sum: 1 },
            earned: { $sum: { $ifNull: ['$commissionAmount', 0] } },
            paid: {
              $sum: { $cond: [{ $eq: ['$status', 'paid'] }, { $ifNull: ['$commissionAmount', 0] }, 0] },
            },
            approved: {
              $sum: { $cond: [{ $eq: ['$status', 'approved'] }, { $ifNull: ['$commissionAmount', 0] }, 0] },
            },
          },
        },
      ]),
    ]);

    const row = summaryRows[0] || { rows: 0, earned: 0, paid: 0, approved: 0 };
    return res.json({
      success: true,
      data,
      summary: {
        rows: row.rows || 0,
        earned: money(row.earned),
        approved: money(row.approved),
        paid: money(row.paid),
        outstanding: money((row.earned || 0) - (row.paid || 0)),
      },
      pagination: {
        currentPage: p,
        totalPages: Math.ceil(total / l),
        totalItems: total,
        itemsPerPage: l,
        hasMore: p * l < total,
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/partners — the partners a commission can be recorded against
router.get('/', requirePermission('partner.commission.manage'), async (_req, res) => {
  try {
    const data = await User.find({ role: 'partner', status: 'Active' })
      .select('name email phone')
      .sort({ name: 1 })
      .lean();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/v1/partners/commissions
 *
 * Records a commission against a partner and, optionally, the order that earned it.
 * When an order is named the order number, date, customer and value are copied onto
 * the row, so the ledger still reads correctly if the order is later renamed.
 */
router.post('/commissions', requirePermission('partner.commission.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.partner || !mongoose.isValidObjectId(body.partner)) throw routeError(422, 'partner is required.');
    const partner = await User.findOne({ _id: body.partner, role: 'partner' }).select('name').lean();
    if (!partner) throw routeError(404, 'Partner not found, or that user does not hold the partner role.');

    const data = {
      branch: req.branchId || null,
      partner: partner._id,
      partnerName: partner.name || '',
      period: String(body.period || '').trim(),
      note: String(body.note || '').trim(),
      createdBy: req.user._id,
    };

    if (body.salesOrder) {
      if (!mongoose.isValidObjectId(body.salesOrder)) throw routeError(422, 'salesOrder is invalid.');
      const order = await SalesOrder.findById(body.salesOrder)
        .select('orderNumber orderDate customerName dealerName grandTotal')
        .lean();
      if (!order) throw routeError(404, 'Sales order not found.');
      data.salesOrder = order._id;
      data.orderNumber = order.orderNumber;
      data.orderDate = order.orderDate;
      data.customerName = order.dealerName || order.customerName || '';
      data.baseAmount = money(order.grandTotal);
    } else {
      data.baseAmount = money(body.baseAmount);
    }

    const percent = Number(body.commissionPercent);
    if (Number.isFinite(percent) && percent > 0) {
      data.commissionPercent = money(percent);
      data.commissionAmount = money((data.baseAmount * percent) / 100);
    } else {
      const amount = Number(body.commissionAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw routeError(422, 'Enter either a commission percentage or a commission amount.');
      }
      data.commissionAmount = money(amount);
      data.commissionPercent = data.baseAmount > 0
        ? money((amount / data.baseAmount) * 100)
        : 0;
    }

    const commission = await PartnerCommission.create(data);
    return res.status(201).json({
      success: true,
      message: `Commission of ₹${commission.commissionAmount} recorded for ${commission.partnerName}.`,
      data: commission,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A commission is already recorded for this partner against that order.',
      });
    }
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/v1/partners/commissions/:id/status
 *
 * accrued → approved → paid. Cancelling is allowed until the money leaves; after
 * that the row is history and must not be rewritten.
 */
router.patch('/commissions/:id/status', requirePermission('partner.commission.manage'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw routeError(422, 'Commission id is invalid.');
    const action = String(req.body?.action || '').trim();
    if (!['approve', 'pay', 'cancel'].includes(action)) throw routeError(422, 'action must be approve, pay or cancel.');

    const commission = await PartnerCommission.findById(req.params.id);
    if (!commission) throw routeError(404, 'Commission not found.');
    if (commission.status === 'paid') throw routeError(409, 'This commission has already been paid.');

    if (action === 'approve') {
      if (commission.status !== 'accrued') throw routeError(409, 'Only an accrued commission can be approved.');
      commission.status = 'approved';
      commission.approvedBy = req.user._id;
      commission.approvedAt = new Date();
    } else if (action === 'pay') {
      if (commission.status !== 'approved') throw routeError(409, 'Approve the commission before paying it.');
      commission.status = 'paid';
      commission.paidBy = req.user._id;
      commission.paidAt = new Date();
      commission.paymentReference = String(req.body?.paymentReference || '').trim();
    } else {
      if (commission.status === 'paid') throw routeError(409, 'A paid commission cannot be cancelled.');
      commission.status = 'cancelled';
    }
    await commission.save();
    return res.json({ success: true, message: `Commission ${commission.status}.`, data: commission });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
