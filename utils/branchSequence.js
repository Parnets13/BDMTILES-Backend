import Branch from '../models/Branch.js';
import BranchSettings from '../models/BranchSettings.js';
import BranchSequence from '../models/BranchSequence.js';

export function getFiscalYear(date = new Date(), startMonth = 4) {
  const value = new Date(date);
  const year = value.getFullYear();
  const startsThisYear = value.getMonth() + 1 >= startMonth;
  const startYear = startsThisYear ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

export async function generateBranchNumber(branchId, documentType, date = new Date()) {
  const [branch, settings] = await Promise.all([
    Branch.findById(branchId).select('branchCode').lean(),
    BranchSettings.findOne({ branch: branchId }).lean(),
  ]);
  if (!branch) {
    const error = new Error('Branch not found.');
    error.status = 404;
    throw error;
  }

  const fiscalYearStartMonth = settings?.fiscalYearStartMonth || 4;
  const fiscalYear = getFiscalYear(date, fiscalYearStartMonth);
  const config = settings?.numbering?.[documentType] || {};
  const sequenceBucket = config.includeFiscalYear === false ? 'ALL' : fiscalYear;
  const counter = await BranchSequence.findOneAndUpdate(
    { branch: branchId, documentType, fiscalYear: sequenceBucket },
    { $inc: { value: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  const prefix = config.prefix || documentType.toUpperCase();
  const parts = [prefix];
  if (config.includeBranchCode !== false) parts.push(branch.branchCode);
  if (config.includeFiscalYear !== false) parts.push(fiscalYear);
  parts.push(String(counter.value).padStart(config.padding || 5, '0'));
  return parts.join('/');
}
