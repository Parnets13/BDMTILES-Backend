import { Router } from 'express';
import SalesOrder from '../models/SalesOrder.js';
import SalesReturn from '../models/SalesReturn.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import Payment from '../models/Payment.js';
import DealerLedger from '../models/DealerLedger.js';
import Dealer from '../models/Dealer.js';
import Product from '../models/Product.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

const dateFilter = (from, to, field = 'createdAt') => {
  const f = {};
  if (from || to) {
    f[field] = {};
    if (from) f[field].$gte = new Date(from);
    if (to) { const d = new Date(to); d.setHours(23,59,59,999); f[field].$lte = d; }
  }
  return f;
};

// ═══════════════════════════════════════════════════════
// OWNER DASHBOARD KPIs
// ═══════════════════════════════════════════════════════
router.get('/dashboard', requirePermission('reports.management'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const weekStart = new Date(today); weekStart.setDate(today.getDate() - 6);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

    const [
      todaySales, monthSales, prevMonthSales,
      pendingOrders, totalStock, totalStockValue,
      pendingPayments, openComplaints,
      weeklySalesTrend,
    ] = await Promise.all([
      SalesOrder.aggregate([{ $match: { createdAt: { $gte: today }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      SalesOrder.aggregate([{ $match: { createdAt: { $gte: monthStart }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      SalesOrder.aggregate([{ $match: { createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
      SalesOrder.countDocuments({ status: { $in: ['confirmed','processing','approved'] } }),
      Stock.aggregate([{ $group: { _id: null, totalQty: { $sum: '$availableQty' } } }]),
      Stock.aggregate([{ $group: { _id: null, value: { $sum: { $multiply: ['$availableQty','$purchaseRate'] } } } }]),
      SalesOrder.aggregate([{ $match: { paymentStatus: { $in: ['pending','partial'] }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$balanceAmount' }, count: { $sum: 1 } } }]),
      // placeholder — complaints model optional
      Promise.resolve([{ count: 0 }]),
      // Daily sales for last 7 days
      SalesOrder.aggregate([
        { $match: { createdAt: { $gte: weekStart }, status: { $nin: ['cancelled','draft'] } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const monthGrowth = prevMonthSales[0]?.total
      ? (((monthSales[0]?.total || 0) - prevMonthSales[0].total) / prevMonthSales[0].total * 100).toFixed(1)
      : null;

    res.json({ success: true, data: {
      todaySales: todaySales[0]?.total || 0,
      todayOrders: todaySales[0]?.count || 0,
      monthSales: monthSales[0]?.total || 0,
      monthOrders: monthSales[0]?.count || 0,
      monthGrowth,
      pendingOrders,
      totalStock: totalStock[0]?.totalQty || 0,
      stockValue: totalStockValue[0]?.value || 0,
      pendingPayments: pendingPayments[0]?.total || 0,
      pendingPaymentsCount: pendingPayments[0]?.count || 0,
      weeklySalesTrend,
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// SALES REPORTS
// ═══════════════════════════════════════════════════════
router.get('/sales', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo, groupBy = 'day', dealer, category } = req.query;
    const match = { status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };
    if (dealer) match.dealer = dealer;

    const groupFormats = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };
    const fmt = groupFormats[groupBy] || '%Y-%m-%d';

    const [byPeriod, byDealer, topProducts, returnStats] = await Promise.all([
      SalesOrder.aggregate([
        { $match: match },
        { $group: { _id: { $dateToString: { format: fmt, date: '$orderDate' } }, revenue: { $sum: '$grandTotal' }, orders: { $sum: 1 }, avgOrderValue: { $avg: '$grandTotal' } } },
        { $sort: { _id: 1 } },
      ]),
      SalesOrder.aggregate([
        { $match: match },
        { $group: { _id: '$dealer', dealerName: { $first: '$dealerName' }, revenue: { $sum: '$grandTotal' }, orders: { $sum: 1 } } },
        { $sort: { revenue: -1 } }, { $limit: 10 },
      ]),
      SalesOrder.aggregate([
        { $match: match }, { $unwind: '$items' },
        { $group: { _id: '$items.product', productName: { $first: '$items.productName' }, productCode: { $first: '$items.productCode' }, qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.totalAmount' } } },
        { $sort: { revenue: -1 } }, { $limit: 10 },
      ]),
      SalesReturn.aggregate([
        { $match: { status: { $nin: ['cancelled'] }, ...dateFilter(dateFrom, dateTo, 'returnDate') } },
        { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
      ]),
    ]);

    const totalRevenue = byPeriod.reduce((s, p) => s + (p.revenue || 0), 0);
    const totalOrders = byPeriod.reduce((s, p) => s + (p.orders || 0), 0);

    res.json({ success: true, data: {
      summary: { totalRevenue, totalOrders, avgOrderValue: totalOrders ? totalRevenue / totalOrders : 0,
        returnsValue: returnStats[0]?.total || 0, returnsCount: returnStats[0]?.count || 0 },
      byPeriod, byDealer, topProducts,
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// PURCHASE REPORTS
// ═══════════════════════════════════════════════════════
router.get('/purchase', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo, supplier } = req.query;
    const match = { status: { $nin: ['cancelled'] }, ...dateFilter(dateFrom, dateTo, 'poDate') };
    if (supplier) match.supplier = supplier;

    const [byPeriod, bySupplier, summary] = await Promise.all([
      PurchaseOrder.aggregate([
        { $match: match },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$poDate' } }, amount: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      PurchaseOrder.aggregate([
        { $match: match },
        { $group: { _id: '$supplier', supplierName: { $first: '$supplierName' }, amount: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
        { $sort: { amount: -1 } }, { $limit: 10 },
      ]),
      PurchaseOrder.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status','draft'] }, '$grandTotal', 0] } } } },
      ]),
    ]);

    res.json({ success: true, data: {
      summary: { totalAmount: summary[0]?.total || 0, totalPOs: summary[0]?.count || 0, pendingAmount: summary[0]?.pending || 0 },
      byPeriod, bySupplier,
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// INVENTORY REPORTS
// ═══════════════════════════════════════════════════════
router.get('/inventory', requirePermission('reports.management'), async (req, res) => {
  try {
    const { warehouse, lowStock = 10 } = req.query;
    const match = warehouse ? { warehouse } : {};

    const [summary, byWarehouse, lowStockItems, stockAging] = await Promise.all([
      Stock.aggregate([
        { $match: match },
        { $group: { _id: null, totalQty: { $sum: '$availableQty' }, totalValue: { $sum: { $multiply: ['$availableQty','$purchaseRate'] } }, damagedQty: { $sum: '$damagedQty' }, uniqueProducts: { $sum: 1 } } },
      ]),
      Stock.aggregate([
        { $match: match },
        { $group: { _id: '$warehouse', totalQty: { $sum: '$availableQty' }, totalValue: { $sum: { $multiply: ['$availableQty','$purchaseRate'] } } } },
        { $sort: { totalQty: -1 } },
      ]),
      Stock.find({ ...match, availableQty: { $lte: parseInt(lowStock) } })
        .populate('product', 'productCode itemName tileSize').populate('warehouse','name')
        .sort({ availableQty: 1 }).limit(50).lean(),
      // Stock aging: items not moved in 90+ days
      Stock.find({ ...match, lastGRNDate: { $lte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } })
        .populate('product','productCode itemName').populate('warehouse','name')
        .sort({ lastGRNDate: 1 }).limit(30).lean(),
    ]);

    res.json({ success: true, data: {
      summary: summary[0] || {},
      byWarehouse, lowStockItems, stockAging,
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// GST REPORTS (GSTR-1 / GSTR-3B style)
// ═══════════════════════════════════════════════════════
router.get('/gst', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    const [gstrData, gstByRate] = await Promise.all([
      SalesOrder.aggregate([
        { $match: match }, { $unwind: '$items' },
        { $group: {
          _id: { gst: '$items.gstPercentage', date: { $dateToString: { format: '%Y-%m', date: '$orderDate' } } },
          taxableAmount: { $sum: '$items.taxableAmount' },
          cgst: { $sum: '$items.cgst' },
          sgst: { $sum: '$items.sgst' },
          igst: { $sum: '$items.igst' },
          totalGst: { $sum: '$items.gstAmount' },
        }},
        { $sort: { '_id.date': 1 } },
      ]),
      SalesOrder.aggregate([
        { $match: match }, { $unwind: '$items' },
        { $group: {
          _id: '$items.gstPercentage',
          taxableAmount: { $sum: '$items.taxableAmount' },
          cgst: { $sum: '$items.cgst' },
          sgst: { $sum: '$items.sgst' },
          totalGst: { $sum: '$items.gstAmount' },
          invoiceCount: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    const totals = gstByRate.reduce((acc, r) => ({
      taxableAmount: acc.taxableAmount + (r.taxableAmount || 0),
      cgst: acc.cgst + (r.cgst || 0),
      sgst: acc.sgst + (r.sgst || 0),
      totalGst: acc.totalGst + (r.totalGst || 0),
    }), { taxableAmount: 0, cgst: 0, sgst: 0, totalGst: 0 });

    res.json({ success: true, data: { gstrData, gstByRate, totals } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// AGING REPORT (outstanding receivables)
// ═══════════════════════════════════════════════════════
router.get('/aging', requirePermission('reports.management'), async (req, res) => {
  try {
    const today = new Date();
    const dealers = await Dealer.find({ currentOutstanding: { $gt: 0 } })
      .select('businessName dealerCode city creditLimit creditDays currentOutstanding').lean();

    const buckets = dealers.map(d => {
      const outstanding = d.currentOutstanding || 0;
      return {
        dealerCode: d.dealerCode, dealerName: d.businessName, city: d.city,
        creditLimit: d.creditLimit, creditDays: d.creditDays,
        outstanding,
        overCreditLimit: outstanding > (d.creditLimit || 0),
      };
    });

    const summary = {
      totalDealers: buckets.length,
      totalOutstanding: buckets.reduce((s, b) => s + b.outstanding, 0),
      overLimit: buckets.filter(b => b.overCreditLimit).length,
    };

    res.json({ success: true, data: { buckets, summary } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// PROFIT ANALYSIS
// ═══════════════════════════════════════════════════════
router.get('/profit', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    // Bill-wise profit: revenue - (qty * purchase rate from stock)
    const salesData = await SalesOrder.aggregate([
      { $match: match }, { $unwind: '$items' },
      {
        $lookup: {
          from: 'stocks', localField: 'items.product', foreignField: 'product',
          as: 'stockInfo',
        },
      },
      {
        $group: {
          _id: '$_id',
          orderNumber: { $first: '$orderNumber' },
          orderDate: { $first: '$orderDate' },
          dealerName: { $first: '$dealerName' },
          revenue: { $sum: '$items.taxableAmount' },
          estimatedCost: { $sum: { $multiply: ['$items.quantity', { $ifNull: [{ $first: '$stockInfo.purchaseRate' }, 0] }] } },
        },
      },
      { $addFields: { grossProfit: { $subtract: ['$revenue', '$estimatedCost'] } } },
      { $sort: { orderDate: -1 } }, { $limit: 50 },
    ]);

    // Category margin
    const categoryMargin = await SalesOrder.aggregate([
      { $match: match }, { $unwind: '$items' },
      { $lookup: { from: 'products', localField: 'items.product', foreignField: '_id', as: 'prod' } },
      { $unwind: { path: '$prod', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'categories', localField: 'prod.category', foreignField: '_id', as: 'cat' } },
      {
        $group: {
          _id: { $ifNull: [{ $first: '$cat.name' }, 'Uncategorized'] },
          revenue: { $sum: '$items.taxableAmount' },
          qty: { $sum: '$items.quantity' },
        },
      },
      { $sort: { revenue: -1 } }, { $limit: 15 },
    ]);

    res.json({ success: true, data: { billwiseProfit: salesData, categoryMargin } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// HR REPORTS
// ═══════════════════════════════════════════════════════
router.get('/hr', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const [totalEmployees, activeEmployees, byDept, pendingLeaves] = await Promise.all([
      Employee.countDocuments(),
      Employee.countDocuments({ status: 'active' }),
      Employee.aggregate([{ $group: { _id: '$department', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Leave.countDocuments({ status: 'pending' }),
    ]);
    res.json({ success: true, data: { totalEmployees, activeEmployees, byDept, pendingLeaves } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// DEALER PERFORMANCE
// ═══════════════════════════════════════════════════════
router.get('/dealer-performance', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    const dealerData = await SalesOrder.aggregate([
      { $match: match },
      { $group: {
        _id: '$dealer',
        dealerName: { $first: '$dealerName' }, dealerCode: { $first: '$dealerCode' },
        revenue: { $sum: '$grandTotal' }, orders: { $sum: 1 },
        avgOrderValue: { $avg: '$grandTotal' }, paidAmount: { $sum: '$advanceAmount' },
        balanceAmount: { $sum: '$balanceAmount' },
      }},
      { $sort: { revenue: -1 } }, { $limit: 30 },
    ]);

    res.json({ success: true, data: dealerData });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// FINANCE STATEMENTS (Balance Sheet / P&L / Trial Balance stubs)
// ═══════════════════════════════════════════════════════
router.get('/finance-summary', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const salesMatch = { status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };
    const purchaseMatch = { status: { $nin: ['cancelled'] }, ...dateFilter(dateFrom, dateTo, 'poDate') };

    const [totalSales, totalPurchase, totalReceipts, totalPayments, stockValue] = await Promise.all([
      SalesOrder.aggregate([{ $match: salesMatch }, { $group: { _id: null, total: { $sum: '$grandTotal' }, tax: { $sum: '$totalTax' } } }]),
      PurchaseOrder.aggregate([{ $match: purchaseMatch }, { $group: { _id: null, total: { $sum: '$grandTotal' }, tax: { $sum: '$totalTax' } } }]),
      Payment.aggregate([{ $match: { paymentType: 'dealer_receipt', status: 'confirmed', ...dateFilter(dateFrom, dateTo, 'paymentDate') } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.aggregate([{ $match: { paymentType: 'supplier_payment', status: 'confirmed', ...dateFilter(dateFrom, dateTo, 'paymentDate') } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Stock.aggregate([{ $group: { _id: null, value: { $sum: { $multiply: ['$availableQty','$purchaseRate'] } } } }]),
    ]);

    const revenue = totalSales[0]?.total || 0;
    const purchases = totalPurchase[0]?.total || 0;
    const grossProfit = revenue - purchases;
    const receipts = totalReceipts[0]?.total || 0;
    const payments = totalPayments[0]?.total || 0;

    res.json({ success: true, data: {
      profitLoss: { revenue, purchases, grossProfit, grossMargin: revenue ? ((grossProfit / revenue) * 100).toFixed(1) : 0,
        totalTaxCollected: totalSales[0]?.tax || 0, totalTaxPaid: totalPurchase[0]?.tax || 0 },
      cashFlow: { receipts, payments, netCashFlow: receipts - payments },
      balanceSheet: { stockValue: stockValue[0]?.value || 0, totalReceivables: 0, totalPayables: 0 },
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// PROFITABILITY REPORT
// ═══════════════════════════════════════════════════════
router.get('/profitability', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { status: { $nin: ['cancelled', 'draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    const [productProfit, categoryProfit, dealerProfit, overallSummary] = await Promise.all([
      // Product-wise profit (sales amount - estimated purchase cost)
      SalesOrder.aggregate([
        { $match: match }, { $unwind: '$items' },
        { $group: {
          _id: '$items.product',
          productName: { $first: '$items.productName' },
          productCode: { $first: '$items.productCode' },
          salesQty: { $sum: '$items.quantity' },
          salesRevenue: { $sum: '$items.totalAmount' },
          discountGiven: { $sum: { $ifNull: ['$items.discountAmount', 0] } },
        }},
        { $sort: { salesRevenue: -1 } }, { $limit: 20 },
      ]),
      // Category-wise margin
      SalesOrder.aggregate([
        { $match: match }, { $unwind: '$items' },
        { $lookup: { from: 'products', localField: 'items.product', foreignField: '_id', as: 'prod' } },
        { $unwind: { path: '$prod', preserveNullAndEmptyArrays: true } },
        { $group: {
          _id: '$prod.category',
          salesRevenue: { $sum: '$items.totalAmount' },
          costEstimate: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$prod.basicPrice', 0] }] } },
          totalQty: { $sum: '$items.quantity' },
        }},
        { $addFields: { grossMargin: { $subtract: ['$salesRevenue', '$costEstimate'] }, marginPercent: { $cond: [{ $gt: ['$salesRevenue', 0] }, { $multiply: [{ $divide: [{ $subtract: ['$salesRevenue', '$costEstimate'] }, '$salesRevenue'] }, 100] }, 0] } } },
        { $sort: { salesRevenue: -1 } },
      ]),
      // Dealer-wise profitability
      SalesOrder.aggregate([
        { $match: match },
        { $group: {
          _id: '$dealer',
          dealerName: { $first: '$dealerName' },
          dealerCode: { $first: '$dealerCode' },
          revenue: { $sum: '$grandTotal' },
          orders: { $sum: 1 },
          discount: { $sum: '$totalDiscount' },
        }},
        { $sort: { revenue: -1 } }, { $limit: 20 },
      ]),
      // Overall summary
      SalesOrder.aggregate([
        { $match: match },
        { $group: {
          _id: null,
          grossSales: { $sum: '$grandTotal' },
          totalDiscount: { $sum: '$totalDiscount' },
          totalTax: { $sum: '$totalTax' },
          totalOrders: { $sum: 1 },
          freightCharges: { $sum: '$freightCharges' },
        }},
      ]),
    ]);

    res.json({ success: true, data: {
      summary: overallSummary[0] || {},
      productProfit, categoryProfit, dealerProfit,
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// DEALER PERFORMANCE REPORT
// ═══════════════════════════════════════════════════════
router.get('/dealer-performance', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { status: { $nin: ['cancelled', 'draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    const dealerPerformance = await SalesOrder.aggregate([
      { $match: match },
      { $group: {
        _id: '$dealer',
        dealerName: { $first: '$dealerName' },
        dealerCode: { $first: '$dealerCode' },
        salesValue: { $sum: '$grandTotal' },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: '$grandTotal' },
        totalDiscount: { $sum: '$totalDiscount' },
        firstOrder: { $min: '$orderDate' },
        lastOrder: { $max: '$orderDate' },
      }},
      { $sort: { salesValue: -1 } },
    ]);

    // Get payment data per dealer
    const paymentMatch = dateFilter(dateFrom, dateTo, 'paymentDate');
    const dealerPayments = await Payment.aggregate([
      { $match: { status: 'confirmed', ...paymentMatch } },
      { $group: { _id: '$dealer', collected: { $sum: '$amount' } } },
    ]);
    const paymentMap = {};
    dealerPayments.forEach(p => { paymentMap[String(p._id)] = p.collected; });

    const enriched = dealerPerformance.map(d => ({
      ...d,
      collectionValue: paymentMap[String(d._id)] || 0,
      collectionRatio: d.salesValue > 0 ? Math.round((paymentMap[String(d._id)] || 0) / d.salesValue * 100) : 0,
    }));

    res.json({ success: true, data: enriched });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// SALES EXECUTIVE PERFORMANCE REPORT
// ═══════════════════════════════════════════════════════
router.get('/se-performance', requirePermission('reports.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { status: { $nin: ['cancelled', 'draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    const sePerformance = await SalesOrder.aggregate([
      { $match: { ...match, salesExecutive: { $exists: true, $ne: null } } },
      { $group: {
        _id: '$salesExecutive',
        salesValue: { $sum: '$grandTotal' },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: '$grandTotal' },
        uniqueDealers: { $addToSet: '$dealer' },
      }},
      { $addFields: { dealerCount: { $size: '$uniqueDealers' } } },
      { $sort: { salesValue: -1 } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { salesValue: 1, orderCount: 1, avgOrderValue: 1, dealerCount: 1, executiveName: '$user.name' } },
    ]);

    res.json({ success: true, data: sePerformance });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
