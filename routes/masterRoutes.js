import { Router } from 'express';
import DealerType from '../models/DealerType.js';
import DealerCategory from '../models/DealerCategory.js';
import Region from '../models/Region.js';
import Route from '../models/Route.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import Warehouse from '../models/Warehouse.js';
import ExpenseCategory from '../models/ExpenseCategory.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ═══════════════════════════════════════
// GENERIC CRUD HELPER
// ═══════════════════════════════════════
const simpleCrud = (Model, permission) => {
  const r = Router();
  r.use(requirePermission(permission));

  r.get('/', async (req, res) => {
    try {
      const { page = 1, limit = 50, search, status } = req.query;
      const p = Math.max(1, parseInt(page));
      const l = Math.min(100, parseInt(limit) || 50);
      let filter = {};
      if (search) filter.name = new RegExp(search, 'i');
      if (status) filter.status = status;
      const [items, total] = await Promise.all([
        Model.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l).lean(),
        Model.countDocuments(filter),
      ]);
      res.json({ success: true, data: items, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  r.post('/', async (req, res) => {
    try {
      const item = await Model.create({ ...req.body, createdBy: req.user._id });
      res.status(201).json({ success: true, message: 'Created.', data: item });
    } catch (e) {
      if (e.code === 11000) return res.status(400).json({ success: false, message: 'Already exists.' });
      res.status(500).json({ success: false, message: e.message });
    }
  });

  r.put('/:id', async (req, res) => {
    try {
      const item = await Model.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
      if (!item) return res.status(404).json({ success: false, message: 'Not found.' });
      res.json({ success: true, message: 'Updated.', data: item });
    } catch (e) {
      if (e.code === 11000) return res.status(400).json({ success: false, message: 'Name already exists.' });
      res.status(500).json({ success: false, message: e.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const item = await Model.findByIdAndDelete(req.params.id);
      if (!item) return res.status(404).json({ success: false, message: 'Not found.' });
      res.json({ success: true, message: 'Deleted.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  return r;
};

// Simple masters
router.use('/dealer-types', simpleCrud(DealerType, 'dealer.type'));
router.use('/dealer-categories', simpleCrud(DealerCategory, 'dealer.category'));
router.use('/regions', simpleCrud(Region, 'region.master'));
router.use('/routes', simpleCrud(Route, 'route.master'));
router.use('/expense-categories', simpleCrud(ExpenseCategory, 'expense.category'));
router.use('/warehouses', simpleCrud(Warehouse, 'warehouse.master'));

// ═══════════════════════════════════════
// DEALERS (full CRUD with populate)
// ═══════════════════════════════════════
const dealerRouter = Router();
dealerRouter.use(requirePermission('dealer.master'));

dealerRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealerType, region, route: routeId } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ businessName: regex }, { ownerName: regex }, { mobile: regex }, { dealerCode: regex }, { city: regex }];
    }
    if (status) filter.status = status;
    if (dealerType) filter.dealerType = dealerType;
    if (region) filter.assignedRegion = region;
    if (routeId) filter.assignedRoute = routeId;

    const [dealers, total] = await Promise.all([
      Dealer.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealerType', 'name')
        .populate('dealerCategory', 'name')
        .populate('assignedRegion', 'name')
        .populate('assignedRoute', 'name')
        .lean(),
      Dealer.countDocuments(filter),
    ]);

    res.json({ success: true, data: dealers, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

dealerRouter.get('/stats', async (req, res) => {
  try {
    const [total, active, inactive, blocked] = await Promise.all([
      Dealer.countDocuments(),
      Dealer.countDocuments({ status: 'active' }),
      Dealer.countDocuments({ status: 'inactive' }),
      Dealer.countDocuments({ status: 'blocked' }),
    ]);
    res.json({ success: true, data: { total, active, inactive, blocked } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

dealerRouter.get('/:id', async (req, res) => {
  try {
    const dealer = await Dealer.findById(req.params.id)
      .populate('dealerType', 'name')
      .populate('dealerCategory', 'name')
      .populate('assignedRegion', 'name')
      .populate('assignedRoute', 'name')
      .populate('assignedSalesExecutive', 'name phone')
      .lean();
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });
    res.json({ success: true, data: dealer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

dealerRouter.post('/', async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    if (!data.dealerCode) {
      const count = await Dealer.countDocuments();
      data.dealerCode = `DLR${String(count + 1).padStart(5, '0')}`;
    }
    const dealer = await Dealer.create(data);
    res.status(201).json({ success: true, message: 'Dealer created.', data: dealer });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Dealer code already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

dealerRouter.put('/:id', async (req, res) => {
  try {
    const dealer = await Dealer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('dealerType', 'name')
      .populate('dealerCategory', 'name')
      .populate('assignedRegion', 'name');
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });
    res.json({ success: true, message: 'Dealer updated.', data: dealer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

dealerRouter.delete('/:id', async (req, res) => {
  try {
    const dealer = await Dealer.findByIdAndDelete(req.params.id);
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });
    res.json({ success: true, message: 'Dealer deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use('/dealers', dealerRouter);

// ═══════════════════════════════════════
// SUPPLIERS (full CRUD)
// ═══════════════════════════════════════
const supplierRouter = Router();
supplierRouter.use(requirePermission('supplier.master'));

supplierRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ companyName: regex }, { contactPerson: regex }, { mobile: regex }, { supplierCode: regex }, { city: regex }];
    }
    if (status) filter.status = status;
    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Supplier.countDocuments(filter),
    ]);
    res.json({ success: true, data: suppliers, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

supplierRouter.get('/:id', async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id).lean();
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    res.json({ success: true, data: supplier });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

supplierRouter.post('/', async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    if (!data.supplierCode) {
      const count = await Supplier.countDocuments();
      data.supplierCode = `SUP${String(count + 1).padStart(5, '0')}`;
    }
    const supplier = await Supplier.create(data);
    res.status(201).json({ success: true, message: 'Supplier created.', data: supplier });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Supplier code already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

supplierRouter.put('/:id', async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    res.json({ success: true, message: 'Supplier updated.', data: supplier });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

supplierRouter.delete('/:id', async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndDelete(req.params.id);
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found.' });
    res.json({ success: true, message: 'Supplier deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use('/suppliers', supplierRouter);

export default router;
