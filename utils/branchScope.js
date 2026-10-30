import mongoose from 'mongoose';
import Branch from '../models/Branch.js';
import Warehouse from '../models/Warehouse.js';

export const GLOBAL_BRANCH_ROLES = new Set(['super_admin', 'owner']);

export const hasGlobalBranchAccess = (user) => GLOBAL_BRANCH_ROLES.has(user?.role);

/**
 * Sentinel branch id used by the web header's "All Branches" option.
 *
 * It travels in the same `X-Branch-Id` header as a real id, so no client
 * transport changes are needed. When it arrives, `resolveBranchContext` leaves
 * `req.branchId` null (writes therefore cannot silently land in the wrong
 * branch) and fills `req.branchScope` with a Mongo `$in` covering every branch
 * the caller may read.
 */
export const ALL_BRANCHES = 'all';

const ALL_BRANCHES_CONTEXT = Object.freeze({
  _id: null,
  branchCode: '',
  name: 'All Branches',
  status: 'active',
  allBranches: true,
});

export const isAllBranchesRequest = (req) => req?.allBranches === true;

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
    req.branchIds = [];
    req.branchScope = null;
    req.allBranches = false;
    req.hasGlobalBranchAccess = hasGlobalBranchAccess(req.user);

    // "All Branches" is a read-wide context: `req.branchId` stays null so a
    // create/update can never be attributed to an arbitrary branch, while every
    // read filter rewritten to `req.branchScope` widens to the allowed set.
    if (String(headerBranchId || '').trim().toLowerCase() === ALL_BRANCHES) {
      const allowedIds = req.hasGlobalBranchAccess
        ? (await Branch.find({ status: 'active' }).select('_id').lean()).map((branch) => String(branch._id))
        : assignedIds;

      if (!allowedIds.length) {
        return res.status(403).json({ success: false, message: 'No active branches are available to you.' });
      }

      req.allBranches = true;
      req.branch = { ...ALL_BRANCHES_CONTEXT };
      req.branchIds = allowedIds;
      // ObjectIds, not strings: aggregation `$match` stages do not cast, so a
      // string `$in` would silently match nothing in every report pipeline.
      req.branchScope = { $in: allowedIds.map((id) => new mongoose.Types.ObjectId(String(id))) };
      return next();
    }

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
      req.branchIds = [selected._id];
      req.branchScope = selected._id;
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
    req.branchIds = [selected._id];
    req.branchScope = selected._id;
    req.user.defaultBranch = (req.user.assignedBranches || []).find(
      (branch) => idString(branch) === String(selected._id)
    ) || selected;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireBranch = (req, res, next) => {
  // Reading across every branch satisfies "a branch is selected"; anything that
  // writes still needs one concrete branch and is rejected here.
  if (req.allBranches && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.branchId) {
    return res.status(428).json({
      success: false,
      code: 'BRANCH_REQUIRED',
      message: req.allBranches
        ? 'You are viewing all branches. Pick a specific branch before making changes.'
        : 'Select an active branch before continuing.',
    });
  }
  return next();
};

/** Requests that must keep working while the header is on "All Branches". */
const ALL_BRANCH_WRITE_EXEMPT = [
  '/auth/',
  '/notifications',
  '/presence',
  '/support-chat',
  '/web-management',
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Guard for routes that are not behind `requireBranch` but still write.
 *
 * Creating/updating in an "All Branches" view has no correct branch to attribute
 * the record to, so it is refused with an actionable message instead of writing
 * to `branch: null`.
 */
export const blockWritesInAllBranches = (req, res, next) => {
  if (!req.allBranches || !MUTATING_METHODS.has(req.method)) return next();
  const url = String(req.originalUrl || req.url || '');
  if (ALL_BRANCH_WRITE_EXEMPT.some((path) => url.includes(path))) return next();
  return res.status(428).json({
    success: false,
    code: 'BRANCH_REQUIRED',
    message: 'You are viewing all branches. Pick a specific branch before making changes.',
  });
};

export const branchFilter = (req, filter = {}) => ({ ...filter, branch: req.branchScope ?? req.branchId });
export const branchMatch = (req, match = {}) => ({ branch: req.branchScope ?? req.branchId, ...match });

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
