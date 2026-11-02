import { Router } from 'express';
import mongoose from 'mongoose';
import Company from '../models/Company.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { safeDelete } from '../middleware/safeDelete.js';

const router = Router();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DUPLICATE_GSTIN = 'A company with this GST number already exists.';

const fail = (res, error) => {
  if (error?.code === 11000) {
    return res.status(409).json({ success: false, message: DUPLICATE_GSTIN });
  }
  if (error?.name === 'ValidationError') {
    const message = Object.values(error.errors)[0]?.message || 'Invalid company details.';
    return res.status(400).json({ success: false, message });
  }
  if (error?.name === 'CastError') {
    return res.status(404).json({ success: false, message: 'Company not found.' });
  }
  return res.status(500).json({ success: false, message: error.message });
};

/** Only one company can be the primary identity; promoting one demotes the rest. */
const applyDefault = async (company) => {
  if (!company?.isDefault) return company;
  await Company.updateMany({ _id: { $ne: company._id } }, { $set: { isDefault: false } });
  return company;
};

router.use(protect);

// Lightweight list for the header's company switcher. Deliberately open to any
// signed-in user: choosing a company is a scope control, not master-data
// administration, and the payload is only what the switcher needs to render.
router.get('/lookup', async (req, res) => {
  try {
    const companies = await Company.find({ status: 'active' })
      .select('legalName tradeName gstin status isDefault')
      .sort({ isDefault: -1, legalName: 1 })
      .lean();
    return res.json({ success: true, data: companies });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.use(requirePermission('company.master'));
// Reads and writes both work under "All Branches" — a company has no branch
// column, so there is nothing to attribute. Only deletion needs a concrete
// branch, because the Recycle Bin records which branch it happened in.

// ── List ────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, status } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));

    const filter = {};
    if (search) {
      const regex = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [
        { legalName: regex }, { tradeName: regex }, { gstin: regex },
        { pan: regex }, { city: regex }, { state: regex },
      ];
    }
    if (status) filter.status = status;

    const [companies, total] = await Promise.all([
      Company.find(filter)
        .sort({ isDefault: -1, legalName: 1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      Company.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: companies,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    return fail(res, error);
  }
});

// ── Read one ────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Company not found.' });
    }
    const company = await Company.findById(req.params.id).lean();
    if (!company) return res.status(404).json({ success: false, message: 'Company not found.' });
    return res.json({ success: true, data: company });
  } catch (error) {
    return fail(res, error);
  }
});

// ── Create ──────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const isFirstCompany = (await Company.estimatedDocumentCount()) === 0;
    const company = await Company.create({
      legalName: req.body.legalName,
      tradeName: req.body.tradeName || '',
      // Taken as entered — the Company master does not validate GST format.
      gstin: req.body.gstin,
      pan: req.body.pan || '',
      state: req.body.state || '',
      address: req.body.address || '',
      city: req.body.city || '',
      pinCode: req.body.pinCode || '',
      phone: req.body.phone || '',
      email: req.body.email || '',
      // The first company created is automatically the primary one.
      isDefault: req.body.isDefault === true || isFirstCompany,
      status: req.body.status || 'active',
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });
    await applyDefault(company);

    return res.status(201).json({ success: true, message: 'Company created.', data: company });
  } catch (error) {
    return fail(res, error);
  }
});

// ── Update ──────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Company not found.' });
    }

    const company = await Company.findById(req.params.id);
    if (!company) return res.status(404).json({ success: false, message: 'Company not found.' });

    if (req.body.gstin !== undefined) company.gstin = req.body.gstin;
    // Field-by-field so a partial payload never blanks an untouched value.
    ['legalName', 'tradeName', 'pan', 'state', 'address', 'city', 'pinCode', 'phone', 'email', 'status', 'isDefault']
      .forEach((field) => {
        if (req.body[field] !== undefined) company[field] = req.body[field];
      });
    company.updatedBy = req.user?._id;

    await company.save();
    await applyDefault(company);

    return res.json({ success: true, message: 'Company updated.', data: company });
  } catch (error) {
    return fail(res, error);
  }
});

// ── Delete (Recycle Bin) ────────────────────────────────────────────────
router.delete('/:id', requireBranch, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Company not found.' });
    }
    const company = await Company.findById(req.params.id).lean();
    if (!company) return res.status(404).json({ success: false, message: 'Company not found.' });
    if (company.isDefault) {
      return res.status(409).json({
        success: false,
        message: 'This is the primary company. Mark another company as primary before deleting it.',
      });
    }

    const result = await safeDelete(Company, req.params.id, {
      user: req.user,
      req,
      branch: req.branchScope,
      module: 'company',
      titleField: 'legalName',
      codeField: 'gstin',
      ownership: 'global',
    });
    return res.status(result.status || 200).json(result);
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
