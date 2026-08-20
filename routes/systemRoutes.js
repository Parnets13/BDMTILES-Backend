import { Router } from 'express';
import RecycleBin from '../models/RecycleBin.js';
import ActivityLog from '../models/ActivityLog.js';
import Product from '../models/Product.js';
import SalesOrder from '../models/SalesOrder.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import Quotation from '../models/Quotation.js';
import Invoice from '../models/Invoice.js';
import Customer from '../models/Customer.js';
import StockTransfer from '../models/StockTransfer.js';
import DiscountMapping from '../models/DiscountMapping.js';
import Document from '../models/Document.js';
import Task from '../models/Task.js';
import DealerType from '../models/DealerType.js';
import DealerCategory from '../models/DealerCategory.js';
import Region from '../models/Region.js';
import Route from '../models/Route.js';
import Warehouse from '../models/Warehouse.js';
import Vehicle from '../models/Vehicle.js';
import Employee from '../models/Employee.js';
import Brand from '../models/Brand.js';
import Category from '../models/Category.js';
import Subcategory from '../models/Subcategory.js';
import User from '../models/User.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { restoreFromBin, permanentDelete, manualCleanup } from '../utils/softDelete.js';
import { logActivity } from '../middleware/activityLogger.js';

const router = Router();
router.use(protect);

// Model map for restore operations — ALL models that can be soft-deleted
const MODELS = {
  Product, SalesOrder, PurchaseOrder, Dealer, Supplier, Quotation,
  Invoice, Customer, StockTransfer, DiscountMapping, Document, Task,
  DealerType, DealerCategory, Region, Route, Warehouse, Vehicle,
  Employee, Brand, Category, Subcategory, User,
};

// ═══════════════════════════════════════
// RECYCLE BIN
// ═══════════════════════════════════════

// GET /api/v1/system/recycle-bin — list deleted items
router.get('/recycle-bin', requirePermission('users.manage'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, module } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ recordTitle: r }, { recordCode: r }, { originalModel: r }, { deletedByName: r }];
    }
    if (module) filter.module = module;

    const [data, total] = await Promise.all([
      RecycleBin.find(filter).sort({ deletedAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      RecycleBin.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/system/recycle-bin/stats
router.get('/recycle-bin/stats', requirePermission('users.manage'), async (req, res) => {
  try {
    const [total, byModule] = await Promise.all([
      RecycleBin.countDocuments(),
      RecycleBin.aggregate([{ $group: { _id: '$module', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ]);
    res.json({ success: true, data: { total, byModule } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/system/recycle-bin/:id/restore
router.post('/recycle-bin/:id/restore', requirePermission('users.manage'), async (req, res) => {
  const result = await restoreFromBin({ binId: req.params.id, models: MODELS, user: req.user, req });
  res.status(result.status || 200).json(result);
});

// DELETE /api/v1/system/recycle-bin/:id — permanent delete
router.delete('/recycle-bin/:id', requirePermission('users.manage'), async (req, res) => {
  const result = await permanentDelete({ binId: req.params.id, user: req.user, req });
  res.status(result.status || 200).json(result);
});

// POST /api/v1/system/recycle-bin/cleanup — manual cleanup
router.post('/recycle-bin/cleanup', requirePermission('users.manage'), async (req, res) => {
  const days = parseInt(req.body.olderThanDays) || 30;
  const result = await manualCleanup({ olderThanDays: days, user: req.user, req });
  res.status(result.status || 200).json(result);
});

// ═══════════════════════════════════════
// ACTIVITY LOGS
// ═══════════════════════════════════════

// GET /api/v1/system/activity-logs
router.get('/activity-logs', requirePermission('activity.logs'), async (req, res) => {
  try {
    const { page = 1, limit = 30, search, action, module, user: userId, dateFrom, dateTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 30);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ userName: r }, { description: r }, { recordTitle: r }, { module: r }];
    }
    if (action) filter.action = action;
    if (module) filter.module = module;
    if (userId) filter.user = userId;
    if (dateFrom || dateTo) {
      filter.timestamp = {};
      if (dateFrom) filter.timestamp.$gte = new Date(dateFrom);
      if (dateTo) { const d = new Date(dateTo); d.setHours(23, 59, 59); filter.timestamp.$lte = d; }
    }

    const [data, total] = await Promise.all([
      ActivityLog.find(filter).sort({ timestamp: -1 }).skip((p - 1) * l).limit(l).lean(),
      ActivityLog.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/system/activity-logs/stats
router.get('/activity-logs/stats', requirePermission('activity.logs'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [total, todayCount, byAction, byModule] = await Promise.all([
      ActivityLog.countDocuments(),
      ActivityLog.countDocuments({ timestamp: { $gte: today } }),
      ActivityLog.aggregate([{ $group: { _id: '$action', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      ActivityLog.aggregate([{ $group: { _id: '$module', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
    ]);
    res.json({ success: true, data: { total, todayCount, byAction, byModule } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/system/activity-logs/cleanup — manual cleanup
router.post('/activity-logs/cleanup', requirePermission('users.manage'), async (req, res) => {
  try {
    const days = parseInt(req.body.olderThanDays) || 60;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await ActivityLog.deleteMany({ timestamp: { $lt: cutoff } });

    await logActivity({
      user: req.user, action: 'permanent_delete', module: 'activity_log',
      description: `Manual cleanup: removed ${result.deletedCount} logs older than ${days} days`, req,
    });

    res.json({ success: true, message: `${result.deletedCount} log entries removed.`, data: { deletedCount: result.deletedCount } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
