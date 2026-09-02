import { getAccessPolicyScope } from './accessPolicyService.js';

export const isSalesExecutive = (user) => user?.role === 'sales_executive';

export const getLeadRecordPredicate = async (req, resourceKey = '*') => {
  const policyScope = await getAccessPolicyScope({
    user: req.user,
    branchId: req.branchId,
    module: 'lead',
    resourceKey,
  });

  return isSalesExecutive(req.user)
    ? { ...policyScope, assignedTo: req.user._id }
    : policyScope;
};

export const getLeadCreateScope = (req) => ({
  branch: req.branchId,
  createdBy: req.user._id,
  createdByName: req.user.name,
});

export default getLeadRecordPredicate;
