import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import SalesOrder from '../models/SalesOrder.js';
import Payment from '../models/Payment.js';
import User from '../models/User.js';
import Dealer from '../models/Dealer.js';

/**
 * Sales Executive Performance Tracking Service
 * Tracks KPIs: leads, conversions, sales, collections, follow-ups
 */

const objectId = (value) => new mongoose.Types.ObjectId(String(value));

/**
 * Get performance metrics for a sales executive
 */
export const getExecutivePerformance = async ({ branchId, executiveId, startDate, endDate }) => {
  const matchStage = {
    branch: branchId,
    assignedTo: objectId(executiveId),
  };

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  // Lead metrics
  const [leadStats] = await Lead.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalLeads: { $sum: 1 },
        acceptedLeads: { $sum: { $cond: [{ $eq: ['$assignmentStatus', 'accepted'] }, 1, 0] } },
        declinedLeads: { $sum: { $cond: [{ $eq: ['$assignmentStatus', 'declined'] }, 1, 0] } },
        wonLeads: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
        lostLeads: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
        totalFollowups: { $sum: '$totalFollowups' },
        totalConversionValue: {
          $sum: { $cond: [{ $eq: ['$status', 'won'] }, '$conversionValue', 0] },
        },
        totalIncentiveEarned: {
          $sum: { $cond: [{ $eq: ['$incentiveStatus', 'earned'] }, '$incentiveAmount', 0] },
        },
      },
    },
  ]);

  // Sales Order metrics
  const orderMatchStage = { branch: branchId, createdBy: objectId(executiveId) };
  if (startDate || endDate) {
    orderMatchStage.orderDate = {};
    if (startDate) orderMatchStage.orderDate.$gte = new Date(startDate);
    if (endDate) orderMatchStage.orderDate.$lte = new Date(endDate);
  }

  const [orderStats] = await SalesOrder.aggregate([
    { $match: orderMatchStage },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalOrderValue: { $sum: '$grandTotal' },
        approvedOrders: { $sum: { $cond: [{ $eq: ['$approvalStatus', 'approved'] }, 1, 0] } },
      },
    },
  ]);

  // Collection metrics (using Payment model with isFieldCollection = true)
  const collectionMatchStage = { 
    branch: branchId, 
    collectedBy: objectId(executiveId),
    isFieldCollection: true,
    paymentType: 'dealer_receipt'
  };
  if (startDate || endDate) {
    collectionMatchStage.paymentDate = {};
    if (startDate) collectionMatchStage.paymentDate.$gte = new Date(startDate);
    if (endDate) collectionMatchStage.paymentDate.$lte = new Date(endDate);
  }

  const [collectionStats] = await Payment.aggregate([
    { $match: collectionMatchStage },
    {
      $group: {
        _id: null,
        totalCollections: { $sum: 1 },
        totalAmountCollected: { $sum: '$amount' },
      },
    },
  ]);

  // Calculate conversion rate
  const totalAssigned = (leadStats?.totalLeads || 0);
  const wonLeads = (leadStats?.wonLeads || 0);
  const conversionRate = totalAssigned > 0 ? ((wonLeads / totalAssigned) * 100).toFixed(2) : 0;

  // Calculate acceptance rate
  const acceptedLeads = (leadStats?.acceptedLeads || 0);
  const declinedLeads = (leadStats?.declinedLeads || 0);
  const totalResponded = acceptedLeads + declinedLeads;
  const acceptanceRate = totalResponded > 0 ? ((acceptedLeads / totalResponded) * 100).toFixed(2) : 0;

  return {
    executiveId,
    period: { startDate, endDate },
    leads: {
      totalAssigned: totalAssigned,
      accepted: acceptedLeads,
      declined: declinedLeads,
      won: wonLeads,
      lost: leadStats?.lostLeads || 0,
      conversionRate: Number(conversionRate),
      acceptanceRate: Number(acceptanceRate),
      totalFollowups: leadStats?.totalFollowups || 0,
      averageFollowups: totalAssigned > 0 ? ((leadStats?.totalFollowups || 0) / totalAssigned).toFixed(2) : 0,
    },
    sales: {
      totalOrders: orderStats?.totalOrders || 0,
      totalValue: orderStats?.totalOrderValue || 0,
      approvedOrders: orderStats?.approvedOrders || 0,
    },
    collections: {
      totalCollections: collectionStats?.totalCollections || 0,
      totalAmount: collectionStats?.totalAmountCollected || 0,
    },
    incentives: {
      totalEarned: leadStats?.totalIncentiveEarned || 0,
      conversionValue: leadStats?.totalConversionValue || 0,
    },
  };
};

