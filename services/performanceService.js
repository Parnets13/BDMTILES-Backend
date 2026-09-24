import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import Incentive from '../models/Incentive.js';
import Task from '../models/Task.js';
import { PERFORMANCE_COMPONENTS } from '../models/PerformanceReview.js';
import { TARGET_RULE_MATCH, computeAchievement, metricOf } from './targetService.js';

const round2 = (value) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
const num = (value) => Number(value) || 0;
const clamp01 = (value) => Math.min(1, Math.max(0, value));

// Attendance statuses that count as a day worked, and the ones that are not the
// employee's to answer for. Week offs and holidays are excluded from the
// denominator entirely rather than counted as attended — inflating the ratio with
// days nobody was expected to work would flatter everyone equally.
const FULL_CREDIT = new Set(['Present', 'On Duty']);
const HALF_CREDIT = new Set(['Half Day', 'Late']);
const NOT_EXPECTED = new Set(['Week Off', 'Holiday']);

const GRADE_BANDS = [
  { min: 90, grade: 'A+' },
  { min: 80, grade: 'A' },
  { min: 70, grade: 'B' },
  { min: 60, grade: 'C' },
  { min: 50, grade: 'D' },
  { min: 0,  grade: 'E' },
];

export const gradeFor = (score) => GRADE_BANDS.find(band => score >= band.min)?.grade || 'E';

/**
 * Attendance score. `Late` is deliberately half credit rather than full: the SOW
 * asks for "attendance score" alongside punctuality, and a scheme where arriving
 * late costs nothing makes the punctuality half of that meaningless.
 */
