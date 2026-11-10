import express from 'express';
import { requirePermission, requireAnyPermission } from '../middleware/auth.js';
import {
  getExecutivePerformance,
  getExecutiveLeaderboard,
  getMyDealerPerformance,
} from '../services/performanceTrackingService.js';

const router = express.Router();

const asyncRoute = (handler) => (req, res, next) => handler(req, res).catch(next);

/**
 * GET /api/v1/performance/me
 * Get my performance metrics (for sales executives)
 */
router.get(
  '/me',
  requirePermission('se_app'),
  asyncRoute(async (req, res) => {
    const { startDate, endDate } = req.query;

    const performance = await getExecutivePerformance({
      branchId: req.branchId,
      executiveId: req.user._id,
      startDate,
      endDate,
    });

    res.json({ success: true, data: performance });
  })
);

/**
 * GET /api/v1/performance/my-dealers
 * Get performance of dealers assigned to me
 */
router.get(
  '/my-dealers',
  requirePermission('se_app'),
  asyncRoute(async (req, res) => {
    const { startDate, endDate } = req.query;

    const dealerPerformance = await getMyDealerPerformance({
      branchId: req.branchId,
      executiveId: req.user._id,
      startDate,
      endDate,
    });

    res.json({ success: true, data: dealerPerformance });
  })
);

/**
 * GET /api/v1/performance/executive/:id
 * Get performance of a specific executive (for managers)
 */
router.get(
  '/executive/:id',
  requireAnyPermission('sales.management', 'lead.assign'),
  asyncRoute(async (req, res) => {
    const { startDate, endDate } = req.query;

    const performance = await getExecutivePerformance({
      branchId: req.branchScope,
      executiveId: req.params.id,
      startDate,
      endDate,
    });

    res.json({ success: true, data: performance });
  })
);

/**
 * GET /api/v1/performance/leaderboard
 * Get leaderboard of all sales executives
 */
router.get(
  '/leaderboard',
  requireAnyPermission('sales.management', 'lead.assign', 'se_app'),
  asyncRoute(async (req, res) => {
    const { startDate, endDate, sortBy } = req.query;

    const leaderboard = await getExecutiveLeaderboard({
      branchId: req.branchScope || req.branchId,
      startDate,
      endDate,
      sortBy,
    });

    res.json({ success: true, data: leaderboard });
  })
);

export default router;
