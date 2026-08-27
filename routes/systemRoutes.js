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
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { restoreFromBin, permanentDelete, manualCleanup } from '../utils/softDelete.js';
import { logActivity } from '../middleware/activityLogger.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

// Explicitly allow only records that use generic recycle restoration. User identity is never restored here.
const MODELS = {
  Product, SalesOrder, PurchaseOrder, Dealer, Supplier, Quotation,
  Invoice, Customer, StockTransfer, DiscountMapping, Document, Task,
  DealerType, DealerCategory, Region, Route, Warehouse, Vehicle,
  Employee, Brand, Category, Subcategory,
};

router.get('/recycle-bin', requirePermission('users.manage'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, module } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { recordTitle: regex }, { recordCode: regex }, { originalModel: regex }, { deletedByName: regex },
      ];
    }
    if (module) filter.module = module;

    const [data, total] = await Promise.all([
      RecycleBin.find(filter).sort({ deletedAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      RecycleBin.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/recycle-bin/stats', requirePermission('users.manage'), async (req, res) => {
  try {
    const branchMatch = { branch: req.branchId };
    const [total, byModule] = await Promise.all([
      RecycleBin.countDocuments(branchMatch),
      RecycleBin.aggregate([
        { $match: branchMatch },
        { $group: { _id: '$module', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);
    return res.json({ success: true, data: { total, byModule } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/recycle-bin/:id/restore', requirePermission('users.manage'), async (req, res) => {
  res.locals.skipAutoActivityLog = true;
  const result = await restoreFromBin({
    binId: req.params.id,
    models: MODELS,
    user: req.user,
    branch: req.branchId,
    req,
  });
  return res.status(result.status || 200).json(result);
});

router.delete('/recycle-bin/:id', requirePermission('users.manage'), async (req, res) => {
  res.locals.skipAutoActivityLog = true;
  const result = await permanentDelete({
    binId: req.params.id,
    user: req.user,
    branch: req.branchId,
    req,
  });
  return res.status(result.status || 200).json(result);
});

router.post('/recycle-bin/cleanup', requirePermission('users.manage'), async (req, res) => {
  res.locals.skipAutoActivityLog = true;
  const days = Number.parseInt(req.body.olderThanDays, 10) || 30;
  const result = await manualCleanup({
    olderThanDays: days,
    user: req.user,
    branch: req.branchId,
    req,
  });
  return res.status(result.status || 200).json(result);
});

router.get('/activity-logs', requirePermission('activity.logs'), async (req, res) => {
  try {
    const { page = 1, limit = 30, search, action, module, user: userId, dateFrom, dateTo } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ userName: regex }, { description: regex }, { recordTitle: regex }, { module: regex }];
    }
    if (action) filter.action = action;
    if (module) filter.module = module;
    if (userId) filter.user = userId;
    if (dateFrom || dateTo) {
      filter.timestamp = {};
      if (dateFrom) filter.timestamp.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        filter.timestamp.$lte = end;
      }
    }

    const [data, total] = await Promise.all([
      ActivityLog.find(filter).sort({ timestamp: -1 }).skip((p - 1) * l).limit(l).lean(),
      ActivityLog.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/activity-logs/stats', requirePermission('activity.logs'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const branchMatch = { branch: req.branchId };
    const [total, todayCount, byAction, byModule] = await Promise.all([
      ActivityLog.countDocuments(branchMatch),
      ActivityLog.countDocuments({ ...branchMatch, timestamp: { $gte: today } }),
      ActivityLog.aggregate([
        { $match: branchMatch },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      ActivityLog.aggregate([
        { $match: branchMatch },
        { $group: { _id: '$module', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);
    return res.json({ success: true, data: { total, todayCount, byAction, byModule } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/activity-logs/cleanup', requirePermission('users.manage'), async (req, res) => {
  try {
    res.locals.skipAutoActivityLog = true;
    const days = Number.parseInt(req.body.olderThanDays, 10) || 60;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await ActivityLog.deleteMany({
      branch: req.branchId,
      timestamp: { $lt: cutoff },
    });

    await logActivity({
      user: req.user,
      action: 'permanent_delete',
      module: 'activity_log',
      description: `Manual cleanup: removed ${result.deletedCount} logs older than ${days} days`,
      branch: req.branchId,
      req,
    });

    return res.json({
      success: true,
      message: `${result.deletedCount} log entries removed.`,
      data: { deletedCount: result.deletedCount },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
