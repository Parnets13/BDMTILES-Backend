import Asset from '../models/Asset.js';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import IncentiveEarning from '../models/IncentiveEarning.js';
import Leave from '../models/Leave.js';
import Loan from '../models/Loan.js';
import SalarySlip from '../models/SalarySlip.js';
import User from '../models/User.js';

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const num = (value) => Number(value) || 0;

const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const dayDiffInclusive = (from, to) => Math.floor((to - from) / 86400000) + 1;

// Dates in this file are local-midnight values (see parseDay in hrmsRoutes).
// toISOString() would shift them back a day for any timezone east of UTC, which
// makes the settlement basis read as the wrong period.
const fmtDay = (date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

/**
 * Live facts that gate an exit. These are deliberately recomputed on every read
 * rather than snapshotted onto the exit case: an asset returned this morning must
 * stop blocking the clearance immediately, and a stale copy would silently hold
 * up a settlement.
 *
 * Anything that cannot be measured is reported as `measurable: false` with the
 * reason, never as a zero — a zero here reads as "nothing outstanding", which is
 * the opposite of "we don't know".
 */
export async function buildClearanceFacts({ employee, branchId }) {
  const employeeId = employee._id;

  const [assetsHeld, loans, leavePending, linkedUser] = await Promise.all([
    // Asset is not branch-scoped (same as Vehicle), so custody is the only filter.
    Asset.find({ assignedTo: employeeId, isActive: true })
      .select('assetCode name category currentValue purchaseCost status condition assignedDate')
      .lean(),
    Loan.find({ branch: branchId, employee: employeeId, status: 'Active' })
      .select('type amount emiAmount remainingAmount totalInstallments paidInstallments sanctionedDate')
      .lean(),
    Leave.countDocuments({ branch: branchId, employee: employeeId, status: 'Pending' }),
    employee.userId
      ? User.findById(employee.userId).select('username email status role').lean()
      : null,
  ]);

  const loanOutstanding = round2(loans
    .filter(l => l.type === 'Loan')
    .reduce((sum, l) => sum + num(l.remainingAmount), 0));
  const advanceOutstanding = round2(loans
    .filter(l => l.type === 'Advance')
    .reduce((sum, l) => sum + num(l.remainingAmount), 0));

  // Incentive attribution lives on User, not Employee. Without a linked account
  // there is nothing to look up — say so rather than reporting zero pending.
  let pendingIncentive = { measurable: false, amount: 0, count: 0, reason: '' };
  if (!employee.userId) {
    pendingIncentive.reason = 'Employee has no linked app account, so no incentive earnings can be attributed.';
  } else {
    const [row] = await IncentiveEarning.aggregate([
      {
        $match: {
          branch: branchId,
          earnedBy: employee.userId,
          paymentStatus: { $in: ['pending', 'approved'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$earnedAmount' }, count: { $sum: 1 } } },
    ]);
    pendingIncentive = {
      measurable: true,
      amount: round2(row?.total || 0),
      count: row?.count || 0,
      reason: '',
    };
  }

  const unreturnedAssetValue = round2(assetsHeld
    .reduce((sum, a) => sum + num(a.currentValue || a.purchaseCost), 0));

  return {
    assets: {
      count: assetsHeld.length,
      totalValue: unreturnedAssetValue,
      items: assetsHeld,
      blocking: assetsHeld.length > 0,
    },
    finance: {
      loanOutstanding,
      advanceOutstanding,
      totalOutstanding: round2(loanOutstanding + advanceOutstanding),
      activeLoans: loans,
      blocking: loanOutstanding + advanceOutstanding > 0,
    },
    incentive: pendingIncentive,
    leave: {
      pendingRequests: leavePending,
      earnedBalance: num(employee.leaveBalance?.earned),
      casualBalance: num(employee.leaveBalance?.casual),
      sickBalance: num(employee.leaveBalance?.sick),
      blocking: leavePending > 0,
    },
    appAccess: {
      linked: !!employee.userId,
      username: linkedUser?.username || '',
      status: linkedUser?.status || '',
      stillActive: linkedUser?.status === 'Active',
      blocking: linkedUser?.status === 'Active',
    },
  };
}

/**
 * Draft a full-and-final settlement. Every figure carries the basis it was
 * derived from, because HR has to defend these numbers later and the inputs
 * (attendance, loan balances) keep moving after the case is closed.
 *
 * This returns a proposal only. The caller may override any line before it is
 * saved — the conventions below (30-day month, 15/26 gratuity) are the common
 * Indian defaults, not configured policy, so they must stay visible and editable.
 */
export async function computeSettlementDraft({ employee, branchId, lastWorkingDay, noticeShortfallDays = 0 }) {
  const lwd = new Date(lastWorkingDay);
  const facts = await buildClearanceFacts({ employee, branchId });
  const warnings = [];

  const isDaily = employee.salaryType === 'Daily';
  const perDayRate = isDaily
    ? round2(employee.dailyWageRate)
    : round2(num(employee.grossSalary) / 30);
  const perDayBasis = isDaily
    ? 'Daily wage rate from the employee record'
    : 'Gross salary ÷ 30 calendar days (standard convention — no per-branch policy is configured)';

  if (!isDaily && !num(employee.grossSalary)) {
    warnings.push('Employee has no gross salary on record, so the per-day rate is zero. Set the salary structure before settling.');
  }
  if (isDaily && !num(employee.dailyWageRate)) {
    warnings.push('Daily-wage employee has no daily rate on record, so pending salary computes to zero.');
  }

  // ── Pending salary for the final part-month ──────────────────────────────
  const periodStart = startOfMonth(lwd);
  const month = lwd.getMonth() + 1;
  const year = lwd.getFullYear();

  const existingSlip = await SalarySlip.findOne({
    branch: branchId, employee: employee._id, month, year,
  }).select('_id status netSalary').lean();

  let payableDays = 0;
  let pendingSalary = 0;
  let salaryBasis = '';

  if (existingSlip) {
    salaryBasis = `A salary slip already exists for ${month}/${year} (status ${existingSlip.status}), so no part-month salary is added here.`;
    warnings.push(`Salary slip for ${month}/${year} already exists — verify it does not already cover the final working days.`);
  } else {
    const calendarDays = Math.max(0, dayDiffInclusive(periodStart, lwd));
    // Unpaid absence is the only thing deducted from the calendar-day count;
    // week offs and holidays inside an employed period stay payable.
    const attendanceRows = await Attendance.aggregate([
      {
        $match: {
          branch: branchId,
          employee: employee._id,
          date: { $gte: periodStart, $lte: lwd },
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = Object.fromEntries(attendanceRows.map(r => [r._id, r.count]));
    const absentDays = num(byStatus.Absent);
    const halfDays = num(byStatus['Half Day']);
    const unpaidDays = absentDays + halfDays * 0.5;

    payableDays = round2(Math.max(0, calendarDays - unpaidDays));
    pendingSalary = round2(payableDays * perDayRate);
    salaryBasis = `${calendarDays} calendar days from ${fmtDay(periodStart)} to ${fmtDay(lwd)}, less ${unpaidDays} unpaid day(s) (${absentDays} absent, ${halfDays} half day) × ₹${perDayRate}/day.`;

    if (attendanceRows.length === 0) {
      warnings.push('No attendance records exist for the final month, so every calendar day was treated as payable. Confirm before approving.');
    }
  }

  // ── Leave encashment ────────────────────────────────────────────────────
  const leaveEncashmentDays = num(employee.leaveBalance?.earned);
  const leaveEncashment = round2(leaveEncashmentDays * perDayRate);

  // ── Gratuity: Payment of Gratuity Act, 15/26 × last basic × completed years,
  // payable only at 5+ years of continuous service.
  let gratuity = 0;
  let gratuityBasis = '';
  const joined = employee.dateOfJoining ? new Date(employee.dateOfJoining) : null;
  const completedYears = joined
    ? Math.floor((lwd - joined) / (365.25 * 86400000))
    : 0;
  if (!joined) {
    gratuityBasis = 'No joining date on record, so gratuity could not be assessed.';
    warnings.push('Employee has no joining date, so gratuity eligibility could not be assessed.');
  } else if (completedYears >= 5) {
    gratuity = round2((num(employee.basicSalary) * 15 / 26) * completedYears);
    gratuityBasis = `${completedYears} completed years × basic ₹${num(employee.basicSalary)} × 15/26.`;
  } else {
    gratuityBasis = `Not payable — ${completedYears} completed year(s), below the 5-year threshold.`;
  }

  const noticeShortfallDeduction = round2(num(noticeShortfallDays) * perDayRate);

  const pendingIncentive = facts.incentive.measurable ? facts.incentive.amount : 0;
  if (!facts.incentive.measurable) {
    warnings.push(facts.incentive.reason);
  }

  const totalEarnings = round2(pendingSalary + leaveEncashment + pendingIncentive + gratuity);
  const totalDeductions = round2(
    facts.finance.loanOutstanding
    + facts.finance.advanceOutstanding
    + noticeShortfallDeduction
    + facts.assets.totalValue
  );

  if (facts.assets.count > 0) {
    warnings.push(`${facts.assets.count} asset(s) are still assigned to this employee and their value (₹${facts.assets.totalValue}) is provisionally deducted. Record the returns to clear it.`);
  }

  return {
    draft: {
      perDayBasis,
      perDayRate,
      payableDays,
      pendingSalary,
      leaveEncashmentDays,
      leaveEncashment,
      pendingIncentive,
      gratuity,
      otherEarnings: 0,
      loanOutstanding: facts.finance.loanOutstanding,
      advanceOutstanding: facts.finance.advanceOutstanding,
      noticeShortfallDeduction,
      unreturnedAssetValue: facts.assets.totalValue,
      otherDeductions: 0,
      totalEarnings,
      totalDeductions,
      netPayable: round2(totalEarnings - totalDeductions),
    },
    basis: {
      perDay: perDayBasis,
      pendingSalary: salaryBasis,
      leaveEncashment: `${leaveEncashmentDays} earned-leave day(s) × ₹${perDayRate}/day.`,
      gratuity: gratuityBasis,
      noticeShortfall: noticeShortfallDays > 0
        ? `${noticeShortfallDays} day(s) of unserved notice × ₹${perDayRate}/day.`
        : 'Notice period served in full — no deduction.',
      unreturnedAssets: facts.assets.count > 0
        ? `Current book value of ${facts.assets.count} asset(s) still in custody.`
        : 'No assets outstanding.',
      pendingIncentive: facts.incentive.measurable
        ? `${facts.incentive.count} unpaid incentive earning(s).`
        : facts.incentive.reason,
    },
    facts,
    warnings,
    completedYears,
  };
}

/**
 * Recompute totals from whatever lines were finally agreed, so a saved settlement
 * can never hold a net that disagrees with its own components.
 */
export function recalcSettlementTotals(settlement) {
  const totalEarnings = round2(
    num(settlement.pendingSalary)
    + num(settlement.leaveEncashment)
    + num(settlement.pendingIncentive)
    + num(settlement.gratuity)
    + num(settlement.otherEarnings)
  );
  const totalDeductions = round2(
    num(settlement.loanOutstanding)
    + num(settlement.advanceOutstanding)
    + num(settlement.noticeShortfallDeduction)
    + num(settlement.unreturnedAssetValue)
    + num(settlement.otherDeductions)
  );
  return {
    totalEarnings,
    totalDeductions,
    netPayable: round2(totalEarnings - totalDeductions),
  };
}

/**
 * Close out the loans a settlement said were recovered. Without this the loan
 * stays Active forever and would be deducted again in any later report.
 */
export async function closeRecoveredLoans({ branchId, employeeId, session, actorId }) {
  const loans = await Loan.find({ branch: branchId, employee: employeeId, status: 'Active' }).session(session || null);
  for (const loan of loans) {
    loan.remainingAmount = 0;
    loan.paidInstallments = loan.totalInstallments;
    loan.status = 'Completed';
    loan.reason = `${loan.reason || ''}${loan.reason ? ' | ' : ''}Recovered in full-and-final settlement`.trim();
    if (actorId) loan.approvedBy = loan.approvedBy || actorId;
    await loan.save({ session: session || undefined });
  }
  return loans.length;
}

export const exitHelpers = { round2, num };
