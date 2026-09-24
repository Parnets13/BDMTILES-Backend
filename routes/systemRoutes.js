import { Router } from 'express';
import mongoose from 'mongoose';
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
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { restoreFromBin, permanentDelete, manualCleanup } from '../utils/softDelete.js';
import { logActivity } from '../middleware/activityLogger.js';
import { releaseExpiredApprovalReservations } from '../services/reservationExpiryService.js';
import { integrationReadiness, systemDiagnostics } from '../services/systemCapabilityService.js';

const router = Router();
router.use(protect);

const LOG_VIEW_PERMISSIONS = requireAnyPermission('activity.logs', 'audit.trail', 'download.logs', 'users.manage');

// Recycle-bin operations were gated on users.manage, which is administrative
// authority over the whole user directory. Now grantable separately.
const canViewRecycleBin = requireAnyPermission('recycle.bin.view', 'recycle.bin', 'users.manage');
const canRestoreFromBin = requireAnyPermission('recycle.bin.restore', 'recycle.bin', 'users.manage');
const canPurgeFromBin = requireAnyPermission('recycle.bin.purge', 'recycle.bin', 'users.manage');
router.use(requireBranch);

// Explicitly allow only records that use generic recycle restoration. User identity is never restored here.
const MODELS = {
  Product, SalesOrder, PurchaseOrder, Dealer, Supplier, Quotation,
  Invoice, Customer, StockTransfer, DiscountMapping, Document, Task,
  DealerType, DealerCategory, Region, Route, Warehouse, Vehicle,
  Employee, Brand, Category, Subcategory,
};

