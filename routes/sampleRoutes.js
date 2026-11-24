import { Router } from 'express';
import mongoose from 'mongoose';
import Sample from '../models/Sample.js';
import Product from '../models/Product.js';
import Supplier from '../models/Supplier.js';
import Warehouse from '../models/Warehouse.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { uploadSamplePhotos } from '../middleware/upload.js';

/**
 * Sample management.
 *
 * Two kinds of sample live here. An outbound sample is handed to a dealer,
 * architect or customer and is tracked by where it is. A supplier sample is money
 * the business spent, so it carries a cost, an approval and a recovery trail — and
 * the recovery is not cosmetic: a supplier credit note reduces a payable, a
 * write-off is a marketing expense, and a forfeited deposit is cash already held.
 * They are recorded separately because they hit different accounts.
 */
const router = Router();
router.use(protect);
router.use(requireBranch);

const routeError = (status, message) => Object.assign(new Error(message), { status });

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const isNonNegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;

/**
 * Branch scoping for a collection whose older rows have no branch.
 *
 * Samples written before this field existed carry none. Filtering strictly by
 * branch would hide every one of them from every branch, so an unbranched sample
 * stays visible everywhere until it is backfilled — the same rule the asset master
 * uses.
 */
const branchClause = (req) => {
  if (req.allBranches) return null;
  return {
    $or: [
      { branch: req.branchScope },
      { branch: null },
      { branch: { $exists: false } },
    ],
  };
};

const scopedFilter = (req, extra = {}) => {
  const clause = branchClause(req);
  return clause ? { $and: [clause, extra] } : extra;
};

/**
 * Recomputes recovered/unrecovered from the history rather than trusting a
 * running total. A stored total drifts the moment one entry is corrected; the
 * history is the record, so it is the only thing summed.
 */
const applyRecoveryTotals = (sample) => {
  const recovered = (sample.recoveryHistory || [])
    // A refunded deposit is cash going back out, not a recovery of cost.
    .filter((entry) => entry.action !== 'deposit_refunded')
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const total = Number(sample.totalCost || 0);
  sample.recoveredAmount = money(Math.max(0, recovered));
  sample.unrecoveredAmount = money(Math.max(0, total - sample.recoveredAmount));

  const methods = new Set(
    (sample.recoveryHistory || [])
      .filter((entry) => entry.action !== 'deposit_refunded')
      .map((entry) => entry.action),
  );
  if (methods.size === 0) sample.recoveryMethod = 'none';
  else if (methods.size > 1) sample.recoveryMethod = 'mixed';
  else if (methods.has('credit_note')) sample.recoveryMethod = 'credit_note';
  else if (methods.has('write_off')) sample.recoveryMethod = 'written_off';
  else if (methods.has('deposit_forfeited')) sample.recoveryMethod = 'deposit';
  else sample.recoveryMethod = 'mixed';
  return sample;
};

