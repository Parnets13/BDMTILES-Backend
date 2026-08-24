import { Router } from 'express';
import DealerType from '../models/DealerType.js';
import DealerCategory from '../models/DealerCategory.js';
import Region from '../models/Region.js';
import Route from '../models/Route.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import Warehouse from '../models/Warehouse.js';
import ExpenseCategory from '../models/ExpenseCategory.js';
import Vehicle from '../models/Vehicle.js';
import User from '../models/User.js';
import Expense from '../models/Expense.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// ═══════════════════════════════════════
// GENERIC CRUD HELPER (with dependency check)
// ═══════════════════════════════════════
const simpleCrud = (Model, permission, dependencyCheck) => {
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
      // Check dependencies before allowing delete
      if (dependencyCheck) {
        const depError = await dependencyCheck(req.params.id);
        if (depError) return res.status(400).json({ success: false, message: depError });
      }
      const { safeDelete } = await import('../middleware/safeDelete.js');
      const result = await safeDelete(Model, req.params.id, { user: req.user, module: Model.modelName?.toLowerCase() || 'master', titleField: 'name', skipDependencyCheck: true });
      res.status(result.status || 200).json(result);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  return r;
};

// Simple masters with dependency checks
router.use('/dealer-types', simpleCrud(DealerType, 'dealer.type', async (id) => {
  const count = await Dealer.countDocuments({ dealerType: id });
  if (count > 0) return `Cannot delete. ${count} dealer(s) are using this dealer type.`;
  return null;
}));

router.use('/dealer-categories', simpleCrud(DealerCategory, 'dealer.category', async (id) => {
  const count = await Dealer.countDocuments({ dealerCategory: id });
  if (count > 0) return `Cannot delete. ${count} dealer(s) are using this category.`;
  return null;
}));

router.use('/regions', simpleCrud(Region, 'region.master', async (id) => {
  const [routeCount, warehouseCount, dealerCount] = await Promise.all([
    Route.countDocuments({ region: id }),
    Warehouse.countDocuments({ region: id }),
    Dealer.countDocuments({ assignedRegion: id }),
  ]);
  const errors = [];
  if (routeCount > 0) errors.push(`${routeCount} route(s)`);
  if (warehouseCount > 0) errors.push(`${warehouseCount} warehouse(s)`);
  if (dealerCount > 0) errors.push(`${dealerCount} dealer(s)`);
  if (errors.length > 0) return `Cannot delete. Used by: ${errors.join(', ')}.`;
  return null;
}));

router.use('/expense-categories', simpleCrud(ExpenseCategory, 'expense.category', async (id) => {
  const count = await Expense.countDocuments({ category: id });
  if (count > 0) return `Cannot delete. ${count} expense(s) are using this category.`;
  return null;
}));

// ═══════════════════════════════════════
// WAREHOUSES (full CRUD with populate)
// ═══════════════════════════════════════
const warehouseRouter = Router();
warehouseRouter.use(requirePermission('warehouse.master'));

warehouseRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, status, region } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 50);
    let filter = {};
    if (search) {
      const rx = new RegExp(search, 'i');
      filter.$or = [{ name: rx }, { city: rx }, { managerName: rx }, { warehouseCode: rx }];
    }
    if (status) filter.status = status;
    if (region) filter.region = region;
    const [items, total] = await Promise.all([
      Warehouse.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l)
        .populate('region', 'name').lean(),
      Warehouse.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

warehouseRouter.post('/', async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    if (!data.warehouseCode) {
      const count = await Warehouse.countDocuments();
      data.warehouseCode = `WH${String(count + 1).padStart(4, '0')}`;
    }
    const wh = await Warehouse.create(data);
    res.status(201).json({ success: true, message: 'Warehouse created.', data: wh });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Warehouse name already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

warehouseRouter.put('/:id', async (req, res) => {
  try {
    const wh = await Warehouse.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('region', 'name');
    if (!wh) return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    res.json({ success: true, message: 'Warehouse updated.', data: wh });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Warehouse name already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

warehouseRouter.delete('/:id', async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Warehouse, req.params.id, { user: req.user, module: 'warehouse', titleField: 'name' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use('/warehouses', warehouseRouter);

// ═══════════════════════════════════════
// ROUTES (full CRUD with populate)
// ═══════════════════════════════════════
const routeRouter = Router();
routeRouter.use(requirePermission('route.master'));

routeRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, status, region } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 50);
    let filter = {};
    if (search) filter.name = new RegExp(search, 'i');
    if (status) filter.status = status;
    if (region) filter.region = region;
    const [items, total] = await Promise.all([
      Route.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l)
        .populate('region', 'name')
        .populate('assignedSE', 'name phone')
        .lean(),
      Route.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

routeRouter.post('/', async (req, res) => {
  try {
    const route = await Route.create({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ success: true, message: 'Route created.', data: route });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Route name already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

routeRouter.put('/:id', async (req, res) => {
  try {
    const route = await Route.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('region', 'name')
      .populate('assignedSE', 'name phone');
    if (!route) return res.status(404).json({ success: false, message: 'Route not found.' });
    res.json({ success: true, message: 'Route updated.', data: route });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Route name already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

routeRouter.delete('/:id', async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Route, req.params.id, { user: req.user, module: 'route', titleField: 'name' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use('/routes', routeRouter);

// ═══════════════════════════════════════
// DEALERS (full CRUD with populate)
// ═══════════════════════════════════════
const dealerRouter = Router();
dealerRouter.use(requirePermission('dealer.master'));

dealerRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, dealerType, region, route: routeId, pricingTier } = req.query;
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

    // Filter by pricingTier: find DealerType IDs that match the tier, then filter dealers
    if (pricingTier) {
      const matchingTypes = await DealerType.find({ pricingTier, status: 'active' }).select('_id').lean();
      const typeIds = matchingTypes.map(t => t._id);
      if (typeIds.length > 0) {
        filter.dealerType = { $in: typeIds };
      } else {
        // No matching dealer types — return empty
        return res.json({ success: true, data: [], pagination: { currentPage: p, totalPages: 0, totalItems: 0, itemsPerPage: l } });
      }
    }

    const [dealers, total] = await Promise.all([
      Dealer.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealerType', 'name pricingTier')
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
      const { generateUniqueCode } = await import('../utils/codeGenerator.js');
      data.dealerCode = await generateUniqueCode(Dealer, 'dealerCode', 'DLR', 5);
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
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Dealer, req.params.id, {
      user: req.user,
      module: 'dealer',
      titleField: 'businessName',
      codeField: 'dealerCode',
    });
    res.status(result.status || 200).json(result);
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
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Supplier, req.params.id, { user: req.user, module: 'supplier', titleField: 'companyName', codeField: 'supplierCode' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use('/suppliers', supplierRouter);

// ═══════════════════════════════════════
// VEHICLES
// ═══════════════════════════════════════
const vehicleRouter = Router();
vehicleRouter.use(requirePermission('vehicle.master'));

vehicleRouter.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 100, search, isActive } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 100);
    let filter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ vehicleNumber: regex }, { driverName: regex }, { make: regex }];
    }
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    const [vehicles, total] = await Promise.all([
      Vehicle.find(filter).sort({ vehicleNumber: 1 }).skip((p-1)*l).limit(l).lean(),
      Vehicle.countDocuments(filter),
    ]);
    res.json({ success: true, data: vehicles, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

vehicleRouter.post('/', async (req, res) => {
  try {
    const vehicle = await Vehicle.create({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ success: true, message: 'Vehicle added.', data: vehicle });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Vehicle number already exists.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

vehicleRouter.put('/:id', async (req, res) => {
  try {
    const vehicle = await Vehicle.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!vehicle) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Vehicle updated.', data: vehicle });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

vehicleRouter.delete('/:id', async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Vehicle, req.params.id, { user: req.user, module: 'vehicle', titleField: 'vehicleNumber' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use('/vehicles', vehicleRouter);

export default router;
