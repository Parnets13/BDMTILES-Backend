import mongoose from 'mongoose';
import Branch from '../models/Branch.js';

/**
 * The storefront is single-branch from a customer's point of view. All online
 * orders and stock lookups use one designated branch, configured via
 * ONLINE_BRANCH_ID. If unset, we fall back to the first active branch so the
 * storefront still works in a fresh/dev environment.
 */
let cached = null;

export async function getOnlineBranchId() {
  if (cached) return cached;

  const configured = process.env.ONLINE_BRANCH_ID;
  if (configured && mongoose.isValidObjectId(configured)) {
    const branch = await Branch.findOne({ _id: configured, status: 'active' }).select('_id').lean();
    if (branch) {
      cached = branch._id;
      return cached;
    }
  }

  const fallback = await Branch.findOne({ status: 'active' }).sort({ createdAt: 1 }).select('_id').lean();
  if (!fallback) {
    const error = new Error('No active branch is configured for online orders.');
    error.status = 503;
    throw error;
  }
  cached = fallback._id;
  return cached;
}

// Exposed for tests / admin tooling to invalidate the cache after branch changes.
export function resetOnlineBranchCache() {
  cached = null;
}
