import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { Router } from 'express';
import BankReconciliation from '../models/BankReconciliation.js';
import BankAccount from '../models/BankAccount.js';
import Payment from '../models/Payment.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { uploadBankStatement, bankStatementDirectory } from '../middleware/upload.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const CREATE_FIELDS = [
  'reconciliationDate',
  'bankAccount',
  'statementFrom',
  'statementTo',
  'openingBalance',
  'closingBalance',
  'bookBalance',
  'entries',
  'statementFile',
  'remarks',
];
const ENTRY_FIELDS = ['date', 'description', 'reference', 'debit', 'credit', 'balance', 'remarks'];
const MATCHABLE_STATUSES = ['draft', 'in_progress'];

const routeError = (status, message) => Object.assign(new Error(message), { status });

const sendRouteError = (res, error) => {
  let status = error.status;
  if (!status && (error.name === 'CastError' || error.name === 'ValidationError')) status = 422;
  if (!status && error.code === 11000) status = 409;
  return res.status(status || 500).json({ success: false, message: error.message });
};

const pick = (source, fields) => fields.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
  return result;
}, {});

const roundCurrency = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const parseDate = (value, label, endOfDay = false) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw routeError(422, `${label} must be a valid date.`);
  if (endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
};

const finiteAmount = (value, label, defaultValue = 0) => {
  const amount = value === undefined || value === null || value === '' ? defaultValue : Number(value);
  if (!Number.isFinite(amount)) throw routeError(422, `${label} must be a valid number.`);
  return roundCurrency(amount);
};

const cleanString = (value, label) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw routeError(422, `${label} must be a string.`);
  return value;
};