/**
 * Get leaderboard for all sales executives in a branch
 */
export const getExecutiveLeaderboard = async ({ branchId, startDate, endDate, sortBy = 'conversionValue' }) => {
  const executives = await User.find({
    role: 'sales_executive',
    status: 'Active',
    assignedBranches: branchId,
  }).select('_id name phone email').lean();

  const performances = await Promise.all(
    executives.map(async (executive) => {
      const perf = await getExecutivePerformance({
        branchId,
        executiveId: executive._id,
        startDate,
        endDate,
      });
      return {
        ...executive,
        performance: perf,
        score: calculatePerformanceScore(perf),
      };
    })
  );

  // Sort by specified metric
  const sortedPerformances = performances.sort((a, b) => {
    switch (sortBy) {
      case 'conversionValue':
        return b.performance.incentives.conversionValue - a.performance.incentives.conversionValue;
      case 'conversionRate':
        return b.performance.leads.conversionRate - a.performance.leads.conversionRate;
      case 'totalOrders':
        return b.performance.sales.totalOrders - a.performance.sales.totalOrders;
      case 'totalCollections':
        return b.performance.collections.totalAmount - a.performance.collections.totalAmount;
      case 'score':
      default:
        return b.score - a.score;
    }
  });

  return sortedPerformances.map((exec, index) => ({
    rank: index + 1,
    ...exec,
  }));
};

/**
 * Calculate overall performance score (0-100)
 */
const calculatePerformanceScore = (performance) => {
  const weights = {
    conversionRate: 0.3,
    acceptanceRate: 0.15,
    totalOrders: 0.25,
    collections: 0.2,
    followups: 0.1,
  };

  // Normalize metrics to 0-100 scale
  const conversionScore = Math.min(performance.leads.conversionRate * 2, 100); // 50% = max
  const acceptanceScore = Math.min(performance.leads.acceptanceRate, 100);
  const orderScore = Math.min((performance.sales.totalOrders / 10) * 100, 100); // 10 orders = max
  const collectionScore = Math.min((performance.collections.totalAmount / 1000000) * 100, 100); // 10L = max
  const followupScore = Math.min((performance.leads.averageFollowups / 5) * 100, 100); // 5 avg = max

  const totalScore =
    conversionScore * weights.conversionRate +
    acceptanceScore * weights.acceptanceRate +
    orderScore * weights.totalOrders +
    collectionScore * weights.collections +
    followupScore * weights.followups;

  return Math.round(totalScore);
};

/**
 * Get my dealer's performance (for SE to see their dealer portfolios)
 */
export const getMyDealerPerformance = async ({ branchId, executiveId, startDate, endDate }) => {
  const dealers = await Dealer.find({
    branch: branchId,
    assignedSE: objectId(executiveId),
    status: 'active',
  }).select('_id businessName dealerCode currentOutstanding').lean();

  const dealerPerformances = await Promise.all(
    dealers.map(async (dealer) => {
      const orderMatchStage = {
        branch: branchId,
        dealer: dealer._id,
      };

      if (startDate || endDate) {
        orderMatchStage.orderDate = {};
        if (startDate) orderMatchStage.orderDate.$gte = new Date(startDate);
        if (endDate) orderMatchStage.orderDate.$lte = new Date(endDate);
      }

      const [orderStats] = await SalesOrder.aggregate([
        { $match: orderMatchStage },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalValue: { $sum: '$grandTotal' },
          },
        },
      ]);

      return {
        dealer,
        orders: orderStats?.totalOrders || 0,
        orderValue: orderStats?.totalValue || 0,
        outstanding: dealer.currentOutstanding || 0,
      };
    })
  );

  return dealerPerformances.sort((a, b) => b.orderValue - a.orderValue);
};
