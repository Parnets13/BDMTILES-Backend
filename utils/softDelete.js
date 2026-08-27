import RecycleBin from '../models/RecycleBin.js';
import { logActivity } from '../middleware/activityLogger.js';
import { getDeleteOwnership } from '../middleware/safeDelete.js';

const branchScopeForModel = (Model, branch) => {
  if (Model.schema.path('branch')) return { branch };
  if (Model.schema.path('branchId')) return { branchId: branch };
  return {};
};

const missingBranch = () => ({
  success: false,
  status: 428,
  code: 'BRANCH_REQUIRED',
  message: 'Select an active branch before continuing.',
});

/** Move a record to the selected branch's RecycleBin. */
export const softDelete = async ({ model, id, modelName, module, user, req, reason, branch, scope = {} }) => {
  try {
    const authoritativeBranch = branch || req?.branchId || scope.branch || scope.branchId;
    if (!authoritativeBranch) return missingBranch();

    const sourceFilter = {
      _id: id,
      ...scope,
      ...branchScopeForModel(model, authoritativeBranch),
    };
    const record = await model.findOne(sourceFilter).lean();
    if (!record) return { success: false, status: 404, message: `${modelName} not found.` };

    const recordTitle = record.orderNumber || record.poNumber || record.itemName
      || record.businessName || record.companyName || record.name
      || record.paymentNumber || record.voucherNumber || record.complaintNumber
      || record.leadNumber || record.schemeNumber || record.quotationNumber
      || record.debitNoteNumber || record.grnNumber || record.productCode || '';
    const recordCode = record.productCode || record.orderNumber || record.poNumber
      || record.dealerCode || record.supplierCode || record.employeeCode || record.dispatchNumber || '';

    const binRecord = await RecycleBin.create({
      branch: authoritativeBranch,
      originalModel: modelName,
      originalId: record._id,
      recordTitle,
      recordCode,
      data: record,
      deletedBy: user?._id,
      deletedByName: user?.name || '',
      deleteReason: reason || '',
      module,
      deletedAt: new Date(),
    });

    const deleted = await model.deleteOne(sourceFilter);
    if (deleted.deletedCount !== 1) {
      await RecycleBin.deleteOne({ _id: binRecord._id, branch: authoritativeBranch });
      return { success: false, status: 409, message: 'Record changed or moved outside your access scope.' };
    }

    await logActivity({
      user,
      action: 'delete',
      module,
      recordId: record._id,
      recordTitle,
      recordModel: modelName,
      description: `Deleted ${modelName}: ${recordTitle || recordCode}`,
      branch: authoritativeBranch,
      req,
    });

    return {
      success: true,
      message: `${modelName} moved to Recycle Bin. Will auto-delete after 30 days.`,
      data: { _id: record._id, branch: authoritativeBranch },
    };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};

/** Restore a record only from the selected branch's RecycleBin. */
export const restoreFromBin = async ({ binId, models, user, req, branch }) => {
  try {
    const authoritativeBranch = branch || req?.branchId;
    if (!authoritativeBranch) return missingBranch();

    const binRecord = await RecycleBin.findOne({ _id: binId, branch: authoritativeBranch });
    if (!binRecord) {
      return { success: false, status: 404, message: 'Record not found in Recycle Bin.' };
    }
    if (binRecord.originalModel === 'User') {
      return { success: false, status: 400, message: 'User accounts cannot be restored through the Recycle Bin.' };
    }

    const Model = models[binRecord.originalModel];
    if (!Model) {
      return { success: false, status: 400, message: `Cannot restore: Model "${binRecord.originalModel}" not found.` };
    }

    const data = { ...binRecord.data };
    const originalId = binRecord.originalId;
    const existing = await Model.findById(originalId);
    if (existing) {
      return { success: false, status: 400, message: 'Cannot restore: A record with the same ID already exists. It may have been re-created.' };
    }

    delete data.__v;
    if (Model.schema.path('branch')) data.branch = authoritativeBranch;
    if (Model.schema.path('branchId')) data.branchId = authoritativeBranch;

    try {
      await Model.collection.insertOne(data);
    } catch (insertErr) {
      if (insertErr.code !== 11000) throw insertErr;
      const keyPattern = insertErr.keyPattern || {};
      const keyValue = insertErr.keyValue || {};
      const conflictField = Object.keys(keyPattern)[0] || 'unknown field';
      const conflictValue = Object.values(keyValue)[0] || '';
      return {
        success: false,
        status: 400,
        message: `Cannot restore: Another ${binRecord.originalModel} already has ${conflictField} = "${conflictValue}". Delete or rename that record first, then retry restore.`,
      };
    }

    const removed = await RecycleBin.deleteOne({ _id: binId, branch: authoritativeBranch });
    if (removed.deletedCount !== 1) {
      await Model.deleteOne({ _id: originalId, ...branchScopeForModel(Model, authoritativeBranch) });
      return { success: false, status: 409, message: 'Recycle record changed during restore. No record was restored.' };
    }

    await logActivity({
      user,
      action: 'restore',
      module: binRecord.module,
      recordId: binRecord.originalId,
      recordTitle: binRecord.recordTitle,
      recordModel: binRecord.originalModel,
      description: `Restored ${binRecord.originalModel}: ${binRecord.recordTitle}`,
      branch: authoritativeBranch,
      req,
    });

    return {
      success: true,
      message: `${binRecord.originalModel} "${binRecord.recordTitle}" restored successfully.`,
      data: { _id: originalId, branch: authoritativeBranch },
    };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};

/** Permanently delete one recycle item inside the selected branch. */
export const permanentDelete = async ({ binId, user, req, branch }) => {
  try {
    const authoritativeBranch = branch || req?.branchId;
    if (!authoritativeBranch) return missingBranch();

    const binRecord = await RecycleBin.findOneAndDelete({ _id: binId, branch: authoritativeBranch });
    if (!binRecord) return { success: false, status: 404, message: 'Not found in Recycle Bin.' };

    await logActivity({
      user,
      action: 'permanent_delete',
      module: binRecord.module,
      recordId: binRecord.originalId,
      recordTitle: binRecord.recordTitle,
      recordModel: binRecord.originalModel,
      description: `Permanently deleted ${binRecord.originalModel}: ${binRecord.recordTitle}`,
      branch: authoritativeBranch,
      req,
    });

    return { success: true, message: 'Permanently deleted. Cannot be recovered.' };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};

/** Delete old recycle items only inside the selected branch. */
export const manualCleanup = async ({ olderThanDays = 30, user, req, branch }) => {
  try {
    const authoritativeBranch = branch || req?.branchId;
    if (!authoritativeBranch) return missingBranch();

    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await RecycleBin.deleteMany({
      branch: authoritativeBranch,
      deletedAt: { $lt: cutoff },
    });

    await logActivity({
      user,
      action: 'permanent_delete',
      module: 'recycle_bin',
      description: `Manual cleanup: removed ${result.deletedCount} items older than ${olderThanDays} days`,
      branch: authoritativeBranch,
      req,
    });

    return {
      success: true,
      message: `${result.deletedCount} items permanently removed.`,
      data: { deletedCount: result.deletedCount },
    };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};
