import mongoose from 'mongoose';
import RecycleBin from '../models/RecycleBin.js';

/**
 * Explicit ownership policy. Absence of a branch field is never used to infer ownership.
 * Global-compatible means existing records stay global until the business defines ownership.
 */
export const DELETE_OWNERSHIP = Object.freeze({
  Product: 'global',
  Brand: 'global',
  Category: 'global',
  Subcategory: 'global',
  Dealer: 'global',
  Supplier: 'global',
  Region: 'global',
  DealerType: 'global',
  DealerCategory: 'global',
  ExpenseCategory: 'global',
  DiscountMapping: 'global',
  Customer: 'global-compatible',
  Route: 'global-compatible',
  Vehicle: 'global-compatible',
  Document: 'global-compatible',
  Warehouse: 'branch',
  SalesOrder: 'branch',
  Quotation: 'branch',
  PurchaseOrder: 'branch',
  Invoice: 'branch',
  Lead: 'branch',
  Task: 'branch',
});

const PROTECTED_STATUSES = {
  SalesOrder: ['confirmed', 'processing', 'dispatched', 'delivered'],
  Invoice: ['generated', 'sent'],
  PurchaseOrder: ['approved', 'received'],
  Payment: ['confirmed'],
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collection = (name) => mongoose.connection.collection(name);

const dependency = (collectionName, label, filter) => ({ collectionName, label, filter });

const DEPENDENCIES = {
  Product: (id) => [
    dependency('stocks', 'stock records', { product: id }),
    dependency('salesorders', 'sales orders', { 'items.product': id }),
    dependency('quotations', 'quotations', { 'items.product': id }),
    dependency('invoices', 'invoices', { 'items.product': id }),
    dependency('purchaseorders', 'purchase orders', { 'items.product': id }),
    dependency('grns', 'GRNs', { 'items.product': id }),
    dependency('stocktransfers', 'stock transfers', { 'items.product': id }),
    dependency('salesreturns', 'sales returns', { 'items.product': id }),
    dependency('purchasereturns', 'purchase returns', { 'items.product': id }),
    dependency('picklists', 'pick lists', { 'items.product': id }),
    dependency('samples', 'samples', { product: id }),
    dependency('complaints', 'complaints', { 'products.product': id }),
    dependency('supplierschemes', 'supplier schemes', { 'products.product': id }),
    dependency('discountmappings', 'discount mappings', { product: id }),
    dependency('dealerpricings', 'dealer pricing rules', { product: id }),
    dependency('purchaserequisitions', 'purchase requisitions', { 'items.product': id }),
  ],
  Brand: (id) => [
    dependency('categories', 'categories', { brand: id }),
    dependency('subcategories', 'subcategories', { brand: id }),
    dependency('products', 'products', { brand: id }),
    dependency('discountmappings', 'discount mappings', { brand: id }),
  ],
  Category: (id) => [
    dependency('subcategories', 'subcategories', { category: id }),
    dependency('products', 'products', { category: id }),
    dependency('discountmappings', 'discount mappings', { category: id }),
  ],
  Subcategory: (id) => [
    dependency('products', 'products', { subcategory: id }),
    dependency('discountmappings', 'discount mappings', { subcategory: id }),
  ],
  Dealer: (id) => [
    dependency('salesorders', 'sales orders', { dealer: id }),
    dependency('quotations', 'quotations', { dealer: id }),
    dependency('invoices', 'invoices', { dealer: id }),
    dependency('salesreturns', 'sales returns', { dealer: id }),
    dependency('payments', 'payments', { dealer: id }),
    dependency('deliveries', 'deliveries', { dealer: id }),
    dependency('dealerledgers', 'dealer ledger entries', { dealer: id }),
    dependency('complaints', 'complaints', { dealer: id }),
    dependency('cheques', 'cheques', { dealer: id }),
    dependency('samples', 'samples', { dealer: id }),
    dependency('dealerschemes', 'dealer schemes', { dealers: id }),
    dependency('incentiveearnings', 'incentive earnings', { dealer: id }),
    dependency('leads', 'converted leads', { convertedToDealer: id }),
    dependency('users', 'user assignments', { assignedDealers: id }),
    dependency('dealerpricings', 'dealer pricing rules', { $or: [{ dealer: id }, { customerType: 'dealer', customerId: id }] }),
  ],
  Supplier: (id) => [
    dependency('purchaseorders', 'purchase orders', { supplier: id }),
    dependency('grns', 'GRNs', { supplier: id }),
    dependency('purchasereturns', 'purchase returns', { supplier: id }),
    dependency('payments', 'payments', { supplier: id }),
    dependency('cheques', 'cheques', { supplier: id }),
    dependency('supplierledgers', 'supplier ledger entries', { supplier: id }),
    dependency('supplierschemes', 'supplier schemes', { supplier: id }),
    dependency('supplierinvoices', 'supplier invoices', { supplier: id }),
  ],
  Region: (id) => [
    dependency('routes', 'routes', { region: id }),
    dependency('warehouses', 'warehouses', { region: id }),
    dependency('dealers', 'dealers', { assignedRegion: id }),
    dependency('users', 'user assignments', { assignedRegions: id }),
  ],
  Route: (id) => [
    dependency('dealers', 'dealers', { assignedRoute: id }),
    dependency('dispatches', 'dispatch records', { route: id }),
    dependency('vehicles', 'vehicles', { assignedRoute: id }),
  ],
  Warehouse: (id) => [
    dependency('branches', 'branch defaults', { defaultWarehouse: id }),
    dependency('users', 'user assignments', { $or: [{ assignedWarehouse: id }, { assignedWarehouses: id }] }),
    dependency('stocks', 'stock records', { warehouse: id }),
    dependency('purchaseorders', 'purchase orders', { receivingWarehouse: id }),
    dependency('salesorders', 'sales orders', { 'items.warehouse': id }),
    dependency('grns', 'GRNs', { 'items.warehouse': id }),
    dependency('salesreturns', 'sales returns', { 'items.warehouse': id }),
    dependency('purchasereturns', 'purchase returns', { 'items.warehouse': id }),
    dependency('picklists', 'pick lists', { 'items.warehouse': id }),
    dependency('purchaserequisitions', 'purchase requisitions', { warehouse: id }),
    dependency('dispatches', 'dispatch records', { warehouse: id }),
    dependency('samples', 'samples', { warehouse: id }),
    dependency('stocktransfers', 'stock transfers', { $or: [{ fromWarehouse: id }, { toWarehouse: id }] }),
  ],
  Customer: (id) => [
    dependency('samples', 'samples', { customer: id }),
    dependency('leads', 'converted leads', { convertedToCustomer: id }),
    dependency('dealerpricings', 'customer pricing rules', { customerId: id, customerType: { $ne: 'dealer' } }),
    dependency('documents', 'documents', { linkedTo: 'customer', linkedEntityId: id }),
  ],
  Vehicle: (id, record) => {
    const number = record?.vehicleNumber;
    const refs = [
      dependency('dispatchtrips', 'dispatch trips', { vehicle: id }),
      dependency('documents', 'documents', { linkedTo: 'vehicle', linkedEntityId: id }),
    ];
    if (number) refs.push(
      dependency('dispatches', 'dispatch records', { vehicle: number }),
      dependency('stocktransfers', 'stock transfers', { vehicleNumber: number }),
      dependency('invoices', 'invoices', { vehicleNumber: number }),
      dependency('grns', 'GRNs', { vehicleNo: number })
    );
    return refs;
  },
  DealerType: (id) => [
    dependency('dealers', 'dealers', { dealerType: id }),
    dependency('dealerschemes', 'dealer schemes', { dealerType: id }),
  ],
  DealerCategory: (id) => [
    dependency('dealers', 'dealers', { dealerCategory: id }),
    dependency('dealerschemes', 'dealer schemes', { dealerCategory: id }),
  ],
  ExpenseCategory: (id, record) => {
    const aliases = [record?.code, record?.name].filter(Boolean);
    const legacyFilters = aliases.map((value) => ({ category: new RegExp(`^${escapeRegex(value)}$`, 'i') }));
    return [dependency('expenses', 'expenses', { $or: [{ expenseCategory: id }, ...legacyFilters] })];
  },
};

const branchScopeForModel = (Model, branch) => {
  if (Model.schema.path('branch')) return { branch };
  if (Model.schema.path('branchId')) return { branchId: branch };
  return null;
};

export const getDeleteOwnership = (modelName, explicitOwnership) => explicitOwnership || DELETE_OWNERSHIP[modelName];

/** Dependencies for global identities intentionally have no branch predicate. */
export async function checkDependencies(model, id, modelName = model.modelName, branch, record = null) {
  const build = DEPENDENCIES[modelName];
  if (!build) return [];
  const descriptors = build(id, record) || [];
  const counts = await Promise.all(descriptors.map(async (item) => ({
    ...item,
    count: await collection(item.collectionName).countDocuments(item.filter),
  })));
  return counts.filter((item) => item.count > 0)
    .map((item) => `${item.count} ${item.label}`);
}

/** Move a record to the selected branch's RecycleBin; branch is audit context for globals. */
export async function safeDelete(Model, id, options = {}) {
  const {
    user,
    module = '',
    titleField = 'name',
    codeField = '',
    reason = '',
    skipDependencyCheck = false,
    scope = {},
    branch,
    req,
    ownership: explicitOwnership,
  } = options;
  const modelName = Model.modelName;
  const auditBranch = branch || req?.branchId || scope.branch || scope.branchId;
  if (!auditBranch) {
    return { success: false, status: 428, code: 'BRANCH_REQUIRED', message: 'Select an active branch before deleting records.' };
  }

  const ownership = getDeleteOwnership(modelName, explicitOwnership);
  if (!ownership) {
    return { success: false, status: 500, code: 'OWNERSHIP_POLICY_REQUIRED', message: `Deletion ownership is not configured for ${modelName}.` };
  }

  let sourceFilter = { _id: id };
  if (ownership === 'branch') {
    const ownershipScope = branchScopeForModel(Model, auditBranch);
    if (!ownershipScope) {
      return { success: false, status: 500, code: 'OWNERSHIP_SCHEMA_MISMATCH', message: `${modelName} is branch-owned but has no canonical branch field.` };
    }
    sourceFilter = { _id: id, ...scope, ...ownershipScope };
  }

  const record = await Model.findOne(sourceFilter).lean();
  if (!record) return { success: false, message: 'Record not found.', status: 404 };

  const protectedStatuses = PROTECTED_STATUSES[modelName];
  if (protectedStatuses?.includes(record.status)) {
    return { success: false, message: `Cannot delete ${modelName} in "${record.status}" status. Cancel it instead.`, status: 409 };
  }

  if (!skipDependencyCheck) {
    const depErrors = await checkDependencies(Model, id, modelName, auditBranch, record);
    if (depErrors.length) {
      return {
        success: false,
        message: `Cannot delete ${modelName}. Referenced by: ${depErrors.join(', ')}.`,
        dependencies: depErrors,
        status: 409,
      };
    }
  }

  const recordTitle = record[titleField] || record.name || record.businessName
    || record.itemName || record.orderNumber || '';
  const recordCode = codeField ? record[codeField] : (record.productCode || record.dealerCode
    || record.supplierCode || record.orderNumber || record.schemeNumber || '');

  const binRecord = await RecycleBin.create({
    branch: auditBranch,
    originalModel: modelName,
    originalId: id,
    recordTitle,
    recordCode,
    data: record,
    deletedBy: user?._id,
    deletedByName: user?.name || '',
    deleteReason: reason,
    module: module || modelName.toLowerCase(),
    deletedAt: new Date(),
  });

  const deleted = await Model.deleteOne(sourceFilter);
  if (deleted.deletedCount !== 1) {
    await RecycleBin.deleteOne({ _id: binRecord._id, branch: auditBranch });
    return { success: false, message: 'Record changed or moved outside your access scope.', status: 409 };
  }

  return {
    success: true,
    message: `${modelName} "${recordCode || recordTitle}" moved to Recycle Bin.`,
    data: { _id: record._id, auditBranch, ownership },
  };
}

/** Legacy direct restore helper retained for callers outside systemRoutes. */
export async function restoreFromBin(binId, options = {}) {
  const auditBranch = options.branch || options.req?.branchId;
  if (!auditBranch) {
    return { success: false, status: 428, code: 'BRANCH_REQUIRED', message: 'Select an active branch before restoring records.' };
  }

  const binRecord = await RecycleBin.findOne({ _id: binId, branch: auditBranch });
  if (!binRecord) return { success: false, status: 404, message: 'Recycle bin record not found.' };
  if (binRecord.originalModel === 'User') {
    return { success: false, status: 400, message: 'User accounts cannot be restored through the Recycle Bin.' };
  }

  const Model = mongoose.model(binRecord.originalModel);
  const ownership = getDeleteOwnership(binRecord.originalModel, options.ownership);
  if (!ownership) return { success: false, status: 500, message: `Restore ownership is not configured for ${binRecord.originalModel}.` };
  const exists = await Model.findById(binRecord.originalId);
  if (exists) return { success: false, status: 409, message: 'Record with same ID already exists. Cannot restore.' };

  const data = { ...binRecord.data };
  if (ownership === 'branch') {
    const branchScope = branchScopeForModel(Model, auditBranch);
    if (!branchScope) return { success: false, status: 500, message: 'Branch-owned restore schema is invalid.' };
    Object.assign(data, branchScope);
  }
  await Model.create(data);
  await RecycleBin.deleteOne({ _id: binId, branch: auditBranch });
  return { success: true, message: `${binRecord.originalModel} "${binRecord.recordCode || binRecord.recordTitle}" restored.` };
}

export default { safeDelete, checkDependencies, restoreFromBin, getDeleteOwnership, DELETE_OWNERSHIP };
