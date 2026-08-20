import RecycleBin from '../models/RecycleBin.js';
import SalesOrder from '../models/SalesOrder.js';
import Quotation from '../models/Quotation.js';
import Stock from '../models/Stock.js';
import Invoice from '../models/Invoice.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import GRN from '../models/GRN.js';

/**
 * Safe Delete Utility
 * 
 * Business Rules:
 * 1. NEVER hard-delete — always soft-delete to RecycleBin
 * 2. Check dependencies before allowing delete
 * 3. Some records require admin/owner approval before deletion
 * 4. Approved financial transactions (invoices, confirmed orders) cannot be deleted — only cancelled
 * 
 * Usage in routes:
 *   const { safeDelete, checkDependencies } = require('../middleware/safeDelete.js');
 *   await safeDelete(Model, id, { user, module, titleField, codeField });
 */

// Records that CANNOT be deleted (only cancelled/reversed)
const PROTECTED_STATUSES = {
  SalesOrder: ['confirmed', 'processing', 'dispatched', 'delivered'],
  Invoice: ['generated', 'sent'],
  PurchaseOrder: ['approved', 'received'],
  Payment: ['confirmed'],
};

// Records that require admin approval before deletion
const REQUIRES_APPROVAL = ['Product', 'Dealer', 'Supplier', 'Employee', 'Warehouse', 'Vehicle'];

/**
 * Check if a record has dependencies that would break if deleted
 */
export async function checkDependencies(model, id, modelName) {
  const errors = [];

  if (modelName === 'Product') {
    const [stockCount, soCount, qtCount, poCount] = await Promise.all([
      Stock.countDocuments({ product: id, availableQty: { $gt: 0 } }),
      SalesOrder.countDocuments({ 'items.product': id, status: { $nin: ['cancelled', 'draft'] } }),
      Quotation.countDocuments({ 'items.product': id, status: { $nin: ['cancelled'] } }),
      PurchaseOrder.countDocuments({ 'items.product': id, status: { $nin: ['cancelled'] } }),
    ]);
    if (stockCount > 0) errors.push(`Product has ${stockCount} stock entries with available quantity`);
    if (soCount > 0) errors.push(`Product is in ${soCount} active Sales Orders`);
    if (qtCount > 0) errors.push(`Product is in ${qtCount} active Quotations`);
    if (poCount > 0) errors.push(`Product is in ${poCount} active Purchase Orders`);
  }

  if (modelName === 'Dealer') {
    const [soCount, outstandingOrders] = await Promise.all([
      SalesOrder.countDocuments({ dealer: id, status: { $nin: ['cancelled', 'delivered'] } }),
      SalesOrder.countDocuments({ dealer: id, paymentStatus: { $in: ['pending', 'partial'] } }),
    ]);
    if (soCount > 0) errors.push(`Dealer has ${soCount} active/pending orders`);
    if (outstandingOrders > 0) errors.push(`Dealer has ${outstandingOrders} orders with outstanding payment`);
  }

  if (modelName === 'Supplier') {
    const poCount = await PurchaseOrder.countDocuments({ supplier: id, status: { $nin: ['cancelled', 'received'] } });
    if (poCount > 0) errors.push(`Supplier has ${poCount} active purchase orders`);
  }

  if (modelName === 'Warehouse') {
    const stockCount = await Stock.countDocuments({ warehouse: id, availableQty: { $gt: 0 } });
    if (stockCount > 0) errors.push(`Warehouse has ${stockCount} products with stock`);
  }

  return errors;
}

/**
 * Safe Delete — moves record to RecycleBin instead of hard deleting
 * Returns: { success, message, requiresApproval }
 */
export async function safeDelete(Model, id, options = {}) {
  const { user, module = '', titleField = 'name', codeField = '', reason = '', skipDependencyCheck = false } = options;
  const modelName = Model.modelName;

  // 1. Find the record
  const record = await Model.findById(id).lean();
  if (!record) {
    return { success: false, message: 'Record not found.', status: 404 };
  }

  // 2. Check if record is in a protected status (cannot be deleted, only cancelled)
  const protectedStatuses = PROTECTED_STATUSES[modelName];
  if (protectedStatuses && record.status && protectedStatuses.includes(record.status)) {
    return {
      success: false,
      message: `Cannot delete ${modelName} in "${record.status}" status. Cancel it instead.`,
      status: 400,
    };
  }

  // 3. Check dependencies (unless explicitly skipped)
  if (!skipDependencyCheck) {
    const depErrors = await checkDependencies(Model, id, modelName);
    if (depErrors.length > 0) {
      return {
        success: false,
        message: `Cannot delete. Dependencies found:\n• ${depErrors.join('\n• ')}`,
        dependencies: depErrors,
        status: 400,
      };
    }
  }

  // 4. Check if admin approval is required
  if (REQUIRES_APPROVAL.includes(modelName)) {
    // For now, allow deletion but log it. In future, create approval request.
    // TODO: Create ApprovalRequest instead of immediate deletion for non-admin users
  }

  // 5. Move to RecycleBin
  const recordTitle = record[titleField] || record.name || record.businessName || record.itemName || record.orderNumber || '';
  const recordCode = codeField ? record[codeField] : (record.productCode || record.dealerCode || record.supplierCode || record.orderNumber || record.schemeNumber || '');

  await RecycleBin.create({
    originalModel: modelName,
    originalId: id,
    recordTitle: recordTitle,
    recordCode: recordCode,
    data: record,
    deletedBy: user?._id,
    deletedByName: user?.name || '',
    deleteReason: reason,
    module: module || modelName.toLowerCase(),
    deletedAt: new Date(),
  });

  // 6. Delete from original collection
  await Model.findByIdAndDelete(id);

  return { success: true, message: `${modelName} "${recordCode || recordTitle}" moved to Recycle Bin.` };
}

/**
 * Restore from RecycleBin
 */
export async function restoreFromBin(binId) {
  const binRecord = await RecycleBin.findById(binId);
  if (!binRecord) return { success: false, message: 'Recycle bin record not found.' };

  // Dynamically get the model
  const mongoose = (await import('mongoose')).default;
  const Model = mongoose.model(binRecord.originalModel);

  // Check if original ID still conflicts
  const exists = await Model.findById(binRecord.originalId);
  if (exists) return { success: false, message: 'Record with same ID already exists. Cannot restore.' };

  // Restore
  await Model.create(binRecord.data);
  await RecycleBin.findByIdAndDelete(binId);

  return { success: true, message: `${binRecord.originalModel} "${binRecord.recordCode || binRecord.recordTitle}" restored.` };
}

export default { safeDelete, checkDependencies, restoreFromBin };
