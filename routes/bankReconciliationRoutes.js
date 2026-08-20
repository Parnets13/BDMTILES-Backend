import { Router } from 'express';
import BankReconciliation from '../models/BankReconciliation.js';
import Payment from '../models/Payment.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/bank-reconciliation — list
router.get('/', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (status) filter.status = status;

    const [data, total] = await Promise.all([
      BankReconciliation.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('createdBy', 'name').lean(),
      BankReconciliation.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/bank-reconciliation/stats
router.get('/stats', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const [total, draft, inProgress, completed, approved] = await Promise.all([
      BankReconciliation.countDocuments(),
      BankReconciliation.countDocuments({ status: 'draft' }),
      BankReconciliation.countDocuments({ status: 'in_progress' }),
      BankReconciliation.countDocuments({ status: 'completed' }),
      BankReconciliation.countDocuments({ status: 'approved' }),
    ]);
    res.json({ success: true, data: { total, draft, inProgress, completed, approved } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/bank-reconciliation — create with entries (manual or parsed from upload)
router.post('/', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };
    const count = await BankReconciliation.countDocuments();
    data.reconciliationNumber = `BR-${String(count + 1).padStart(5, '0')}`;

    // Calculate totals from entries
    if (data.entries?.length) {
      data.totalEntries = data.entries.length;
      data.totalDebit = data.entries.reduce((s, e) => s + (e.debit || 0), 0);
      data.totalCredit = data.entries.reduce((s, e) => s + (e.credit || 0), 0);
      data.unmatchedEntries = data.entries.filter(e => e.matchStatus === 'unmatched').length;
      data.matchedEntries = data.entries.filter(e => e.matchStatus === 'matched').length;
    }

    const recon = await BankReconciliation.create(data);
    res.status(201).json({ success: true, message: `Reconciliation ${recon.reconciliationNumber} created.`, data: recon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/bank-reconciliation/:id
router.get('/:id', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const recon = await BankReconciliation.findById(req.params.id)
      .populate('createdBy', 'name')
      .populate('completedBy', 'name')
      .lean();
    if (!recon) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, data: recon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/bank-reconciliation/:id/auto-match — auto-match entries with payments
router.patch('/:id/auto-match', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const recon = await BankReconciliation.findById(req.params.id);
    if (!recon) return res.status(404).json({ success: false, message: 'Not found.' });

    // Get payments in the reconciliation period
    const payments = await Payment.find({
      paymentDate: { $gte: recon.statementFrom, $lte: recon.statementTo },
      status: 'confirmed',
    }).select('receiptNumber amount paymentMode utrNumber chequeNumber dealer').lean();

    let matchCount = 0;
    for (const entry of recon.entries) {
      if (entry.matchStatus === 'matched') continue;

      // Try to match by amount + reference
      const amount = entry.credit || entry.debit;
      const match = payments.find(p =>
        Math.abs(p.amount - amount) < 1 && (
          (entry.reference && p.utrNumber && entry.reference.includes(p.utrNumber)) ||
          (entry.reference && p.chequeNumber && entry.reference.includes(p.chequeNumber)) ||
          (entry.description && p.receiptNumber && entry.description.includes(p.receiptNumber))
        )
      );

      if (match) {
        entry.matchStatus = 'matched';
        entry.matchedWith = match.receiptNumber;
        entry.matchedVoucherId = match._id;
        entry.matchedAmount = match.amount;
        entry.difference = amount - match.amount;
        matchCount++;
      } else {
        // Try amount-only match (less confident)
        const amountMatch = payments.find(p => Math.abs(p.amount - amount) < 1);
        if (amountMatch) {
          entry.matchStatus = 'partial';
          entry.matchedWith = amountMatch.receiptNumber + ' (amount match)';
          entry.matchedAmount = amountMatch.amount;
          entry.difference = amount - amountMatch.amount;
        }
      }
    }

    recon.matchedEntries = recon.entries.filter(e => e.matchStatus === 'matched').length;
    recon.unmatchedEntries = recon.entries.filter(e => e.matchStatus === 'unmatched').length;
    recon.discrepancyEntries = recon.entries.filter(e => e.matchStatus === 'discrepancy' || e.matchStatus === 'partial').length;
    recon.netDifference = recon.entries.reduce((s, e) => s + (e.difference || 0), 0);
    recon.status = 'in_progress';
    await recon.save();

    res.json({ success: true, message: `Auto-matched ${matchCount} entries.`, data: recon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/bank-reconciliation/:id/match-entry — manually match single entry
router.patch('/:id/match-entry', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const { entryId, matchedWith, matchedAmount, remarks } = req.body;
    const recon = await BankReconciliation.findById(req.params.id);
    if (!recon) return res.status(404).json({ success: false, message: 'Not found.' });

    const entry = recon.entries.id(entryId);
    if (!entry) return res.status(404).json({ success: false, message: 'Entry not found.' });

    entry.matchStatus = 'matched';
    entry.matchedWith = matchedWith || '';
    entry.matchedAmount = matchedAmount || (entry.credit || entry.debit);
    entry.difference = (entry.credit || entry.debit) - entry.matchedAmount;
    entry.remarks = remarks || '';

    recon.matchedEntries = recon.entries.filter(e => e.matchStatus === 'matched').length;
    recon.unmatchedEntries = recon.entries.filter(e => e.matchStatus === 'unmatched').length;
    await recon.save();

    res.json({ success: true, message: 'Entry matched.', data: recon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/bank-reconciliation/:id/complete
router.patch('/:id/complete', requirePermission('sales.order.dashboard'), async (req, res) => {
  try {
    const recon = await BankReconciliation.findById(req.params.id);
    if (!recon) return res.status(404).json({ success: false, message: 'Not found.' });
    recon.status = 'completed';
    recon.completedBy = req.user._id;
    recon.completedAt = new Date();
    await recon.save();
    res.json({ success: true, message: 'Reconciliation completed.', data: recon });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
