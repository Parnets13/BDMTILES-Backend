import { Router } from 'express';
import SalesOrder from '../models/SalesOrder.js';
import SalesReturn from '../models/SalesReturn.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import GRN from '../models/GRN.js';
import Stock from '../models/Stock.js';
import Payment from '../models/Payment.js';
import DealerLedger from '../models/DealerLedger.js';
import SupplierLedger from '../models/SupplierLedger.js';
import Expense from '../models/Expense.js';
import Invoice from '../models/Invoice.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import Branch from '../models/Branch.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { getDashboardReport } from '../services/dashboardReport.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

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
router.get('/dashboard', requirePermission('dashboard.view'), async (req, res) => {
  try {
    return await getDashboardReport(req, res);

    const [
      todaySales, monthSales, prevMonthSales,
      pendingOrders, totalStock, totalStockValue,
      pendingPayments, openComplaints,
      weeklySalesTrend,
    ] = await Promise.all([
      SalesOrder.aggregate([{ $match: { branch: req.branchId, createdAt: { $gte: today }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      SalesOrder.aggregate([{ $match: { branch: req.branchId, createdAt: { $gte: monthStart }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } }]),
      SalesOrder.aggregate([{ $match: { branch: req.branchId, createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
      SalesOrder.countDocuments({ branch: req.branchId, status: { $in: ['confirmed','processing','approved'] } }),
      Stock.aggregate([{ $match: { branch: req.branchId } }, { $group: { _id: null, totalQty: { $sum: '$availableQty' } } }]),
      Stock.aggregate([{ $match: { branch: req.branchId } }, { $group: { _id: null, value: { $sum: { $multiply: ['$availableQty','$purchaseRate'] } } } }]),
      SalesOrder.aggregate([{ $match: { branch: req.branchId, paymentStatus: { $in: ['pending','partial'] }, status: { $nin: ['cancelled','draft'] } } }, { $group: { _id: null, total: { $sum: '$balanceAmount' }, count: { $sum: 1 } } }]),
      // placeholder — complaints model optional
      Promise.resolve([{ count: 0 }]),
      // Daily sales for last 7 days
      SalesOrder.aggregate([
        { $match: { branch: req.branchId, createdAt: { $gte: weekStart }, status: { $nin: ['cancelled','draft'] } } },
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
router.get('/sales', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo, groupBy = 'day', dealer, category } = req.query;
    const match = { branch: req.branchId, status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };
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
        {
          $group: {
            _id: { $ifNull: ['$dealer', '$customerName'] },
            dealerName: { $first: { $ifNull: ['$dealerName', '$customerName'] } },
            revenue: { $sum: '$grandTotal' },
            orders: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
      ]),
      SalesOrder.aggregate([
        { $match: match }, { $unwind: '$items' },
        { $group: { _id: '$items.product', productName: { $first: '$items.productName' }, productCode: { $first: '$items.productCode' }, qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.totalAmount' } } },
        { $sort: { revenue: -1 } }, { $limit: 10 },
      ]),
      SalesReturn.aggregate([
        { $match: { branch: req.branchId, status: { $nin: ['cancelled'] }, ...dateFilter(dateFrom, dateTo, 'returnDate') } },
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
router.get('/purchase', requirePermission('reports.purchase'), async (req, res) => {
  try {
    const { dateFrom, dateTo, supplier } = req.query;
    const match = { branch: req.branchId, status: { $nin: ['cancelled'] }, ...dateFilter(dateFrom, dateTo, 'poDate') };
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
router.get('/inventory', requirePermission('reports.inventory'), async (req, res) => {
  try {
    const { warehouse, lowStock = 10 } = req.query;
    const match = { branch: req.branchId, ...(warehouse ? { warehouse } : {}) };

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
router.get('/gst', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { branch: req.branchId, status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

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
router.get('/aging', requirePermission('reports.sales'), async (req, res) => {
  try {
    const ledgerBalances = await DealerLedger.aggregate([
      { $match: { branch: req.branchId } },
      {
        $group: {
          _id: '$dealer',
          outstanding: { $sum: { $subtract: [{ $ifNull: ['$debit', 0] }, { $ifNull: ['$credit', 0] }] } },
          dealerName: { $last: '$dealerName' },
          dealerCode: { $last: '$dealerCode' },
        },
      },
      { $match: { outstanding: { $gt: 0 } } },
      { $lookup: { from: 'dealers', localField: '_id', foreignField: '_id', as: 'dealer' } },
      { $unwind: { path: '$dealer', preserveNullAndEmptyArrays: true } },
    ]);

    const buckets = ledgerBalances.map((entry) => {
      const outstanding = entry.outstanding || 0;
      return {
        dealerCode: entry.dealerCode || entry.dealer?.dealerCode || '',
        dealerName: entry.dealerName || entry.dealer?.businessName || '',
        city: entry.dealer?.city || '',
        creditLimit: entry.dealer?.creditLimit || 0,
        creditDays: entry.dealer?.creditDays || 0,
        outstanding,
        overCreditLimit: outstanding > (entry.dealer?.creditLimit || 0),
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
router.get('/profit', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { branch: req.branchId, status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    // Bill-wise profit: revenue - (qty * purchase rate from stock)
    const salesData = await SalesOrder.aggregate([
      { $match: match }, { $unwind: '$items' },
      {
        $lookup: {
          from: 'stocks',
          let: { productId: '$items.product', orderBranch: '$branch' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$product', '$$productId'] },
                    { $eq: ['$branch', '$$orderBranch'] },
                  ],
                },
              },
            },
            { $sort: { updatedAt: -1 } },
            { $limit: 1 },
          ],
          as: 'stockInfo',
        },
      },
      {
        $group: {
          _id: '$_id',
          orderNumber: { $first: '$orderNumber' },
          orderDate: { $first: '$orderDate' },
          dealerName: { $first: { $ifNull: ['$dealerName', '$customerName'] } },
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
router.get('/hr', requirePermission('reports.sales'), async (req, res) => {
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
router.get('/dealer-performance', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { branch: req.branchId, status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

    const dealerData = await SalesOrder.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$dealer', '$customerName'] },
          dealerName: { $first: { $ifNull: ['$dealerName', '$customerName'] } },
          dealerCode: { $first: { $ifNull: ['$dealerCode', '$customerPhone'] } },
          revenue: { $sum: '$grandTotal' },
          orders: { $sum: 1 },
          avgOrderValue: { $avg: '$grandTotal' },
          // CAVEAT: this is the advance taken at order time, not money actually
          // collected against the dealer. The UI labels it "Collected" and derives
          // a Collection % from it, so both understate real collection whenever a
          // dealer pays after ordering. Switching to confirmed Payment records
          // would be more accurate but changes the reported figures, so it needs a
          // deliberate decision rather than a silent fix.
          paidAmount: { $sum: '$advanceAmount' },
          balanceAmount: { $sum: '$balanceAmount' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 30 },
    ]);

    res.json({ success: true, data: dealerData });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// FINANCE STATEMENTS (Balance Sheet / P&L / Trial Balance stubs)
// ═══════════════════════════════════════════════════════
router.get('/finance-summary', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const salesMatch = { branch: req.branchId, status: { $nin: ['cancelled','draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };
    const purchaseMatch = { branch: req.branchId, status: { $nin: ['cancelled'] }, ...dateFilter(dateFrom, dateTo, 'poDate') };

    const [totalSales, totalPurchase, totalReceipts, totalPayments, stockValue] = await Promise.all([
      SalesOrder.aggregate([{ $match: salesMatch }, { $group: { _id: null, total: { $sum: '$grandTotal' }, tax: { $sum: '$totalTax' } } }]),
      PurchaseOrder.aggregate([{ $match: purchaseMatch }, { $group: { _id: null, total: { $sum: '$grandTotal' }, tax: { $sum: '$totalTax' } } }]),
      Payment.aggregate([{ $match: { branch: req.branchId, paymentType: 'dealer_receipt', status: 'confirmed', ...dateFilter(dateFrom, dateTo, 'paymentDate') } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.aggregate([{ $match: { branch: req.branchId, paymentType: 'supplier_payment', status: 'confirmed', ...dateFilter(dateFrom, dateTo, 'paymentDate') } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Stock.aggregate([{ $match: { branch: req.branchId } }, { $group: { _id: null, value: { $sum: { $multiply: ['$availableQty','$purchaseRate'] } } } }]),
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
router.get('/profitability', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { branch: req.branchId, status: { $nin: ['cancelled', 'draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

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
        {
          $group: {
            _id: { $ifNull: ['$dealer', '$customerName'] },
            dealerName: { $first: { $ifNull: ['$dealerName', '$customerName'] } },
            dealerCode: { $first: { $ifNull: ['$dealerCode', '$customerPhone'] } },
            revenue: { $sum: '$grandTotal' },
            orders: { $sum: 1 },
            discount: { $sum: '$totalDiscount' },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 20 },
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

// NOTE: a second, richer GET /dealer-performance handler used to live here. It was
// unreachable — Express matches the first registration (see DEALER PERFORMANCE
// above), so this one never executed. Removed to stop it being mistaken for the
// live handler. It computed collection from confirmed Payment records, which is a
// truer "collected" figure than the advanceAmount the live handler reports; see
// the note on that handler.

// ═══════════════════════════════════════════════════════
// SALES EXECUTIVE PERFORMANCE REPORT
// ═══════════════════════════════════════════════════════
router.get('/se-performance', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = { branch: req.branchId, status: { $nin: ['cancelled', 'draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') };

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

// ═══════════════════════════════════════════════════════
// SUPPLIER PERFORMANCE REPORT
// Purchase volume, receipt reliability and what we still owe, per supplier.
// ═══════════════════════════════════════════════════════
router.get('/supplier-performance', requirePermission('reports.purchase'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const branch = req.branchId;

    const [poRows, grnRows, ledgerRows] = await Promise.all([
      PurchaseOrder.aggregate([
        { $match: { branch, status: { $nin: ['draft', 'cancelled', 'rejected'] }, ...dateFilter(dateFrom, dateTo, 'poDate') } },
        { $group: {
          _id: '$supplier',
          supplierName: { $first: '$supplierName' },
          poCount: { $sum: 1 },
          poValue: { $sum: '$grandTotal' },
          avgPoValue: { $avg: '$grandTotal' },
          receivedPos: { $sum: { $cond: [{ $eq: ['$status', 'received'] }, 1, 0] } },
          partialPos: { $sum: { $cond: [{ $eq: ['$status', 'partial_received'] }, 1, 0] } },
          firstPo: { $min: '$poDate' },
          lastPo: { $max: '$poDate' },
        } },
      ]),
      GRN.aggregate([
        { $match: { branch, status: { $ne: 'draft' }, ...dateFilter(dateFrom, dateTo, 'grnDate') } },
        { $group: { _id: '$supplier', grnCount: { $sum: 1 }, lastGrnDate: { $max: '$grnDate' } } },
      ]),
      // Supplier ledger is the reverse of the dealer ledger: credit is what we owe
      // the supplier, debit is what we have paid.
      SupplierLedger.aggregate([
        { $match: { branch } },
        { $group: {
          _id: '$supplier',
          supplierName: { $last: '$supplierName' },
          supplierCode: { $last: '$supplierCode' },
          payable: { $sum: { $subtract: [{ $ifNull: ['$credit', 0] }, { $ifNull: ['$debit', 0] }] } },
        } },
      ]),
    ]);

    const grnMap = new Map(grnRows.map((row) => [String(row._id), row]));
    const ledgerMap = new Map(ledgerRows.map((row) => [String(row._id), row]));
    const keys = new Set([...poRows, ...grnRows, ...ledgerRows].map((row) => String(row._id)));

    const data = [...keys].map((key) => {
      const po = poRows.find((row) => String(row._id) === key) || {};
      const grn = grnMap.get(key) || {};
      const ledger = ledgerMap.get(key) || {};
      const poCount = po.poCount || 0;
      return {
        _id: key,
        supplierName: po.supplierName || ledger.supplierName || '—',
        supplierCode: ledger.supplierCode || '',
        poCount,
        poValue: po.poValue || 0,
        avgPoValue: po.avgPoValue || 0,
        grnCount: grn.grnCount || 0,
        lastGrnDate: grn.lastGrnDate || null,
        // Share of purchase orders fully received — a rough delivery-reliability read.
        fulfilmentRate: poCount > 0 ? Math.round(((po.receivedPos || 0) / poCount) * 100) : null,
        partialPos: po.partialPos || 0,
        payable: ledger.payable || 0,
        firstPo: po.firstPo || null,
        lastPo: po.lastPo || null,
      };
    }).sort((a, b) => b.poValue - a.poValue);

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// BRANCH PERFORMANCE REPORT
// The only cross-branch report here: it spans the branches the user is assigned
// to rather than the single active branch, because comparing one branch with
// itself is meaningless. Users still never see a branch they aren't assigned to.
// ═══════════════════════════════════════════════════════
router.get('/branch-performance', requirePermission('reports.sales'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const branchIds = (req.user.assignedBranches || [])
      .map((entry) => entry?._id || entry)
      .filter(Boolean);
    const scope = branchIds.length ? branchIds : [req.branchId];

    const [salesRows, collectionRows] = await Promise.all([
      SalesOrder.aggregate([
        { $match: { branch: { $in: scope }, status: { $nin: ['cancelled', 'draft'] }, ...dateFilter(dateFrom, dateTo, 'orderDate') } },
        { $group: {
          _id: '$branch',
          salesValue: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 },
          avgOrderValue: { $avg: '$grandTotal' },
          totalDiscount: { $sum: '$totalDiscount' },
          outstanding: { $sum: '$balanceAmount' },
          uniqueDealers: { $addToSet: '$dealer' },
        } },
        { $addFields: { dealerCount: { $size: '$uniqueDealers' } } },
        { $project: { uniqueDealers: 0 } },
      ]),
      Payment.aggregate([
        { $match: { branch: { $in: scope }, status: 'confirmed', paymentType: 'dealer_receipt', ...dateFilter(dateFrom, dateTo, 'paymentDate') } },
        { $group: { _id: '$branch', collected: { $sum: '$amount' }, receipts: { $sum: 1 } } },
      ]),
    ]);

    const collectionMap = new Map(collectionRows.map((row) => [String(row._id), row]));
    const branchInfo = await Branch.find({ _id: { $in: scope } })
      .select('branchCode name city status').lean();
    const branchMap = new Map(branchInfo.map((row) => [String(row._id), row]));

    const data = scope.map((id) => {
      const key = String(id);
      const sales = salesRows.find((row) => String(row._id) === key) || {};
      const collection = collectionMap.get(key) || {};
      const info = branchMap.get(key) || {};
      const salesValue = sales.salesValue || 0;
      const collected = collection.collected || 0;
      return {
        _id: key,
        branchName: info.name || '—',
        branchCode: info.branchCode || '',
        city: info.city || '',
        salesValue,
        orderCount: sales.orderCount || 0,
        avgOrderValue: sales.avgOrderValue || 0,
        totalDiscount: sales.totalDiscount || 0,
        dealerCount: sales.dealerCount || 0,
        outstanding: sales.outstanding || 0,
        collected,
        receipts: collection.receipts || 0,
        collectionRatio: salesValue > 0 ? Math.round((collected / salesValue) * 100) : null,
      };
    }).sort((a, b) => b.salesValue - a.salesValue);

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// WAREHOUSE PERFORMANCE REPORT
// Stock held, value and movement freshness per warehouse in the active branch.
// ═══════════════════════════════════════════════════════
router.get('/warehouse-performance', requirePermission('reports.inventory'), async (req, res) => {
  try {
    const branch = req.branchId;
    const valuationRate = { $cond: [{ $gt: ['$landingCost', 0] }, '$landingCost', '$purchaseRate'] };

    const [stockRows, grnRows] = await Promise.all([
      Stock.aggregate([
        { $match: { branch } },
        { $group: {
          _id: '$warehouse',
          totalQty: { $sum: '$totalQty' },
          availableQty: { $sum: '$availableQty' },
          reservedQty: { $sum: '$reservedQty' },
          blockedQty: { $sum: '$blockedQty' },
          damagedQty: { $sum: '$damagedQty' },
          stockValue: { $sum: { $multiply: ['$availableQty', valuationRate] } },
          stockRows: { $sum: 1 },
          products: { $addToSet: '$product' },
          lastSaleDate: { $max: '$lastSaleDate' },
          lastGRNDate: { $max: '$lastGRNDate' },
        } },
        { $addFields: { productCount: { $size: '$products' } } },
        { $project: { products: 0 } },
        { $lookup: { from: 'warehouses', localField: '_id', foreignField: '_id', as: 'warehouseInfo' } },
        { $project: {
          totalQty: 1, availableQty: 1, reservedQty: 1, blockedQty: 1, damagedQty: 1,
          stockValue: 1, stockRows: 1, productCount: 1, lastSaleDate: 1, lastGRNDate: 1,
          warehouseName: { $ifNull: [{ $first: '$warehouseInfo.name' }, 'Unknown warehouse'] },
          warehouseCode: { $ifNull: [{ $first: '$warehouseInfo.warehouseCode' }, ''] },
        } },
        { $sort: { stockValue: -1 } },
      ]),
      // Receipts land per GRN line, so unwind to attribute them to a warehouse.
      GRN.aggregate([
        { $match: { branch, status: { $ne: 'draft' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.warehouse', grnLines: { $sum: 1 }, lastReceipt: { $max: '$grnDate' } } },
      ]),
    ]);

    const grnMap = new Map(grnRows.map((row) => [String(row._id), row]));
    const data = stockRows.map((row) => ({
      ...row,
      grnLines: grnMap.get(String(row._id))?.grnLines || 0,
      lastReceipt: grnMap.get(String(row._id))?.lastReceipt || row.lastGRNDate || null,
    }));

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// COLLECTION REPORT
// Confirmed dealer receipts: totals, split by mode, daily trend and top payers.
// ═══════════════════════════════════════════════════════
router.get('/collection-report', requirePermission('reports.finance'), async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const match = {
      branch: req.branchId,
      status: 'confirmed',
      paymentType: 'dealer_receipt',
      ...dateFilter(dateFrom, dateTo, 'paymentDate'),
    };

    const [facets] = await Payment.aggregate([
      { $match: match },
      { $facet: {
        summary: [{ $group: { _id: null, total: { $sum: '$amount' }, receipts: { $sum: 1 }, avgReceipt: { $avg: '$amount' } } }],
        byMode: [
          { $group: { _id: '$paymentMode', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        daily: [
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate', timezone: 'Asia/Kolkata' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        // Payment stores the counterparty as a denormalised partyName plus a
        // dealer ref; group on the dealer where present so receipts from the same
        // dealer don't split on spelling, and fall back to partyName otherwise.
        topPayers: [
          { $group: {
            _id: { $ifNull: ['$dealer', '$partyName'] },
            name: { $first: '$partyName' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          } },
          { $sort: { total: -1 } },
          { $limit: 15 },
        ],
      } },
    ]);

    res.json({
      success: true,
      data: {
        summary: facets?.summary?.[0] || { total: 0, receipts: 0, avgReceipt: 0 },
        byMode: facets?.byMode || [],
        daily: facets?.daily || [],
        topPayers: facets?.topPayers || [],
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// EXPENSE REPORT
// Claims by category, status, department and claimant.
// ═══════════════════════════════════════════════════════
router.get('/expense-report', requireAnyPermission('reports.finance', 'expense.management'), async (req, res) => {
  try {
    const { dateFrom, dateTo, status, category } = req.query;
    const match = { branch: req.branchId, ...dateFilter(dateFrom, dateTo, 'expenseDate') };
    if (status) match.status = status;
    if (category) match.category = category;

    const [facets] = await Expense.aggregate([
      { $match: match },
      { $facet: {
        summary: [{ $group: {
          _id: null,
          total: { $sum: '$amount' },
          claims: { $sum: 1 },
          // Cancelled and rejected claims are excluded from the approved figure so
          // the numbers below reconcile with what finance actually owes.
          approved: { $sum: { $cond: [{ $in: ['$status', ['approved', 'reimbursed']] }, '$amount', 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } },
          reimbursed: { $sum: { $cond: [{ $eq: ['$status', 'reimbursed'] }, '$amount', 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, '$amount', 0] } },
        } }],
        byCategory: [
          { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        byStatus: [
          { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        byDepartment: [
          { $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        byEmployee: [
          { $group: { _id: '$employee', employeeName: { $first: '$employeeName' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 15 },
        ],
        monthly: [
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$expenseDate', timezone: 'Asia/Kolkata' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      } },
    ]);

    res.json({
      success: true,
      data: {
        summary: facets?.summary?.[0] || { total: 0, claims: 0, approved: 0, pending: 0, reimbursed: 0, rejected: 0 },
        byCategory: facets?.byCategory || [],
        byStatus: facets?.byStatus || [],
        byDepartment: facets?.byDepartment || [],
        byEmployee: facets?.byEmployee || [],
        monthly: facets?.monthly || [],
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════
// OUTSTANDING REPORT
// Both sides of the balance sheet in one place: receivable from dealers and
// payable to suppliers, plus overdue invoices. The separate Aging Report covers
// receivable bucketing in more depth.
// ═══════════════════════════════════════════════════════
router.get('/outstanding-report', requirePermission('reports.finance'), async (req, res) => {
  try {
    const branch = req.branchId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [receivables, payables, overdue] = await Promise.all([
      DealerLedger.aggregate([
        { $match: { branch } },
        { $group: {
          _id: '$dealer',
          name: { $last: '$dealerName' },
          code: { $last: '$dealerCode' },
          outstanding: { $sum: { $subtract: [{ $ifNull: ['$debit', 0] }, { $ifNull: ['$credit', 0] }] } },
          lastEntry: { $max: '$entryDate' },
        } },
        { $match: { outstanding: { $gt: 0 } } },
        { $sort: { outstanding: -1 } },
      ]),
      SupplierLedger.aggregate([
        { $match: { branch } },
        { $group: {
          _id: '$supplier',
          name: { $last: '$supplierName' },
          code: { $last: '$supplierCode' },
          outstanding: { $sum: { $subtract: [{ $ifNull: ['$credit', 0] }, { $ifNull: ['$debit', 0] }] } },
          lastEntry: { $max: '$entryDate' },
        } },
        { $match: { outstanding: { $gt: 0 } } },
        { $sort: { outstanding: -1 } },
      ]),
      // Same basis as the dashboard's overdue figure so the two agree.
      Invoice.aggregate([
        { $match: {
          branch,
          status: { $nin: ['draft', 'cancelled'] },
          invoiceType: { $in: ['tax_invoice', 'retail_invoice'] },
          paymentStatus: { $in: ['pending', 'partial'] },
          balanceAmount: { $gt: 0 },
          dueDate: { $lt: today },
        } },
        { $group: { _id: null, amount: { $sum: '$balanceAmount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const receivableTotal = receivables.reduce((sum, row) => sum + row.outstanding, 0);
    const payableTotal = payables.reduce((sum, row) => sum + row.outstanding, 0);

    res.json({
      success: true,
      data: {
        summary: {
          receivableTotal,
          payableTotal,
          netPosition: receivableTotal - payableTotal,
          dealersOwing: receivables.length,
          suppliersOwed: payables.length,
          overdueAmount: overdue[0]?.amount || 0,
          overdueCount: overdue[0]?.count || 0,
        },
        receivables,
        payables,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
