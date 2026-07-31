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
router.use('/expense-categories', simpleCrud(ExpenseCategory, 'expense.category'));

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
    const wh = await Warehouse.findByIdAndDelete(req.params.id);
    if (!wh) return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    res.json({ success: true, message: 'Warehouse deleted.' });
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
    const route = await Route.findByIdAndDelete(req.params.id);
    if (!route) return res.status(404).json({ success: false, message: 'Route not found.' });
    res.json({ success: true, message: 'Route deleted.' });
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
    const vehicle = await Vehicle.findByIdAndDelete(req.params.id);
    if (!vehicle) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Vehicle deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use('/vehicles', vehicleRouter);

export default router;
