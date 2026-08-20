import { Router } from 'express';
import Customer from '../models/Customer.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/customers — list with search/filter
router.get('/', requirePermission('dealer.master'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, customerType, status, source } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ name: r }, { contactNumber: r }, { customerCode: r }, { email: r }, { projectName: r }];
    }
    if (customerType) filter.customerType = customerType;
    if (status) filter.status = status;
    if (source) filter.source = source;

    const [data, total] = await Promise.all([
      Customer.find(filter).sort({ createdAt: -1 }).skip((p-1)*l).limit(l)
        .populate('assignedSalesExecutive', 'name').lean(),
      Customer.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/customers/stats
router.get('/stats', requirePermission('dealer.master'), async (req, res) => {
  try {
    const [total, retail, builder, architect, contractor] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ customerType: 'retail' }),
      Customer.countDocuments({ customerType: 'builder' }),
      Customer.countDocuments({ customerType: 'architect' }),
      Customer.countDocuments({ customerType: 'contractor' }),
    ]);
    res.json({ success: true, data: { total, retail, builder, architect, contractor } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/customers/:id
router.get('/:id', requirePermission('dealer.master'), async (req, res) => {
  try {
    const c = await Customer.findById(req.params.id).populate('assignedSalesExecutive', 'name').lean();
    if (!c) return res.status(404).json({ success: false, message: 'Customer not found.' });
    res.json({ success: true, data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/customers
router.post('/', requirePermission('dealer.master'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await Customer.countDocuments();
    const prefix = { retail: 'RC', builder: 'BC', architect: 'AC', contractor: 'CC' }[data.customerType] || 'CU';
    data.customerCode = `${prefix}-${String(count + 1).padStart(5, '0')}`;
    const customer = await Customer.create(data);
    res.status(201).json({ success: true, message: `Customer ${customer.customerCode} created.`, data: customer });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/v1/customers/:id
router.put('/:id', requirePermission('dealer.master'), async (req, res) => {
  try {
    const c = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!c) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Customer updated.', data: c });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/v1/customers/:id
router.delete('/:id', requirePermission('dealer.master'), async (req, res) => {
  try {
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const Customer = (await import('../models/Customer.js')).default;
    const result = await safeDelete(Customer, req.params.id, { user: req.user, module: 'customer', titleField: 'name', codeField: 'customerCode' });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
