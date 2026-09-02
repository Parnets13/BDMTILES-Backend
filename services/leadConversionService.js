import Incentive from '../models/Incentive.js';
import IncentiveEarning from '../models/IncentiveEarning.js';
import LeadExecutiveAvailability from '../models/LeadExecutiveAvailability.js';
import { appendLeadActivity } from './leadActivityService.js';
import { publishLeadEvent } from './leadEventService.js';

const findRule = async (lead, at, branchId) => Incentive.findOne({
  branch: branchId,
  triggerEvent: 'lead_converted',
  applicableTo: 'sales_executive',
  status: 'active',
  validFrom: { $lte: at },
  validTo: { $gte: at },
  $or: [{ specificUsers: { $size: 0 } }, { specificUsers: lead.assignedTo }],
}).sort({ createdAt: 1 });

export const markLeadWon = async ({ lead, actor, branchId, conversionValue, convertedToDealer, convertedToCustomer, source = 'convert' }) => {
  const alreadyWon = lead.status === 'won';
  const fromStatus = lead.status;
  const at = lead.convertedAt || new Date();
  lead.status = 'won';
  lead.convertedAt = at;
  const requestedValue = conversionValue === undefined || conversionValue === null || conversionValue === ''
    ? null
    : Number(conversionValue);
  lead.conversionValue = Number.isFinite(requestedValue)
    ? requestedValue
    : (Number(lead.conversionValue) > 0 ? Number(lead.conversionValue) : Number(lead.estimatedValue || 0));
  if (convertedToDealer !== undefined) lead.convertedToDealer = convertedToDealer || null;
  if (convertedToCustomer !== undefined) lead.convertedToCustomer = convertedToCustomer || null;

  let earning = lead.incentiveEarning
    ? await IncentiveEarning.findById(lead.incentiveEarning)
    : null;
  let rule = null;

  // A conversion is one event per lead. Once evaluated, later rule changes cannot
  // duplicate an earning or replace an explicit no-rule result.
  const conversionAlreadyEvaluated = alreadyWon && (earning || lead.incentiveStatus === 'no_rule');
  if (!conversionAlreadyEvaluated) {
    if (lead.assignedTo) rule = await findRule(lead, at, branchId);
    if (rule) {
      const amount = Math.round((rule.calculate(lead.conversionValue, 1) + Number.EPSILON) * 100) / 100;
      const idempotencyKey = `lead-conversion:${lead._id}`;
      const result = await IncentiveEarning.findOneAndUpdate(
        { idempotencyKey },
        { $setOnInsert: {
          branch: branchId,
          idempotencyKey,
          incentive: rule._id,
          incentiveName: rule.incentiveName,
          incentiveType: rule.incentiveType,
          earnedBy: lead.assignedTo,
          earnedByName: lead.assignedToName,
          earnedByRole: 'sales_executive',
          triggerEvent: 'lead_converted',
          triggerReference: `Lead ${lead.leadNumber} converted`,
          referenceId: lead._id,
          referenceModel: 'Lead',
          baseValue: lead.conversionValue,
          baseQty: 1,
          earnedAmount: amount,
          calculationDetail: `${rule.incentiveName} applied to lead conversion`,
          createdBy: actor._id,
          paymentStatus: 'pending',
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true }
      );
      earning = result.value;
      if (!result.lastErrorObject?.updatedExisting && amount > 0) {
        await Incentive.updateOne({ _id: rule._id }, { $inc: { totalEarned: amount, totalPending: amount } });
      }
      lead.incentiveEligible = amount > 0;
      lead.incentiveAmount = amount;
      lead.incentiveStatus = 'earned';
      lead.incentiveEarning = earning?._id;
    } else {
      lead.incentiveEligible = false;
      lead.incentiveAmount = 0;
      lead.incentiveStatus = 'no_rule';
      lead.incentiveEarning = null;
    }
  }

  await lead.save();
  if (!alreadyWon && lead.assignedTo) {
    await LeadExecutiveAvailability.updateOne(
      { branch: branchId, user: lead.assignedTo, assignmentLoad: { $gt: 0 } },
      { $inc: { assignmentLoad: -1 } }
    );
  }
  if (!alreadyWon) {
    await appendLeadActivity({
      branch: branchId,
      lead,
      type: 'converted',
      summary: rule ? `Lead won; incentive rule ${rule.incentiveName} applied` : 'Lead won; no active incentive rule',
      actor,
      fromStatus,
      toStatus: 'won',
      data: { source, incentiveStatus: lead.incentiveStatus, earningId: earning?._id || null },
    });
  }
  if (lead.assignedTo) publishLeadEvent({ branchId, userIds: [lead.assignedTo], event: 'lead.won', data: { leadId: lead._id, action: 'won' } });
  publishLeadEvent({ branchId, event: 'lead.changed', data: { action: 'won' } });
  return { lead, earning, incentiveStatus: lead.incentiveStatus };
};

export default markLeadWon;