async function scoreAttendance({ employeeId, branchId, from, to }) {
  const rows = await Attendance.aggregate([
    { $match: { branch: branchId, employee: employeeId, date: { $gte: from, $lte: to } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map(r => [r._id, r.count]));
  const expectedDays = rows
    .filter(r => !NOT_EXPECTED.has(r._id))
    .reduce((sum, r) => sum + r.count, 0);

  if (expectedDays === 0) {
    return {
      measurable: false,
      excludedReason: 'No attendance records exist for this employee in the review period.',
    };
  }

  const credited = rows.reduce((sum, r) => {
    if (FULL_CREDIT.has(r._id)) return sum + r.count;
    if (HALF_CREDIT.has(r._id)) return sum + r.count * 0.5;
    return sum;
  }, 0);

  const ratio = clamp01(credited / expectedDays);
  return {
    measurable: true,
    targetValue: expectedDays,
    achievedValue: round2(credited),
    achievementPercent: round2(ratio * 100),
    ratio,
    detail: `${round2(credited)} credited of ${expectedDays} expected day(s). `
      + `Present ${num(byStatus.Present)}, On Duty ${num(byStatus['On Duty'])}, `
      + `Late ${num(byStatus.Late)} (half), Half Day ${num(byStatus['Half Day'])} (half), `
      + `Absent ${num(byStatus.Absent)}, Leave ${num(byStatus.Leave)}. `
      + `Week offs and holidays excluded from the denominator.`,
  };
}

/**
 * Target-based metric. Achievement without a target is a number with no yardstick,
 * so a missing target rule makes the component unmeasurable rather than zero.
 */
async function scoreTargetMetric({ metric, branchId, userId, from, to }) {
  if (!userId) {
    return {
      measurable: false,
      excludedReason: 'Employee has no linked app account, so sales-side activity cannot be attributed to them.',
    };
  }

  // Any SE target rule for this metric whose window overlaps the review period.
  const rules = await Incentive.find({
    branch: branchId,
    ...TARGET_RULE_MATCH,
    targetValue: { $gt: 0 },
    validFrom: { $lte: to },
    validTo: { $gte: from },
    $or: [{ specificUsers: userId }, { specificUsers: { $size: 0 } }],
  }).lean();

  const applicable = rules.filter(rule => metricOf(rule) === metric);
  if (applicable.length === 0) {
    return {
      measurable: false,
      excludedReason: `No ${metric} target is defined for this employee over the review period, so achievement cannot be scored.`,
    };
  }

  // Several overlapping rules are summed — each is a per-person number, so the
  // combined target is what the employee was actually carrying.
  const targetValue = round2(applicable.reduce((sum, rule) => sum + num(rule.targetValue), 0));
  const achievedValue = await computeAchievement({ branchId, executiveId: userId, metric, from, to });
  const ratio = targetValue > 0 ? clamp01(achievedValue / targetValue) : 0;

  return {
    measurable: true,
    targetValue,
    achievedValue: round2(achievedValue),
    achievementPercent: targetValue > 0 ? round2((achievedValue / targetValue) * 100) : 0,
    ratio,
    detail: `${round2(achievedValue)} against a target of ${targetValue}, from `
      + `${applicable.length} target rule(s). Credit is capped at 100% of target.`,
  };
}

async function scoreTasks({ branchId, userId, from, to }) {
  if (!userId) {
    return {
      measurable: false,
      excludedReason: 'Employee has no linked app account, so no tasks can be attributed to them.',
    };
  }
  const rows = await Task.aggregate([
    { $match: { branch: branchId, assignedTo: userId, createdAt: { $gte: from, $lte: to } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map(r => [r._id, r.count]));
  // Cancelled tasks were withdrawn, not failed, so they leave the denominator.
  const assigned = rows
    .filter(r => r._id !== 'cancelled')
    .reduce((sum, r) => sum + r.count, 0);

  if (assigned === 0) {
    return {
      measurable: false,
      excludedReason: 'No tasks were assigned to this employee in the review period.',
    };
  }
  const completed = num(byStatus.completed);
  const ratio = clamp01(completed / assigned);
  return {
    measurable: true,
    targetValue: assigned,
    achievedValue: completed,
    achievementPercent: round2(ratio * 100),
    ratio,
    detail: `${completed} completed of ${assigned} assigned (cancelled tasks excluded). `
      + `Pending ${num(byStatus.pending)}, In progress ${num(byStatus.in_progress)}, Overdue ${num(byStatus.overdue)}.`,
  };
}

function scoreManagerRating(managerRating) {
  const rating = Number(managerRating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 10) {
    return {
      measurable: false,
      excludedReason: 'No manager rating was provided, so this component is excluded from the score.',
    };
  }
  const ratio = clamp01(rating / 10);
  return {
    measurable: true,
    targetValue: 10,
    achievedValue: rating,
    achievementPercent: round2(ratio * 100),
    ratio,
    detail: `Manager rated ${rating} out of 10.`,
  };
}

/**
 * Build the full component breakdown and the /100 score.
 *
 * Renormalisation is the important part: weights are redistributed across only
 * the measurable components, so a warehouse employee with no sales target is
 * scored on attendance, tasks and the manager's rating alone rather than being
 * penalised for metrics that were never applicable to their role.
 */
export async function computePerformance({ employee, branchId, from, to, managerRating }) {
  const employeeId = new mongoose.Types.ObjectId(String(employee._id));
  const branch = new mongoose.Types.ObjectId(String(branchId));
  const userId = employee.userId ? new mongoose.Types.ObjectId(String(employee.userId)) : null;

  const [attendance, sales, collections, visits, tasks] = await Promise.all([
    scoreAttendance({ employeeId, branchId: branch, from, to }),
    scoreTargetMetric({ metric: 'sales', branchId: branch, userId, from, to }),
    scoreTargetMetric({ metric: 'collections', branchId: branch, userId, from, to }),
    scoreTargetMetric({ metric: 'visits', branchId: branch, userId, from, to }),
    scoreTasks({ branchId: branch, userId, from, to }),
  ]);
  const manager = scoreManagerRating(managerRating);

  const results = { attendance, sales, collections, visits, tasks, managerRating: manager };

  const measurableWeight = PERFORMANCE_COMPONENTS
    .filter(def => results[def.key].measurable)
    .reduce((sum, def) => sum + def.weight, 0);

  const components = PERFORMANCE_COMPONENTS.map((def) => {
    const result = results[def.key];
    const effectiveWeight = result.measurable && measurableWeight > 0
      ? round2((def.weight / measurableWeight) * 100)
      : 0;
    return {
      key: def.key,
      label: def.label,
      weight: def.weight,
      measurable: result.measurable,
      excludedReason: result.excludedReason || '',
      targetValue: result.targetValue || 0,
      achievedValue: result.achievedValue || 0,
      achievementPercent: result.achievementPercent || 0,
      ratio: round2(result.ratio || 0),
      effectiveWeight,
      points: round2((result.ratio || 0) * effectiveWeight),
      detail: result.detail || '',
    };
  });

  const totalScore = round2(Math.min(100, components.reduce((sum, c) => sum + c.points, 0)));
  const excluded = components.filter(c => !c.measurable);

  const warnings = excluded.map(c => `${c.label}: ${c.excludedReason}`);
  if (measurableWeight === 0) {
    warnings.push('Nothing could be measured for this employee in this period. The score is not meaningful — add attendance, a target or a manager rating.');
  } else if (measurableWeight < 50) {
    warnings.push(`Only ${measurableWeight} of 100 weight could be measured, so this score rests on a narrow base. Treat it as indicative.`);
  }

  return {
    components,
    totalScore: measurableWeight > 0 ? totalScore : 0,
    grade: measurableWeight > 0 ? gradeFor(totalScore) : 'NA',
    measuredWeight: measurableWeight,
    excludedComponents: excluded.map(c => c.key),
    warnings,
    // Suggestions, not decisions — the reviewer confirms or overrides both.
    suggestions: {
      pipRecommended: measurableWeight >= 50 && totalScore < 50,
      promotionRecommended: measurableWeight >= 70 && totalScore >= 85,
      rationale: measurableWeight < 50
        ? 'Too little measurable data to suggest a PIP or promotion.'
        : totalScore < 50
          ? 'Score below 50 on a sufficient measurement base suggests a performance improvement plan.'
          : totalScore >= 85
            ? 'Score of 85+ on a broad measurement base supports a promotion discussion.'
            : 'Score sits in the normal band — no PIP or promotion is indicated.',
    },
  };
}

export const performanceHelpers = { round2, clamp01 };
