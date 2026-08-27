import { Router } from 'express';
import DealerLedger from '../models/DealerLedger.js';
import SupplierLedger from '../models/SupplierLedger.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import SalesOrder from '../models/SalesOrder.js';
import Payment from '../models/Payment.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

// ══════════════════════════════════════
// DEALER LEDGER
// ══════════════════════════════════════

// GET /api/v1/ledger/dealer/:dealerId — full statement
router.get('/dealer/:dealerId', requirePermission('dealer.ledger'), async (req, res) => {
  try {
    const { dateFrom, dateTo, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 50);
    let filter = { branch: req.branchId, dealer: req.params.dealerId };
    if (dateFrom || dateTo) {
      filter.entryDate = {};
      if (dateFrom) filter.entryDate.$gte = new Date(dateFrom);
      if (dateTo) { const d = new Date(dateTo); d.setHours(23, 59, 59); filter.entryDate.$lte = d; }
    }
    const [entries, total, dealer] = await Promise.all([
      DealerLedger.find(filter).sort({ entryDate: 1, createdAt: 1 }).skip((p-1)*l).limit(l).lean(),
      DealerLedger.countDocuments(filter),
      Dealer.findById(req.params.dealerId).select('businessName dealerCode mobile city creditLimit currentOutstanding').lean(),
    ]);

    // Outstanding summary
    const summary = await DealerLedger.aggregate([
      { $match: { branch: req.branchId, dealer: dealer?._id } },
      { $group: { _id: null, totalDebit: { $sum: '$debit' }, totalCredit: { $sum: '$credit' } } },
    ]);
    const outstanding = (summary[0]?.totalDebit || 0) - (summary[0]?.totalCredit || 0);
    const dealerSummary = dealer ? {
      ...dealer,
      consolidatedOutstanding: dealer.currentOutstanding || 0,
      currentOutstanding: outstanding,
    } : dealer;

    res.json({ success: true, data: entries, dealer: dealerSummary, outstanding, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/ledger/dealers — list all dealers with outstanding
router.get('/dealers', requirePermission('dealer.ledger'), async (req, res) => {
  try {
    const { search, page = 1, limit = 30 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 30);
    let filter = { status: 'active' };
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ businessName: r }, { dealerCode: r }]; }
    const [dealers, total] = await Promise.all([
      Dealer.find(filter).sort({ businessName: 1 }).skip((p-1)*l).limit(l)
        .select('businessName dealerCode mobile city creditLimit currentOutstanding').lean(),
      Dealer.countDocuments(filter),
    ]);
    const dealerIds = dealers.map((dealer) => dealer._id);
    const branchBalances = dealerIds.length
      ? await DealerLedger.aggregate([
        { $match: { branch: req.branchId, dealer: { $in: dealerIds } } },
        { $group: { _id: '$dealer', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ])
      : [];
    const balanceByDealer = new Map(branchBalances.map((balance) => [
      String(balance._id),
      (balance.debit || 0) - (balance.credit || 0),
    ]));
    const data = dealers.map((dealer) => ({
      ...dealer,
      consolidatedOutstanding: dealer.currentOutstanding || 0,
      currentOutstanding: balanceByDealer.get(String(dealer._id)) || 0,
    }));
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/ledger/dealer — automatic postings only
router.post('/dealer', requirePermission('dealer.ledger'), (req, res) => {
  res.status(405).json({
    success: false,
    message: 'Manual dealer ledger entries are disabled. Use a transactional source document so the branch ledger and consolidated outstanding remain consistent.',
  });
});

// ══════════════════════════════════════
// SUPPLIER LEDGER
// ══════════════════════════════════════

// GET /api/v1/ledger/supplier/:supplierId
router.get('/supplier/:supplierId', requirePermission('supplier.ledger'), async (req, res) => {
  try {
    const { dateFrom, dateTo, page = 1, limit = 50 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(200, parseInt(limit) || 50);
    let filter = { branch: req.branchId, supplier: req.params.supplierId };
    if (dateFrom || dateTo) {
      filter.entryDate = {};
      if (dateFrom) filter.entryDate.$gte = new Date(dateFrom);
      if (dateTo) { const d = new Date(dateTo); d.setHours(23, 59, 59); filter.entryDate.$lte = d; }
    }
    const [entries, total, supplier] = await Promise.all([
      SupplierLedger.find(filter).sort({ entryDate: 1, createdAt: 1 }).skip((p-1)*l).limit(l).lean(),
      SupplierLedger.countDocuments(filter),
      Supplier.findById(req.params.supplierId).select('companyName supplierCode mobile city currentOutstanding').lean(),
    ]);
    const summary = await SupplierLedger.aggregate([
      { $match: { branch: req.branchId, supplier: supplier?._id } },
      { $group: { _id: null, totalDebit: { $sum: '$debit' }, totalCredit: { $sum: '$credit' } } },
    ]);
    const outstanding = (summary[0]?.totalCredit || 0) - (summary[0]?.totalDebit || 0);
    const supplierSummary = supplier ? {
      ...supplier,
      consolidatedOutstanding: supplier.currentOutstanding || 0,
      currentOutstanding: outstanding,
    } : supplier;
    res.json({ success: true, data: entries, supplier: supplierSummary, outstanding, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/ledger/suppliers — list all with outstanding
router.get('/suppliers', requirePermission('supplier.ledger'), async (req, res) => {
  try {
    const { search, page = 1, limit = 30 } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 30);
    let filter = { status: 'active' };
    if (search) { const r = new RegExp(search, 'i'); filter.$or = [{ companyName: r }, { supplierCode: r }]; }
    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort({ companyName: 1 }).skip((p-1)*l).limit(l)
        .select('companyName supplierCode mobile city currentOutstanding').lean(),
      Supplier.countDocuments(filter),
    ]);
    const supplierIds = suppliers.map((supplier) => supplier._id);
    const branchBalances = supplierIds.length
      ? await SupplierLedger.aggregate([
        { $match: { branch: req.branchId, supplier: { $in: supplierIds } } },
        { $group: { _id: '$supplier', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ])
      : [];
    const balanceBySupplier = new Map(branchBalances.map((balance) => [
      String(balance._id),
      (balance.credit || 0) - (balance.debit || 0),
    ]));
    const data = suppliers.map((supplier) => ({
      ...supplier,
      consolidatedOutstanding: supplier.currentOutstanding || 0,
      currentOutstanding: balanceBySupplier.get(String(supplier._id)) || 0,
    }));
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total/l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
