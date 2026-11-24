import { Router } from 'express';
import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import Branch from '../models/Branch.js';
import User from '../models/User.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

/**
 * Google review collection.
 *
 * The `Customer` model already carried the whole trail — submitted flag and date,
 * who collected it, the amount owed, whether it was paid and by whom — and the
 * branch already carried the review link and the per-review amount. Nothing wrote
 * any of it, so the feature existed only as unused columns. This is the API for it.
 *
 * A review is recorded on the customer rather than in `IncentiveEarning`. The
 * branch pays a flat amount per review, which is exactly what
 * `Customer.reviewIncentiveAmount` holds, and posting the same money into a second
 * ledger would let the two disagree. The consequence is deliberate: review
 * incentives do not appear in the incentive earnings report.
 */
const router = Router();
router.use(protect);
router.use(requireBranch);

const routeError = (status, message) => Object.assign(new Error(message), { status });

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isSalesExecutive = (req) => req.user.role === 'sales_executive';

/**
 * Users who can collect a review in the active branch.
 *
 * A customer has no branch column — the owning sales executive's branch is the
 * only thing that ties them to one. A review is the same: the branch that owes the
 * incentive is the collector's branch, so both lists are scoped through it. In the
 * all-branches view no user filter applies and every review is visible.
 */
const branchUserIds = async (req) => {
  if (req.allBranches) return null;
  return User.find({ assignedBranches: req.branchScope }).distinct('_id');
};

/**
 * The customers a given caller may ask for a review.
 *
 * A sales executive sees only their own customers; anyone else sees the customers
 * of every executive in the active branch. A customer with no assigned executive
 * belongs to no branch, so it appears in neither list — the same rule the dealer
 * master already follows.
 */
const eligibleScope = async (req) => {
  if (isSalesExecutive(req)) return { assignedSalesExecutive: req.user._id };
  const ids = await branchUserIds(req);
  if (ids === null) return { assignedSalesExecutive: { $ne: null } };
  return { assignedSalesExecutive: { $in: ids } };
};

/** The collected reviews a caller may see, using the same rule in reverse. */
const collectedScope = async (req) => {
  if (isSalesExecutive(req)) return { reviewCollectedBy: req.user._id };
  const ids = await branchUserIds(req);
  return ids === null ? {} : { reviewCollectedBy: { $in: ids } };
};

const branchIncentive = async (branchId) => {
  if (!branchId) return { amount: 0, link: '' };
  const branch = await Branch.findById(branchId)
    .select('googleReviewLink googleReviewIncentive')
    .lean();
  const settings = branch?.googleReviewIncentive || {};
  return {
    amount: settings.enabled ? Number(settings.amount || 0) : 0,
    link: branch?.googleReviewLink || '',
    enabled: Boolean(settings.enabled),
    description: settings.description || '',
  };
};

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/**
 * GET /api/v1/google-reviews/eligible
 *
 * Customers who have not left a review yet, with the branch link to share and the
 * amount the collector would earn, so the screen can show both before committing.
 */