router.get('/recycle-bin', canViewRecycleBin, async (req, res) => {
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

router.get('/recycle-bin/stats', canViewRecycleBin, async (req, res) => {
  try {
    const branchMatch = { branch: req.branchId };
    // The collection has a 30-day TTL, so anything deleted 23+ days ago is inside
    // its final week. Nothing warned anyone about that before.
    const RETENTION_DAYS = 30;
    const expiringCutoff = new Date(Date.now() - (RETENTION_DAYS - 7) * 86400000);
    const [total, byModule, expiringSoon] = await Promise.all([
      RecycleBin.countDocuments(branchMatch),
      RecycleBin.aggregate([
        { $match: branchMatch },
        { $group: { _id: '$module', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      RecycleBin.countDocuments({ ...branchMatch, deletedAt: { $lte: expiringCutoff } }),
    ]);
    return res.json({
      success: true,
      data: { total, byModule, expiringSoon, retentionDays: RETENTION_DAYS },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/recycle-bin/:id/restore', canRestoreFromBin, async (req, res) => {
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

router.delete('/recycle-bin/:id', canPurgeFromBin, async (req, res) => {
  res.locals.skipAutoActivityLog = true;
  const result = await permanentDelete({
    binId: req.params.id,
    user: req.user,
    branch: req.branchId,
    req,
  });
  return res.status(result.status || 200).json(result);
});

router.post('/recycle-bin/cleanup', canPurgeFromBin, async (req, res) => {
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

// The audit views (login history, data-modification history, approval history,
// download logs) all read this endpoint, so any of the log permissions grants it
// rather than activity.logs alone.

// `action` and `module` accept either a single value or a comma-separated list,
// which is how the preset log views filter to e.g. login+logout in one request.
const listFilter = (value) => {
  const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length) return null;
  return items.length === 1 ? items[0] : { $in: items };
};

router.get('/activity-logs', LOG_VIEW_PERMISSIONS, async (req, res) => {
  try {
    const { page = 1, limit = 30, search, action, module, user: userId, dateFrom, dateTo } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ userName: regex }, { description: regex }, { recordTitle: regex }, { module: regex }];
    }
    const actionFilter = listFilter(action);
    const moduleFilter = listFilter(module);
    if (actionFilter) filter.action = actionFilter;
    if (moduleFilter) filter.module = moduleFilter;
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

router.get('/activity-logs/stats', LOG_VIEW_PERMISSIONS, async (req, res) => {
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

router.post('/inventory/release-expired-reservations', requirePermission('system.management'), async (req, res) => {
  try {
    const summary = await releaseExpiredApprovalReservations({ branch: req.branchId, actor: req.user._id, now: new Date() });
    return res.json({ success: true, message: `${summary.released} expired reservation(s) released.`, data: summary });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════
// SYSTEM HEALTH & INTEGRATION READINESS
// ═══════════════════════════════════════
// Read-only reporting. There is deliberately no endpoint that stores integration
// credentials, because no integration has client code to use them.

router.get('/health', requirePermission('system.management'), async (req, res) => {
  try {
    const data = await systemDiagnostics({ branchId: req.branchId });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/integrations', requirePermission('system.management'), async (req, res) => {
  try {
    const data = await integrationReadiness();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ═══════════════════════════════════════
// DEALER MOBILE APP ACCESS CONTROL
// ═══════════════════════════════════════
// Dealer.appAccess gates every Dealer App entry point, but until now the only way
// to set it was a CLI script on the server. These routes put it in the admin's
// hands. Dealers are not branch-scoped (the model has no branch field), so these
// queries are intentionally global.

const dealerAppAccess = [requirePermission('dealer.app.manage')];

const validDealerId = (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(400).json({ success: false, message: 'Dealer identifier is invalid.' });
  return false;
};

router.get('/app-access/dealers', ...dealerAppAccess, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, appAccess, status } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));

    const filter = {};
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ businessName: regex }, { ownerName: regex }, { mobile: regex }, { dealerCode: regex }];
    }
    if (appAccess === 'true') filter.appAccess = true;
    if (appAccess === 'false') filter.appAccess = { $ne: true };
    if (status) filter.status = status;

    const [dealers, total, stats] = await Promise.all([
      Dealer.find(filter)
        .select('dealerCode businessName ownerName mobile status appAccess biometricEnabled appLastLoginAt appDevices tokenVersion pinHash')
        .sort({ businessName: 1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      Dealer.countDocuments(filter),
      Dealer.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            appEnabled: { $sum: { $cond: ['$appAccess', 1, 0] } },
            blocked: { $sum: { $cond: [{ $eq: ['$status', 'blocked'] }, 1, 0] } },
            everLoggedIn: { $sum: { $cond: [{ $ifNull: ['$appLastLoginAt', false] }, 1, 0] } },
          },
        },
      ]),
    ]);

    return res.json({
      success: true,
      data: dealers.map(({ pinHash, appDevices, ...dealer }) => ({
        ...dealer,
        // Never leak the hash; the admin only needs to know whether a PIN is set.
        pinSet: Boolean(pinHash),
        deviceCount: (appDevices || []).length,
        devices: (appDevices || []).map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          platform: device.platform,
          appVersion: device.appVersion,
          lastSeenAt: device.lastSeenAt,
        })),
      })),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
      stats: stats[0]
        ? { total: stats[0].total, appEnabled: stats[0].appEnabled, blocked: stats[0].blocked, everLoggedIn: stats[0].everLoggedIn }
        : { total: 0, appEnabled: 0, blocked: 0, everLoggedIn: 0 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/app-access/dealers/:id', ...dealerAppAccess, async (req, res) => {
  try {
    if (!validDealerId(req, res)) return;
    const { appAccess } = req.body;
    if (typeof appAccess !== 'boolean') {
      return res.status(400).json({ success: false, message: 'appAccess must be true or false.' });
    }

    const dealer = await Dealer.findById(req.params.id).select('+pinHash');
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });
    if (appAccess && dealer.status !== 'active') {
      return res.status(409).json({
        success: false,
        message: `This dealer is ${dealer.status}. Activate the dealer before granting app access.`,
      });
    }

    const wasEnabled = dealer.appAccess === true;
    dealer.appAccess = appAccess;
    // Revoking access must also end live sessions, otherwise an already-issued
    // token keeps working until it expires.
    if (wasEnabled && !appAccess) dealer.tokenVersion = (dealer.tokenVersion || 0) + 1;
    await dealer.save();

    await logActivity({
      req,
      action: 'update',
      module: 'dealer',
      description: `Dealer App access ${appAccess ? 'enabled' : 'revoked'} for ${dealer.businessName}`,
      recordId: dealer._id,
      recordModel: 'Dealer',
    });

    return res.json({
      success: true,
      message: appAccess
        ? `Dealer App access enabled for ${dealer.businessName}.`
        : `Dealer App access revoked for ${dealer.businessName}. Active sessions were ended.`,
      data: { _id: dealer._id, appAccess: dealer.appAccess, pinSet: Boolean(dealer.pinHash) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Bulk enable/disable. Dealers that cannot be changed are reported back rather
// than silently skipped, so the admin knows the operation was partial.
router.post('/app-access/dealers/bulk', ...dealerAppAccess, async (req, res) => {
  try {
    const { dealerIds, appAccess } = req.body;
    if (!Array.isArray(dealerIds) || dealerIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one dealer.' });
    }
    if (dealerIds.length > 200) {
      return res.status(400).json({ success: false, message: 'Change at most 200 dealers at a time.' });
    }
    if (typeof appAccess !== 'boolean') {
      return res.status(400).json({ success: false, message: 'appAccess must be true or false.' });
    }
    const invalid = dealerIds.filter((id) => !mongoose.isValidObjectId(id));
    if (invalid.length) {
      return res.status(400).json({ success: false, message: `${invalid.length} dealer identifier(s) are invalid.` });
    }

    const dealers = await Dealer.find({ _id: { $in: dealerIds } }).select('businessName status appAccess tokenVersion');
    const changed = [];
    const skipped = [];

    for (const dealer of dealers) {
      if (appAccess && dealer.status !== 'active') {
        skipped.push({ _id: dealer._id, businessName: dealer.businessName, reason: `Dealer is ${dealer.status}.` });
        continue;
      }
      if (dealer.appAccess === appAccess) {
        skipped.push({ _id: dealer._id, businessName: dealer.businessName, reason: 'Already in that state.' });
        continue;
      }
      if (dealer.appAccess && !appAccess) dealer.tokenVersion = (dealer.tokenVersion || 0) + 1;
      dealer.appAccess = appAccess;
      await dealer.save();
      changed.push({ _id: dealer._id, businessName: dealer.businessName });
    }

    const missing = dealerIds.length - dealers.length;
    if (changed.length) {
      await logActivity({
        req,
        action: 'update',
        module: 'dealer',
        description: `Dealer App access ${appAccess ? 'enabled' : 'revoked'} in bulk for ${changed.length} dealer(s)`,
      });
    }

    return res.json({
      success: true,
      message: `${changed.length} dealer(s) updated${skipped.length ? `, ${skipped.length} skipped` : ''}${missing > 0 ? `, ${missing} not found` : ''}.`,
      data: { changed, skipped, notFound: missing },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Force a logout from every device by invalidating issued tokens.
router.post('/app-access/dealers/:id/revoke-sessions', ...dealerAppAccess, async (req, res) => {
  try {
    if (!validDealerId(req, res)) return;
    const dealer = await Dealer.findById(req.params.id).select('businessName tokenVersion appDevices');
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });

    const deviceCount = (dealer.appDevices || []).length;
    dealer.tokenVersion = (dealer.tokenVersion || 0) + 1;
    dealer.appDevices = [];
    await dealer.save();

    await logActivity({
      req,
      action: 'update',
      module: 'dealer',
      description: `Dealer App sessions revoked for ${dealer.businessName} (${deviceCount} device(s))`,
      recordId: dealer._id,
      recordModel: 'Dealer',
    });

    return res.json({
      success: true,
      message: `Signed out of ${deviceCount} device(s). The dealer must log in again.`,
      data: { _id: dealer._id, tokenVersion: dealer.tokenVersion },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Clear the login PIN so the dealer is forced back through OTP to set a new one.
router.post('/app-access/dealers/:id/reset-pin', ...dealerAppAccess, async (req, res) => {
  try {
    if (!validDealerId(req, res)) return;
    const dealer = await Dealer.findById(req.params.id).select('businessName tokenVersion');
    if (!dealer) return res.status(404).json({ success: false, message: 'Dealer not found.' });

    dealer.pinHash = null;
    dealer.biometricEnabled = false;
    // A cleared PIN has to invalidate sessions too, or the dealer stays signed in
    // on an old token and never goes through OTP again.
    dealer.tokenVersion = (dealer.tokenVersion || 0) + 1;
    await dealer.save();

    await logActivity({
      req,
      action: 'update',
      module: 'dealer',
      description: `Dealer App PIN reset for ${dealer.businessName}`,
      recordId: dealer._id,
      recordModel: 'Dealer',
    });

    return res.json({
      success: true,
      message: `PIN cleared for ${dealer.businessName}. They will set a new one after an OTP login.`,
      data: { _id: dealer._id, pinSet: false },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