const sanitizeEntry = (source, index, statementFrom, statementTo) => {
  const input = pick(source || {}, ENTRY_FIELDS);
  const date = parseDate(input.date, `Entry ${index + 1} date`);
  if (date < statementFrom || date > statementTo) {
    throw routeError(422, `Entry ${index + 1} date must be within the statement period.`);
  }

  const debit = finiteAmount(input.debit, `Entry ${index + 1} debit`);
  const credit = finiteAmount(input.credit, `Entry ${index + 1} credit`);
  if (debit < 0 || credit < 0 || (debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
    throw routeError(422, `Entry ${index + 1} must contain one non-negative debit or credit amount.`);
  }

  return {
    date,
    description: cleanString(input.description, `Entry ${index + 1} description`),
    reference: cleanString(input.reference, `Entry ${index + 1} reference`),
    debit,
    credit,
    balance: finiteAmount(input.balance, `Entry ${index + 1} balance`),
    remarks: cleanString(input.remarks, `Entry ${index + 1} remarks`),
    matchStatus: 'unmatched',
    matchedWith: '',
    matchedVoucherId: undefined,
    matchedAmount: 0,
    difference: 0,
  };
};

const recalculateSummary = (recon) => {
  const entries = recon.entries || [];
  recon.totalEntries = entries.length;
  recon.matchedEntries = entries.filter((entry) => entry.matchStatus === 'matched').length;
  recon.unmatchedEntries = entries.filter((entry) => entry.matchStatus === 'unmatched').length;
  recon.discrepancyEntries = entries.filter((entry) => ['partial', 'discrepancy'].includes(entry.matchStatus)).length;
  recon.totalDebit = roundCurrency(entries.reduce((sum, entry) => sum + finiteAmount(entry.debit, 'Entry debit'), 0));
  recon.totalCredit = roundCurrency(entries.reduce((sum, entry) => sum + finiteAmount(entry.credit, 'Entry credit'), 0));
  recon.netDifference = roundCurrency(entries.reduce((sum, entry) => sum + finiteAmount(entry.difference, 'Entry difference'), 0));
  return recon;
};

const entryDirection = (entry) => {
  const debit = finiteAmount(entry.debit, 'Entry debit');
  const credit = finiteAmount(entry.credit, 'Entry credit');
  if (credit > 0 && debit === 0) return { amount: credit, paymentType: 'dealer_receipt' };
  if (debit > 0 && credit === 0) return { amount: debit, paymentType: 'supplier_payment' };
  return null;
};

const normalizedText = (value) => String(value || '').trim().toLowerCase();

const paymentReferenceMatches = (entry, payment) => {
  const statementText = normalizedText(`${entry.reference || ''} ${entry.description || ''}`);
  if (!statementText) return false;
  return [payment.paymentNumber, payment.transactionRef, payment.chequeNumber]
    .map(normalizedText)
    .filter(Boolean)
    .some((reference) => statementText.includes(reference));
};

const validateManualMatchBody = (body = {}) => {
  const allowed = new Set(['entryId', 'paymentId', 'remarks']);
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
  if (unexpected.length) throw routeError(422, 'Only entryId, paymentId, and remarks may be supplied.');
  if (!body.entryId || !body.paymentId) throw routeError(422, 'entryId and paymentId are required.');
  if (body.remarks !== undefined && typeof body.remarks !== 'string') {
    throw routeError(422, 'Remarks must be a string.');
  }
  return { entryId: body.entryId, paymentId: body.paymentId, remarks: body.remarks || '' };
};

const router = Router();
router.use(protect);
router.use(requireBranch);

// ── Statement upload and parsing ────────────────────────────────────────────
// Column aliases seen across Indian bank exports. Matching is case-insensitive
// and ignores spacing, so "Withdrawal Amt." and "withdrawal_amount" both land.
const HEADER_ALIASES = {
  date: ['date', 'txndate', 'transactiondate', 'valuedate', 'postdate', 'bookingdate'],
  description: ['description', 'narration', 'particulars', 'details', 'transactiondetails', 'remarks'],
  reference: ['reference', 'refno', 'chequeno', 'chqno', 'chqrefno', 'utr', 'instrumentid', 'referenceno'],
  debit: ['debit', 'withdrawal', 'withdrawalamt', 'withdrawals', 'dr', 'debitamount'],
  credit: ['credit', 'deposit', 'depositamt', 'deposits', 'cr', 'creditamount'],
  balance: ['balance', 'closingbalance', 'runningbalance', 'balanceamt'],
};

const normalizeHeader = (value) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

const matchHeader = (value) => {
  const key = normalizeHeader(value);
  if (!key) return null;
  return Object.keys(HEADER_ALIASES).find((field) => HEADER_ALIASES[field].includes(key)) || null;
};

/**
 * Indian bank statements are day-first. A bare "03/04/2026" therefore means
 * 3 April, not 4 March. When the first component cannot be a day the value is
 * re-read month-first instead of being silently rejected.
 */
const parseStatementDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parts = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (parts) {
    let [, first, second, year] = parts;
    if (year.length === 2) year = `20${year}`;
    const dayFirst = new Date(Date.UTC(Number(year), Number(second) - 1, Number(first)));
    if (Number(first) <= 31 && Number(second) <= 12 && !Number.isNaN(dayFirst.getTime())) return dayFirst;
    const monthFirst = new Date(Date.UTC(Number(year), Number(first) - 1, Number(second)));
    if (!Number.isNaN(monthFirst.getTime())) return monthFirst;
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** "1,23,456.78 Cr" / "(500.00)" / "₹ 2,000" all become numbers. */
const parseStatementAmount = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.abs(value) : 0;
  const text = String(value).trim();
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text) || /\bdr\b/i.test(text);
  const digits = text.replace(/[^0-9.\-]/g, '');
  if (!digits || digits === '-' || digits === '.') return 0;
  const amount = Number(digits.replace(/-/g, ''));
  if (!Number.isFinite(amount)) return 0;
  return negative ? -Math.abs(amount) : Math.abs(amount);
};

const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.text) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    return '';
  }
  return String(value).trim();
};

const rowsToEntries = (rows) => {
  let headerIndex = -1;
  let mapping = null;
  for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
    const candidate = {};
    rows[index].forEach((cell, column) => {
      const field = matchHeader(cellText(cell));
      if (field && candidate[field] === undefined) candidate[field] = column;
    });
    if (candidate.date !== undefined && (candidate.debit !== undefined || candidate.credit !== undefined)) {
      headerIndex = index;
      mapping = candidate;
      break;
    }
  }
  if (headerIndex === -1) return [];

  const entries = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const date = parseStatementDate(row[mapping.date]);
    if (!date) continue;
    const debit = mapping.debit !== undefined ? parseStatementAmount(row[mapping.debit]) : 0;
    const credit = mapping.credit !== undefined ? parseStatementAmount(row[mapping.credit]) : 0;
    const description = mapping.description !== undefined ? cellText(row[mapping.description]) : '';
    const reference = mapping.reference !== undefined ? cellText(row[mapping.reference]) : '';
    if (!debit && !credit && !description) continue;
    entries.push({
      date: date.toISOString().slice(0, 10),
      description: description.slice(0, 300),
      reference: reference.slice(0, 120),
      debit: Math.abs(debit),
      credit: Math.abs(credit),
      balance: mapping.balance !== undefined ? parseStatementAmount(row[mapping.balance]) : 0,
    });
    if (entries.length >= 5000) break;
  }
  return entries;
};

