import mongoose from 'mongoose';
import Branch from '../models/Branch.js';
import Warehouse from '../models/Warehouse.js';

export const GLOBAL_BRANCH_ROLES = new Set(['super_admin', 'owner']);

export const hasGlobalBranchAccess = (user) => GLOBAL_BRANCH_ROLES.has(user?.role);

const idString = (value) => String(value?._id || value || '');

export const getAssignedBranchIds = (user) =>
  (user?.assignedBranches || []).map(idString).filter(Boolean);

export const userCanAccessBranch = (user, branchId) =>
  hasGlobalBranchAccess(user) || getAssignedBranchIds(user).includes(idString(branchId));

export const requireGlobalBranchAccess = (req, res, next) => {
  if (!hasGlobalBranchAccess(req.user)) {
    return res.status(403).json({ success: false, message: 'Global branch administration is required.' });
  }
  return next();
};

export const branchAccessFilter = (user, filter = {}) => (
  hasGlobalBranchAccess(user)
    ? filter
    : { $and: [filter, { _id: { $in: getAssignedBranchIds(user) } }] }
);

export const resolveBranchContext = async (req, res, next) => {
  try {
    const headerBranchId = req.get('X-Branch-Id');
    const assignedIds = getAssignedBranchIds(req.user);

    req.branch = null;
    req.branchId = null;
    req.hasGlobalBranchAccess = hasGlobalBranchAccess(req.user);

    if (headerBranchId) {
      if (!mongoose.isValidObjectId(headerBranchId)) {
        return res.status(400).json({ success: false, message: 'Invalid branch context.' });
      }
      if (!req.hasGlobalBranchAccess && !assignedIds.includes(String(headerBranchId))) {
        return res.status(403).json({ success: false, message: 'You are not assigned to this branch.' });
      }

      const selected = await Branch.findOne({ _id: headerBranchId, status: 'active' }).lean();
      if (!selected) {
        return res.status(403).json({ success: false, message: 'Selected branch is unavailable.' });
      }
      req.branch = selected;
      req.branchId = selected._id;
      return next();
    }

    const defaultId = idString(req.user?.defaultBranch);
    const candidateIds = [...new Set([defaultId, ...assignedIds].filter(Boolean))];
    if (!candidateIds.length) return next();

    const activeBranches = await Branch.find({ _id: { $in: candidateIds }, status: 'active' }).lean();
    const activeById = new Map(activeBranches.map((branch) => [String(branch._id), branch]));
    const selected = candidateIds.map((id) => activeById.get(id)).find(Boolean);
    if (!selected) return next();

    req.branch = selected;
    req.branchId = selected._id;
    req.user.defaultBranch = (req.user.assignedBranches || []).find(
      (branch) => idString(branch) === String(selected._id)
    ) || selected;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireBranch = (req, res, next) => {
  if (!req.branchId) {
    return res.status(428).json({
      success: false,
      code: 'BRANCH_REQUIRED',
      message: 'Select an active branch before continuing.',
    });
  }
  return next();
};

export const branchFilter = (req, filter = {}) => ({ ...filter, branch: req.branchId });
export const branchMatch = (req, match = {}) => ({ branch: req.branchId, ...match });

export const getBranchWarehouseIds = async (branchId, extraFilter = {}) => {
  const rows = await Warehouse.find({ branch: branchId, ...extraFilter }).select('_id').lean();
  return rows.map((row) => row._id);
};

export const assertWarehousesInBranches = async (warehouseIds, branchIds, options = {}) => {
  const ids = [...new Set((warehouseIds || []).filter(Boolean).map(String))];
  const allowedBranchIds = [...new Set((branchIds || []).filter(Boolean).map(idString))];
  if (!ids.length) return [];
  if (!allowedBranchIds.length) {
    const error = new Error('At least one branch is required to validate warehouses.');
    error.status = 428;
    throw error;
  }
  if ([...ids, ...allowedBranchIds].some((id) => !mongoose.isValidObjectId(id))) {
    const error = new Error('One or more warehouse or branch identifiers are invalid.');
    error.status = 422;
    throw error;
  }

  const filter = { _id: { $in: ids }, branch: { $in: allowedBranchIds } };
  if (options.activeOnly !== false) filter.status = 'active';
  let query = Warehouse.find(filter).lean();
  if (options.session) query = query.session(options.session);
  const warehouses = await query;
  if (warehouses.length !== ids.length) {
    const error = new Error('One or more warehouses are inactive or outside the assigned branches.');
    error.status = 403;
    throw error;
  }
  return warehouses;
};

export const assertWarehousesInBranch = (warehouseIds, branchId, options = {}) =>
  assertWarehousesInBranches(warehouseIds, [branchId], options);
