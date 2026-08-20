import RecycleBin from '../models/RecycleBin.js';
import { logActivity } from '../middleware/activityLogger.js';

/**
 * Soft delete a record — moves it to RecycleBin instead of permanent delete.
 *
 * Usage in route:
 *   const result = await softDelete({
 *     model: Product,
 *     id: req.params.id,
 *     modelName: 'Product',
 *     module: 'product',
 *     user: req.user,
 *     req,
 *     reason: req.body.deleteReason || '',
 *   });
 *   if (!result.success) return res.status(result.status).json(result);
 *   res.json(result);
 */
export const softDelete = async ({ model, id, modelName, module, user, req, reason }) => {
  try {
    const record = await model.findById(id).lean();
    if (!record) {
      return { success: false, status: 404, message: `${modelName} not found.` };
    }

    // Generate display title
    const recordTitle = record.orderNumber || record.poNumber || record.itemName ||
      record.businessName || record.companyName || record.name ||
      record.paymentNumber || record.voucherNumber || record.complaintNumber ||
      record.leadNumber || record.schemeNumber || record.quotationNumber ||
      record.debitNoteNumber || record.grnNumber || record.productCode || '';

    const recordCode = record.productCode || record.orderNumber || record.poNumber ||
      record.dealerCode || record.supplierCode || record.employeeCode || record.dispatchNumber || '';

    // Move to recycle bin
    await RecycleBin.create({
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

    // Delete from original collection
    await model.findByIdAndDelete(id);

    // Log the activity
    await logActivity({
      user,
      action: 'delete',
      module,
      recordId: record._id,
      recordTitle,
      recordModel: modelName,
      description: `Deleted ${modelName}: ${recordTitle || recordCode}`,
      req,
    });

    return { success: true, message: `${modelName} moved to Recycle Bin. Will auto-delete after 30 days.` };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};

/**
 * Restore a record from RecycleBin back to its original collection.
 */
export const restoreFromBin = async ({ binId, models, user, req }) => {
  try {
    const binRecord = await RecycleBin.findById(binId);
    if (!binRecord) {
      return { success: false, status: 404, message: 'Record not found in Recycle Bin.' };
    }

    // Get the mongoose model by name
    const Model = models[binRecord.originalModel];
    if (!Model) {
      return { success: false, status: 400, message: `Cannot restore: Model "${binRecord.originalModel}" not found.` };
    }

    // Restore the record — insert raw to bypass validation (data was valid when originally created)
    const data = { ...binRecord.data };
    const originalId = binRecord.originalId;
    
    // Check if a record with same ID already exists
    const existing = await Model.findById(originalId);
    if (existing) {
      return { success: false, status: 400, message: `Cannot restore: A record with the same ID already exists. It may have been re-created.` };
    }

    // Remove mongoose internal fields
    delete data.__v;

    // Insert directly into collection (bypasses schema validation — data was valid when saved)
    try {
      await Model.collection.insertOne(data);
    } catch (insertErr) {
      if (insertErr.code === 11000) {
        // Duplicate key on unique field (e.g. productCode already exists)
        // This means another record has the same unique field value
        // Find which field conflicts and provide clear message
        const keyPattern = insertErr.keyPattern || {};
        const keyValue = insertErr.keyValue || {};
        const conflictField = Object.keys(keyPattern)[0] || 'unknown field';
        const conflictValue = Object.values(keyValue)[0] || '';
        return {
          success: false, status: 400,
          message: `Cannot restore: Another ${binRecord.originalModel} already has ${conflictField} = "${conflictValue}". Delete or rename that record first, then retry restore.`,
        };
      } else {
        throw insertErr;
      }
    }

    // Remove from recycle bin
    await RecycleBin.findByIdAndDelete(binId);

    // Log restore
    await logActivity({
      user,
      action: 'restore',
      module: binRecord.module,
      recordId: binRecord.originalId,
      recordTitle: binRecord.recordTitle,
      recordModel: binRecord.originalModel,
      description: `Restored ${binRecord.originalModel}: ${binRecord.recordTitle}`,
      req,
    });

    return { success: true, message: `${binRecord.originalModel} "${binRecord.recordTitle}" restored successfully.` };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};

/**
 * Permanently delete a record from RecycleBin (no recovery possible).
 */
export const permanentDelete = async ({ binId, user, req }) => {
  try {
    const binRecord = await RecycleBin.findById(binId);
    if (!binRecord) {
      return { success: false, status: 404, message: 'Not found in Recycle Bin.' };
    }

    await RecycleBin.findByIdAndDelete(binId);

    await logActivity({
      user,
      action: 'permanent_delete',
      module: binRecord.module,
      recordId: binRecord.originalId,
      recordTitle: binRecord.recordTitle,
      recordModel: binRecord.originalModel,
      description: `Permanently deleted ${binRecord.originalModel}: ${binRecord.recordTitle}`,
      req,
    });

    return { success: true, message: 'Permanently deleted. Cannot be recovered.' };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};

/**
 * Manual cleanup — delete all recycle bin items older than specified days.
 */
export const manualCleanup = async ({ olderThanDays = 30, user, req }) => {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await RecycleBin.deleteMany({ deletedAt: { $lt: cutoff } });

    await logActivity({
      user,
      action: 'permanent_delete',
      module: 'recycle_bin',
      description: `Manual cleanup: removed ${result.deletedCount} items older than ${olderThanDays} days`,
      req,
    });

    return { success: true, message: `${result.deletedCount} items permanently removed.`, data: { deletedCount: result.deletedCount } };
  } catch (err) {
    return { success: false, status: 500, message: err.message };
  }
};