router.get('/eligible', requirePermission('google.review.collect'), async (req, res) => {
  try {
    const { search, limit = 50 } = req.query;
    const l = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
    const filter = {
      ...(await eligibleScope(req)),
      status: 'active',
      googleReviewSubmitted: { $ne: true },
    };
    if (search) {
      const regex = new RegExp(escapeRegex(String(search).trim()), 'i');
      filter.$or = [{ name: regex }, { customerCode: regex }, { contactNumber: regex }];
    }
    const [data, total, incentive] = await Promise.all([
      Customer.find(filter)
        .select('name customerCode contactNumber customerType assignedSalesExecutive city googleReviewLink')
        .populate('assignedSalesExecutive', 'name')
        .sort({ name: 1 })
        .limit(l)
        .lean(),
      Customer.countDocuments(filter),
      // In the all-branches view there is no single rate or link to show. Reporting
      // zero would read as "no incentive configured", which is a different fact.
      req.allBranches
        ? Promise.resolve({ amount: 0, link: '', enabled: false, needsBranch: true })
        : branchIncentive(req.branchId),
    ]);
    return res.json({
      success: true,
      data,
      total,
      incentive,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/v1/google-reviews
 *
 * Reviews already collected, with the payout totals for the same filter. The
 * summary is computed from the filtered set rather than the page, so the figure
 * does not change as the reader pages through.
 */
router.get('/', requirePermission('google.review.collect'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, paid, collectedBy, dateFrom, dateTo } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));

    const filter = {
      ...(await collectedScope(req)),
      googleReviewSubmitted: true,
    };
    if (paid === 'true') filter.reviewIncentivePaid = true;
    if (paid === 'false') filter.reviewIncentivePaid = { $ne: true };
    if (collectedBy) {
      if (!mongoose.isValidObjectId(collectedBy)) throw routeError(422, 'collectedBy is invalid.');
      filter.reviewCollectedBy = collectedBy;
    }
    if (dateFrom || dateTo) {
      filter.googleReviewSubmittedDate = {};
      if (dateFrom) {
        const start = new Date(dateFrom);
        if (Number.isNaN(start.getTime())) throw routeError(422, 'dateFrom is invalid.');
        filter.googleReviewSubmittedDate.$gte = start;
      }
      if (dateTo) {
        const end = new Date(dateTo);
        if (Number.isNaN(end.getTime())) throw routeError(422, 'dateTo is invalid.');
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo))) end.setUTCHours(23, 59, 59, 999);
        filter.googleReviewSubmittedDate.$lte = end;
      }
    }
    if (search) {
      const regex = new RegExp(escapeRegex(String(search).trim()), 'i');
      filter.$or = [{ name: regex }, { customerCode: regex }, { contactNumber: regex }];
    }

    const [data, total, summaryRows] = await Promise.all([
      Customer.find(filter)
        .select('name customerCode contactNumber customerType googleReviewLink googleReviewSubmittedDate reviewCollectedBy reviewIncentiveAmount reviewIncentivePaid reviewIncentivePaidDate reviewIncentivePaidBy')
        .populate('reviewCollectedBy reviewIncentivePaidBy', 'name')
        .sort({ googleReviewSubmittedDate: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      Customer.countDocuments(filter),
      Customer.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            reviews: { $sum: 1 },
            totalAmount: { $sum: { $ifNull: ['$reviewIncentiveAmount', 0] } },
            paidAmount: {
              $sum: {
                $cond: [{ $eq: ['$reviewIncentivePaid', true] }, { $ifNull: ['$reviewIncentiveAmount', 0] }, 0],
              },
            },
          },
        },
      ]),
    ]);

    const row = summaryRows[0] || { reviews: 0, totalAmount: 0, paidAmount: 0 };
    return res.json({
      success: true,
      data,
      summary: {
        reviews: row.reviews || 0,
        totalAmount: money(row.totalAmount),
        paidAmount: money(row.paidAmount),
        unpaidAmount: money((row.totalAmount || 0) - (row.paidAmount || 0)),
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

/**
 * POST /api/v1/google-reviews/:customerId/collect
 *
 * Marks a customer's review as collected. The amount is snapshotted from the
 * branch at this moment, so switching the branch rate off tomorrow cannot rewrite
 * what was earned today, and turning it on cannot retroactively owe money for
 * reviews collected while it was off.
 */
router.post('/:customerId/collect', requirePermission('google.review.collect'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.customerId)) throw routeError(422, 'Customer id is invalid.');
    const customer = await Customer.findOne({
      _id: req.params.customerId,
      ...(await eligibleScope(req)),
    }).select('name customerCode googleReviewSubmitted googleReviewSubmittedDate googleReviewLink');
    if (!customer) throw routeError(404, 'Customer not found, or not one of your customers.');
    if (customer.googleReviewSubmitted) {
      return res.status(409).json({
        success: false,
        message: `A review for ${customer.name} was already recorded on ${new Date(customer.googleReviewSubmittedDate).toLocaleDateString('en-IN')}.`,
      });
    }

    const incentive = await branchIncentive(req.branchId);
    const reviewUrl = String(req.body?.reviewUrl || '').trim();

    customer.googleReviewSubmitted = true;
    customer.googleReviewSubmittedDate = new Date();
    customer.reviewCollectedBy = req.user._id;
    customer.reviewIncentiveAmount = money(incentive.amount);
    customer.reviewIncentivePaid = false;
    customer.reviewIncentivePaidDate = undefined;
    customer.reviewIncentivePaidBy = undefined;
    // Prefer the link the caller pasted; otherwise remember the branch's link so
    // the record still says where the review was meant to go.
    if (reviewUrl) customer.googleReviewLink = reviewUrl;
    else if (!customer.googleReviewLink && incentive.link) customer.googleReviewLink = incentive.link;
    await customer.save();

    return res.json({
      success: true,
      message: incentive.amount > 0
        ? `Review recorded. ₹${money(incentive.amount)} incentive is now pending.`
        : 'Review recorded. No incentive is configured for this branch.',
      data: customer,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/v1/google-reviews/:customerId/reverse
 *
 * Undoes a mistaken entry. Refused once the incentive has been paid — that is a
 * money movement, so it needs a reversal in finance rather than a silent edit.
 */
router.post('/:customerId/reverse', requirePermission('google.review.manage'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.customerId)) throw routeError(422, 'Customer id is invalid.');
    const customer = await Customer.findOne({
      _id: req.params.customerId,
      ...(await collectedScope(req)),
    });
    if (!customer) throw routeError(404, 'Review not found.');
    if (!customer.googleReviewSubmitted) throw routeError(409, 'This customer has no recorded review.');
    if (customer.reviewIncentivePaid) {
      throw routeError(409, 'The incentive has already been paid. Reverse the payment first.');
    }

    customer.googleReviewSubmitted = false;
    customer.googleReviewSubmittedDate = undefined;
    customer.reviewCollectedBy = undefined;
    customer.reviewIncentiveAmount = 0;
    customer.reviewIncentivePaid = false;
    await customer.save();

    return res.json({ success: true, message: 'Review entry reversed.', data: customer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/v1/google-reviews/:customerId/incentive
 *
 * Marks the incentive paid or unpaid. Paying stamps who did it and when, because
 * the payout has to be attributable; un-paying is allowed so a wrong click can be
 * corrected before the money leaves.
 */
router.patch('/:customerId/incentive', requirePermission('google.review.manage'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.customerId)) throw routeError(422, 'Customer id is invalid.');
    const action = String(req.body?.action || '').trim();
    if (!['pay', 'unpay'].includes(action)) throw routeError(422, 'action must be pay or unpay.');

    const customer = await Customer.findOne({
      _id: req.params.customerId,
      ...(await collectedScope(req)),
    });
    if (!customer) throw routeError(404, 'Review not found.');
    if (!customer.googleReviewSubmitted) throw routeError(409, 'This customer has no recorded review.');

    if (action === 'pay') {
      if (customer.reviewIncentivePaid) throw routeError(409, 'The incentive is already marked paid.');
      if (Number(customer.reviewIncentiveAmount || 0) <= 0) {
        throw routeError(409, 'There is no incentive amount to pay on this review.');
      }
      customer.reviewIncentivePaid = true;
      customer.reviewIncentivePaidDate = new Date();
      customer.reviewIncentivePaidBy = req.user._id;
    } else {
      if (!customer.reviewIncentivePaid) throw routeError(409, 'The incentive is not marked paid.');
      customer.reviewIncentivePaid = false;
      customer.reviewIncentivePaidDate = undefined;
      customer.reviewIncentivePaidBy = undefined;
    }
    await customer.save();

    return res.json({
      success: true,
      message: action === 'pay' ? 'Incentive marked paid.' : 'Incentive marked unpaid.',
      data: customer,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