// GET /api/v1/samples
router.get('/', requirePermission('stock.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, direction, supplier, accountingStatus } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));

    const extra = {};
    if (search) {
      const r = new RegExp(escapeRegex(String(search).trim()), 'i');
      extra.$or = [{ sampleNumber: r }, { issuedTo: r }, { productName: r }];
    }
    if (status) extra.status = status;
    if (direction) {
      if (!['outbound', 'supplier'].includes(direction)) throw routeError(422, 'direction must be outbound or supplier.');
      extra.direction = direction;
    }
    if (accountingStatus) extra.accountingStatus = accountingStatus;
    if (supplier) {
      if (!mongoose.isValidObjectId(supplier)) throw routeError(422, 'supplier is invalid.');
      extra.supplier = supplier;
    }

    const filter = scopedFilter(req, extra);
    const [data, total] = await Promise.all([
      Sample.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('product', 'productCode itemName tileSize')
        .populate('warehouse', 'name')
        .populate('supplier', 'companyName supplierCode')
        .populate('accountingApprovedBy', 'name')
        .lean(),
      Sample.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/samples/stats
router.get('/stats', requirePermission('stock.view'), async (req, res) => {
  try {
    const filter = scopedFilter(req, {});
    const [total, issued, returned, damaged, pending, supplierSamples, awaitingApproval] = await Promise.all([
      Sample.countDocuments(filter),
      Sample.countDocuments(scopedFilter(req, { status: 'issued' })),
      Sample.countDocuments(scopedFilter(req, { status: 'returned' })),
      Sample.countDocuments(scopedFilter(req, { status: 'damaged' })),
      Sample.countDocuments(scopedFilter(req, { status: { $in: ['issued', 'with_customer'] } })),
      Sample.countDocuments(scopedFilter(req, { direction: 'supplier' })),
      Sample.countDocuments(scopedFilter(req, { accountingStatus: 'pending' })),
    ]);
    return res.json({
      success: true,
      data: { total, issued, returned, damaged, pending, supplierSamples, awaitingApproval },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/v1/samples/accounting/summary
 *
 * The sample investment position: what was spent, what came back and what did not,
 * split by supplier so an unrecovered balance can be chased with the right party.
 * Only approved samples count — an unapproved cost is not yet a cost.
 */
router.get('/accounting/summary', requirePermission('stock.view'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const extra = { direction: 'supplier', accountingStatus: 'approved' };
    if (dateFrom || dateTo) {
      extra.issueDate = {};
      if (dateFrom) {
        const start = new Date(dateFrom);
        if (Number.isNaN(start.getTime())) throw routeError(422, 'dateFrom is invalid.');
        extra.issueDate.$gte = start;
      }
      if (dateTo) {
        const end = new Date(dateTo);
        if (Number.isNaN(end.getTime())) throw routeError(422, 'dateTo is invalid.');
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo))) end.setUTCHours(23, 59, 59, 999);
        extra.issueDate.$lte = end;
      }
    }
    const rows = await Sample.aggregate([
      { $match: scopedFilter(req, extra) },
      {
        $group: {
          _id: '$supplier',
          samples: { $sum: 1 },
          investment: { $sum: { $ifNull: ['$totalCost', 0] } },
          recovered: { $sum: { $ifNull: ['$recoveredAmount', 0] } },
          unrecovered: { $sum: { $ifNull: ['$unrecoveredAmount', 0] } },
        },
      },
      { $lookup: { from: 'suppliers', localField: '_id', foreignField: '_id', as: 'supplier' } },
      { $unwind: { path: '$supplier', preserveNullAndEmptyArrays: true } },
      { $sort: { unrecovered: -1 } },
    ]);

    const totals = rows.reduce((acc, row) => ({
      samples: acc.samples + row.samples,
      investment: money(acc.investment + row.investment),
      recovered: money(acc.recovered + row.recovered),
      unrecovered: money(acc.unrecovered + row.unrecovered),
    }), { samples: 0, investment: 0, recovered: 0, unrecovered: 0 });

    return res.json({
      success: true,
      data: {
        totals,
        bySupplier: rows.map((row) => ({
          supplier: row._id,
          supplierName: row.supplier?.companyName || 'Unassigned',
          supplierCode: row.supplier?.supplierCode || '',
          samples: row.samples,
          investment: money(row.investment),
          recovered: money(row.recovered),
          unrecovered: money(row.unrecovered),
        })),
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/samples — issue an outbound sample or record a supplier sample
router.post('/', requireAnyPermission('sample.management', 'stock.view'), async (req, res) => {
  try {
    const body = req.body || {};
    const direction = body.direction === 'supplier' ? 'supplier' : 'outbound';
    const quantity = Number(body.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) throw routeError(422, 'quantity must be greater than zero.');

    const data = {
      ...body,
      direction,
      quantity,
      issuedBy: req.user._id,
      branch: req.branchId,
    };

    if (direction === 'supplier') {
      if (!body.supplier || !mongoose.isValidObjectId(body.supplier)) {
        throw routeError(422, 'A supplier sample needs a supplier.');
      }
      if (!await Supplier.exists({ _id: body.supplier })) throw routeError(404, 'Supplier not found.');
      if (!body.issuedTo) data.issuedTo = 'Supplier sample';
    }

    // Cost is snapshotted at issue. A later purchase-rate revision must not restate
    // a sample that has already been approved and expensed.
    if (direction === 'supplier') {
      if (!isNonNegative(body.unitCost)) throw routeError(422, 'unitCost must be zero or more.');
      data.unitCost = money(body.unitCost);
      data.totalCost = money(data.unitCost * quantity);
      data.recoveredAmount = 0;
      data.unrecoveredAmount = data.totalCost;
      // A supplier sample starts as a cost to be approved, not as an accepted one.
      data.accountingStatus = 'pending';
      data.accountingSubmittedBy = req.user._id;
      data.accountingSubmittedAt = new Date();
    } else {
      data.totalCost = money((Number(body.unitCost) || 0) * quantity);
      data.unrecoveredAmount = data.totalCost;
      data.accountingStatus = 'not_required';
    }

    if (data.product) {
      const product = await Product.findById(data.product).lean();
      if (product) {
        data.productName = product.itemName;
        data.productCode = product.productCode;
      }
    }

    // Branch-numbered so two branches issuing at the same moment cannot collide —
    // the previous count-based number did exactly that.
    data.sampleNumber = await generateBranchNumber(req.branchId, 'sample');

    const sample = await Sample.create(data);
    return res.status(201).json({
      success: true,
      message: direction === 'supplier'
        ? `Supplier sample ${sample.sampleNumber} recorded and sent for accounting approval.`
        : `Sample ${sample.sampleNumber} issued.`,
      data: sample,
    });
  } catch (error) {
    return res.status(error.status || (error.code === 11000 ? 409 : 500))
      .json({ success: false, message: error.code === 11000 ? 'Sample number already exists.' : error.message });
  }
});

// PATCH /api/v1/samples/:id/return
router.patch('/:id/return', requireAnyPermission('sample.management', 'stock.view'), async (req, res) => {
  try {
    const sample = await Sample.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!sample) throw routeError(404, 'Sample not found.');
    sample.status = req.body.condition === 'damaged' ? 'damaged' : 'returned';
    sample.actualReturnDate = new Date();
    sample.returnCondition = req.body.condition || 'good';
    sample.damageNotes = req.body.damageNotes || '';
    if (sample.depositCollected) sample.depositReturned = true;

    // A damaged or lost sample that was paid for is an unrecovered cost. Recording
    // it here means the write-off does not have to be remembered separately.
    if (['damaged', 'lost'].includes(sample.status) && Number(sample.totalCost || 0) > 0) {
      sample.recoveryHistory.push({
        action: 'write_off',
        amount: money(Number(sample.totalCost || 0) - Number(sample.recoveredAmount || 0)),
        note: req.body.damageNotes || `Sample ${sample.status}`,
        recordedBy: req.user._id,
        recordedAt: new Date(),
      });
      applyRecoveryTotals(sample);
    }
    await sample.save();
    return res.json({ success: true, message: 'Sample returned.', data: sample });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/v1/samples/:id/photos
 *
 * Evidence attached to a sample. A supplier sample is expected to have at least
 * one before its cost goes for approval — the approver is being asked to accept a
 * number on the strength of a photograph.
 */
router.post('/:id/photos', requireAnyPermission('sample.management', 'stock.view'), uploadSamplePhotos, async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) throw routeError(422, 'Attach at least one photo.');
    const sample = await Sample.findById(req.params.id);
    if (!sample) throw routeError(404, 'Sample not found.');
    files.forEach((file) => {
      sample.photos.push({
        url: `/uploads/samples/${file.filename}`,
        label: String(req.body?.label || '').trim(),
        uploadedBy: req.user._id,
        uploadedAt: new Date(),
      });
    });
    await sample.save();
    return res.json({ success: true, message: `${files.length} photo(s) attached.`, data: sample });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/v1/samples/:id/accounting
 *
 * Approve or reject the cost of a supplier sample. Approval is what turns a
 * recorded number into an expense, so it is gated on `sample.accounting.approve`
 * and the approver is stamped on the record.
 */
router.patch('/:id/accounting', requirePermission('sample.accounting.approve'), async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim();
    if (!['approve', 'reject'].includes(action)) throw routeError(422, 'action must be approve or reject.');

    const sample = await Sample.findById(req.params.id);
    if (!sample) throw routeError(404, 'Sample not found.');
    if (sample.direction !== 'supplier') throw routeError(409, 'Only a supplier sample carries a cost to approve.');
    if (sample.accountingStatus === 'approved') throw routeError(409, 'This sample is already approved.');
    if (sample.accountingStatus === 'not_required') throw routeError(409, 'This sample has no cost requiring approval.');
    if (!(Number(sample.totalCost || 0) > 0)) throw routeError(409, 'A sample with no cost cannot be approved.');

    if (action === 'approve') {
      if (!(sample.photos || []).length) {
        throw routeError(409, 'Attach at least one photo before approving a supplier sample cost.');
      }
      sample.accountingStatus = 'approved';
      sample.accountingApprovedBy = req.user._id;
      sample.accountingApprovedAt = new Date();
      sample.accountingNotes = String(req.body?.notes || '').trim();
    } else {
      sample.accountingStatus = 'rejected';
      sample.accountingApprovedBy = req.user._id;
      sample.accountingApprovedAt = new Date();
      sample.accountingNotes = String(req.body?.notes || '').trim();
    }
    await sample.save();
    return res.json({
      success: true,
      message: action === 'approve' ? 'Sample cost approved.' : 'Sample cost rejected.',
      data: sample,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/v1/samples/:id/recovery
 *
 * Records how some or all of a sample's cost came back. Each entry is appended to
 * the history and the totals are recomputed from it, so a correction is another
 * entry rather than an overwrite and the trail stays auditable.
 */
router.post('/:id/recovery', requirePermission('sample.accounting.recover'), async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim();
    const allowed = ['credit_note', 'write_off', 'deposit_forfeited', 'deposit_refunded', 'adjustment'];
    if (!allowed.includes(action)) throw routeError(422, `action must be one of ${allowed.join(', ')}.`);

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw routeError(422, 'amount must be greater than zero.');

    const sample = await Sample.findById(req.params.id);
    if (!sample) throw routeError(404, 'Sample not found.');
    if (sample.direction !== 'supplier') throw routeError(409, 'Only a supplier sample carries a recoverable cost.');
    if (sample.accountingStatus !== 'approved') {
      throw routeError(409, 'Approve the sample cost before recording a recovery against it.');
    }

    const outstanding = money(Number(sample.totalCost || 0) - Number(sample.recoveredAmount || 0));
    if (action !== 'adjustment' && action !== 'deposit_refunded' && amount > outstanding) {
      throw routeError(422, `Recovery cannot exceed the unrecovered balance of ₹${outstanding}.`);
    }

    sample.recoveryHistory.push({
      action,
      amount: money(amount),
      creditNoteNumber: String(req.body?.creditNoteNumber || '').trim(),
      documentUrl: String(req.body?.documentUrl || '').trim(),
      note: String(req.body?.note || '').trim(),
      recordedBy: req.user._id,
      recordedAt: new Date(),
    });
    applyRecoveryTotals(sample);
    await sample.save();

    return res.json({
      success: true,
      message: `Recovery recorded. ₹${sample.unrecoveredAmount} remains unrecovered.`,
      data: sample,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/v1/samples/lookups/warehouses
 *
 * The warehouse picker used to read `/masters/warehouses`, which is gated on
 * `warehouse.master` — a permission the floor roles that issue samples do not
 * hold, so the picker came back empty for exactly the people who use it. Listing
 * from the sample side keeps the gate aligned with the feature: anyone who can
 * issue a sample can see the active warehouses in their own branch.
 */
router.get('/lookups/warehouses', requireAnyPermission('sample.management', 'stock.view'), async (req, res) => {
  try {
    const filter = { status: 'active' };
    if (!req.allBranches) filter.branch = req.branchScope;
    const data = await Warehouse.find(filter).select('warehouseCode name').sort({ name: 1 }).lean();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/v1/samples/lookups/suppliers
 *
 * Same reasoning as the warehouse lookup — `/masters/suppliers` needs
 * `supplier.master`, which the people recording a supplier sample may not hold.
 */
router.get('/lookups/suppliers', requireAnyPermission('sample.management', 'stock.view'), async (req, res) => {
  try {
    const { search, limit = 50 } = req.query;
    const l = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
    const filter = {};
    if (search) {
      const regex = new RegExp(escapeRegex(String(search).trim()), 'i');
      filter.$or = [{ companyName: regex }, { supplierCode: regex }, { mobile: regex }];
    }
    const data = await Supplier.find(filter)
      .select('companyName supplierCode mobile')
      .sort({ companyName: 1 })
      .limit(l)
      .lean();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/samples/:id
router.get('/:id', requirePermission('stock.view'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw routeError(422, 'Sample id is invalid.');
    const sample = await Sample.findById(req.params.id)
      .populate('product', 'productCode itemName tileSize images')
      .populate('warehouse', 'name')
      .populate('supplier', 'companyName supplierCode mobile email')
      .populate('dealer', 'businessName dealerCode')
      .populate('customer', 'name customerCode contactNumber')
      .populate('issuedBy accountingApprovedBy', 'name')
      .populate('recoveryHistory.recordedBy', 'name')
      .lean();
    if (!sample) throw routeError(404, 'Sample not found.');
    return res.json({ success: true, data: sample });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;