// POST /api/v1/bank-reconciliation/statement — upload, store and parse
router.post('/statement', requirePermission('reconciliation'), uploadBankStatement, async (req, res) => {
  try {
    if (!req.file) throw routeError(422, 'Attach a bank statement file.');
    const relativePath = `/private/bank-statements/${req.file.filename}`;
    const extension = path.extname(req.file.originalname).toLowerCase();

    if (extension === '.pdf') {
      return res.json({
        success: true,
        data: {
          statementFile: relativePath,
          fileName: req.file.originalname,
          entries: [],
          parsed: false,
          message: 'PDF stored and attached. Entries cannot be read from a PDF automatically — add them manually or upload the CSV/XLSX export instead.',
        },
      });
    }

    const workbook = new ExcelJS.Workbook();
    if (extension === '.csv') await workbook.csv.readFile(req.file.path);
    else await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw routeError(422, 'That file has no worksheet.');

    const rows = [];
    sheet.eachRow((row) => rows.push(row.values.slice(1)));
    const entries = rowsToEntries(rows);

    return res.json({
      success: true,
      data: {
        statementFile: relativePath,
        fileName: req.file.originalname,
        entries,
        parsed: entries.length > 0,
        message: entries.length
          ? `${entries.length} entries read from the statement.`
          : 'The file was stored, but no dated debit/credit rows were recognised. Check that the export has date, debit and credit columns.',
      },
    });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// GET /api/v1/bank-reconciliation/statement/:file — permission-gated download
router.get('/statement/:file', requirePermission('reconciliation'), async (req, res) => {
  try {
    const safeName = path.basename(req.params.file);
    const filePath = path.join(bankStatementDirectory, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Statement file not found.' });
    return res.download(filePath);
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// GET /api/v1/bank-reconciliation — list
router.get('/', requirePermission('reconciliation'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const p = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const l = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;
    const filter = { branch: req.branchScope, ...(status ? { status } : {}) };

    const [data, total] = await Promise.all([
      BankReconciliation.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('createdBy', 'name').lean(),
      BankReconciliation.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// GET /api/v1/bank-reconciliation/stats
router.get('/stats', requirePermission('reconciliation'), async (req, res) => {
  try {
    const branch = { branch: req.branchScope };
    const [total, draft, inProgress, completed, approved] = await Promise.all([
      BankReconciliation.countDocuments(branch),
      BankReconciliation.countDocuments({ ...branch, status: 'draft' }),
      BankReconciliation.countDocuments({ ...branch, status: 'in_progress' }),
      BankReconciliation.countDocuments({ ...branch, status: 'completed' }),
      BankReconciliation.countDocuments({ ...branch, status: 'approved' }),
    ]);
    return res.json({ success: true, data: { total, draft, inProgress, completed, approved } });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// POST /api/v1/bank-reconciliation — create with entries (manual or parsed from upload)
router.post('/', requirePermission('reconciliation'), async (req, res) => {
  try {
    const input = pick(req.body || {}, CREATE_FIELDS);
    const reconciliationDate = input.reconciliationDate
      ? parseDate(input.reconciliationDate, 'reconciliationDate')
      : new Date();
    const statementFrom = parseDate(input.statementFrom, 'statementFrom');
    const statementTo = parseDate(input.statementTo, 'statementTo', true);
    if (statementFrom > statementTo) throw routeError(422, 'statementFrom must not be after statementTo.');

    let bankName = '';
    let accountNumber = '';
    if (input.bankAccount) {
      const account = await BankAccount.findOne({ _id: input.bankAccount, isActive: true })
        .select('bankName accountNumber')
        .lean();
      if (!account) throw routeError(422, 'Bank account was not found or is inactive.');
      bankName = account.bankName;
      accountNumber = account.accountNumber;
    }

    if (input.entries !== undefined && !Array.isArray(input.entries)) {
      throw routeError(422, 'entries must be an array.');
    }
    const entries = (input.entries || []).map((entry, index) => sanitizeEntry(entry, index, statementFrom, statementTo));
    const data = {
      branch: req.branchId,
      reconciliationNumber: await generateBranchNumber(req.branchId, 'bankReconciliation', reconciliationDate),
      reconciliationDate,
      bankAccount: input.bankAccount || undefined,
      bankName,
      accountNumber,
      statementFrom,
      statementTo,
      openingBalance: finiteAmount(input.openingBalance, 'openingBalance'),
      closingBalance: finiteAmount(input.closingBalance, 'closingBalance'),
      bookBalance: finiteAmount(input.bookBalance, 'bookBalance'),
      entries,
      statementFile: cleanString(input.statementFile, 'statementFile'),
      remarks: cleanString(input.remarks, 'remarks'),
      status: 'draft',
      createdBy: req.user._id,
    };
    recalculateSummary(data);

    const recon = await BankReconciliation.create(data);
    return res.status(201).json({ success: true, message: `Reconciliation ${recon.reconciliationNumber} created.`, data: recon });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// GET /api/v1/bank-reconciliation/:id
router.get('/:id', requirePermission('reconciliation'), async (req, res) => {
  try {
    const recon = await BankReconciliation.findOne({ _id: req.params.id, branch: req.branchScope })
      .populate('createdBy', 'name')
      .populate('completedBy', 'name')
      .lean();
    if (!recon) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true, data: recon });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// PATCH /api/v1/bank-reconciliation/:id/auto-match — auto-match entries with payments
router.patch('/:id/auto-match', requirePermission('reconciliation'), async (req, res) => {
  const session = await mongoose.startSession();
  let recon;
  let matchCount = 0;
  try {
    await session.withTransaction(async () => {
      recon = await BankReconciliation.findOne({ _id: req.params.id, branch: req.branchScope }).session(session);
      if (!recon) throw routeError(404, 'Not found.');
      if (!MATCHABLE_STATUSES.includes(recon.status)) {
        throw routeError(409, 'Only draft or in-progress reconciliations can be matched.');
      }

      const payments = await Payment.find({
        branch: req.branchScope,
        paymentDate: { $gte: recon.statementFrom, $lte: parseDate(recon.statementTo, 'statementTo', true) },
        status: 'confirmed',
        paymentMode: { $nin: ['cash', 'adjustment'] },
      }).select('paymentNumber amount paymentMode transactionRef chequeNumber paymentType')
        .session(session)
        .lean();

      const usedPaymentIds = new Set(
        recon.entries.filter((entry) => entry.matchedVoucherId).map((entry) => String(entry.matchedVoucherId))
      );
      matchCount = 0;

      const candidatesFor = (entry) => {
        const direction = entryDirection(entry);
        if (!direction) return [];
        return payments.filter((payment) => (
          !usedPaymentIds.has(String(payment._id))
          && payment.paymentType === direction.paymentType
          && finiteAmount(payment.amount, 'Payment amount') === direction.amount
        ));
      };

      // Reserve high-confidence reference matches before considering any amount-only matches.
      for (const entry of recon.entries) {
        if (entry.matchStatus !== 'unmatched') continue;
        const referenceMatch = candidatesFor(entry)
          .find((payment) => paymentReferenceMatches(entry, payment));
        if (!referenceMatch) continue;

        entry.matchStatus = 'matched';
        entry.matchedWith = referenceMatch.paymentNumber;
        entry.matchedVoucherId = referenceMatch._id;
        entry.matchedAmount = finiteAmount(referenceMatch.amount, 'Payment amount');
        entry.difference = 0;
        usedPaymentIds.add(String(referenceMatch._id));
        matchCount += 1;
      }

      // A unique amount-only candidate is informational and never a confirmed match.
      for (const entry of recon.entries) {
        if (entry.matchStatus !== 'unmatched') continue;
        const candidates = candidatesFor(entry);
        if (candidates.length !== 1) continue;

        const amountMatch = candidates[0];
        entry.matchStatus = 'partial';
        entry.matchedWith = `${amountMatch.paymentNumber} (amount only)`;
        entry.matchedVoucherId = amountMatch._id;
        entry.matchedAmount = finiteAmount(amountMatch.amount, 'Payment amount');
        entry.difference = 0;
        usedPaymentIds.add(String(amountMatch._id));
      }

      recalculateSummary(recon);
      recon.status = 'in_progress';
      await recon.save({ session });
    });

    return res.json({ success: true, message: `Auto-matched ${matchCount} entries.`, data: recon });
  } catch (error) {
    return sendRouteError(res, error);
  } finally {
    await session.endSession();
  }
});

// PATCH /api/v1/bank-reconciliation/:id/match-entry — manually match single entry
router.patch('/:id/match-entry', requirePermission('reconciliation'), async (req, res) => {
  let matchInput;
  try {
    matchInput = validateManualMatchBody(req.body);
  } catch (error) {
    return sendRouteError(res, error);
  }

  const session = await mongoose.startSession();
  let recon;
  try {
    await session.withTransaction(async () => {
      const { entryId, paymentId, remarks } = matchInput;
      recon = await BankReconciliation.findOne({ _id: req.params.id, branch: req.branchScope }).session(session);
      if (!recon) throw routeError(404, 'Not found.');
      if (!MATCHABLE_STATUSES.includes(recon.status)) {
        throw routeError(409, 'Only draft or in-progress reconciliations can be matched.');
      }

      const entry = recon.entries.id(entryId);
      if (!entry) throw routeError(404, 'Entry not found.');
      const paymentAlreadyUsed = recon.entries.some((candidate) => (
        String(candidate._id) !== String(entry._id)
        && candidate.matchedVoucherId
        && String(candidate.matchedVoucherId) === String(paymentId)
      ));
      if (paymentAlreadyUsed) throw routeError(409, 'Payment is already matched to another entry.');

      const payment = await Payment.findOne({
        _id: paymentId,
        branch: req.branchScope,
        status: 'confirmed',
        paymentDate: { $gte: recon.statementFrom, $lte: parseDate(recon.statementTo, 'statementTo', true) },
      }).select('paymentNumber amount paymentType').session(session).lean();
      if (!payment) throw routeError(404, 'Confirmed payment was not found in this branch and statement period.');

      const direction = entryDirection(entry);
      if (!direction || payment.paymentType !== direction.paymentType) {
        throw routeError(422, 'Payment direction does not match the bank statement entry.');
      }
      const paymentAmount = finiteAmount(payment.amount, 'Payment amount');
      if (paymentAmount !== direction.amount) {
        throw routeError(422, 'Payment amount does not match the bank statement entry.');
      }

      entry.matchStatus = 'matched';
      entry.matchedWith = payment.paymentNumber;
      entry.matchedVoucherId = payment._id;
      entry.matchedAmount = paymentAmount;
      entry.difference = 0;
      entry.remarks = remarks;

      recalculateSummary(recon);
      recon.status = 'in_progress';
      await recon.save({ session });
    });

    return res.json({ success: true, message: 'Entry matched.', data: recon });
  } catch (error) {
    return sendRouteError(res, error);
  } finally {
    await session.endSession();
  }
});

// PATCH /api/v1/bank-reconciliation/:id/complete
router.patch('/:id/complete', requirePermission('reconciliation'), async (req, res) => {
  const session = await mongoose.startSession();
  let recon;
  try {
    await session.withTransaction(async () => {
      recon = await BankReconciliation.findOne({ _id: req.params.id, branch: req.branchScope }).session(session);
      if (!recon) throw routeError(404, 'Not found.');
      if (!MATCHABLE_STATUSES.includes(recon.status)) {
        throw routeError(409, 'Only draft or in-progress reconciliations can be completed.');
      }

      recalculateSummary(recon);
      const unresolved = recon.entries.some((entry) => entry.matchStatus !== 'matched');
      if (unresolved || recon.unmatchedEntries || recon.discrepancyEntries) {
        throw routeError(409, 'All entries must be fully matched before completion.');
      }
      if (recon.netDifference !== 0) {
        throw routeError(409, 'Reconciliation difference must be zero before completion.');
      }

      const matchedPaymentIds = recon.entries
        .filter((entry) => entry.matchedVoucherId)
        .map((entry) => String(entry.matchedVoucherId));
      if (new Set(matchedPaymentIds).size !== matchedPaymentIds.length) {
        throw routeError(409, 'A payment cannot be matched to more than one entry.');
      }

      recon.status = 'completed';
      recon.completedBy = req.user._id;
      recon.completedAt = new Date();
      await recon.save({ session });
    });

    return res.json({ success: true, message: 'Reconciliation completed.', data: recon });
  } catch (error) {
    return sendRouteError(res, error);
  } finally {
    await session.endSession();
  }
});

export default router;
