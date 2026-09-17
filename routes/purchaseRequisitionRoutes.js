import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import PurchaseRequisition from '../models/PurchaseRequisition.js';
import Stock from '../models/Stock.js';
import GRN from '../models/GRN.js';
import BranchSettings from '../models/BranchSettings.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { purchaseError } from '../services/purchaseOrderService.js';
import { computeReorderPolicy } from '../services/stockAlertService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const sendError = (res, error) => {
  const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : error.code === 11000 ? 409 : 500);
  return res.status(status).json({ success: false, message: error.message });
};

// Shared item enrichment used by both create and draft-edit, so a PR always
// carries authoritative productName/code/unit/currentStock/purchaseRate snapshots.
async function buildRequisitionItems({ branchId, items, warehouseRecord, source }) {
  if (!Array.isArray(items) || !items.length) throw purchaseError(422, 'At least one requisition item is required.');
  const productIds = items.map(item => item.product);
  if (productIds.some(id => !mongoose.isValidObjectId(id))) throw purchaseError(422, 'One or more product identifiers are invalid.');
  if (new Set(productIds.map(String)).size !== productIds.length) throw purchaseError(422, 'Each product may appear only once in a requisition.');

  const [products, settings] = await Promise.all([
    Product.find({ _id: { $in: productIds }, status: 'active' })
      .select('itemName productCode images reorderLevel minStockLevel basicPrice purchaseRate unit inventoryBaseUom').lean(),
    BranchSettings.findOne({ branch: branchId }).select('inventory').lean(),
  ]);
  const productMap = new Map(products.map(product => [String(product._id), product]));
  if (productMap.size !== new Set(productIds.map(String)).size) throw purchaseError(404, 'One or more active products were not found.');

  const stockMatch = {
    branch: new mongoose.Types.ObjectId(String(branchId)),
    product: { $in: products.map(product => product._id) },
    ...(warehouseRecord ? { warehouse: warehouseRecord._id } : {}),
  };
  const grnItemMatch = {
    'items.product': { $in: products.map(product => product._id) },
    ...(warehouseRecord ? { 'items.warehouse': warehouseRecord._id } : {}),
  };
  const [stockRows, supplierHistory] = await Promise.all([
    Stock.aggregate([
      { $match: stockMatch },
      { $group: { _id: '$product', currentStock: { $sum: '$availableQty' }, stockRate: { $max: '$purchaseRate' } } },
    ]),
    source === 'reorder_suggestion' ? GRN.aggregate([
      { $match: { branch: new mongoose.Types.ObjectId(String(branchId)), status: 'posted' } },
      { $unwind: '$items' },
      { $match: grnItemMatch },
      { $sort: { postedAt: -1, grnDate: -1, _id: -1 } },
      { $group: { _id: '$items.product', supplier: { $first: '$supplier' }, supplierName: { $first: '$supplierName' }, rate: { $first: '$items.rate' } } },
    ]) : Promise.resolve([]),
  ]);
  const stockMap = new Map(stockRows.map(stock => [String(stock._id), stock]));
  const historyMap = new Map(supplierHistory.map(history => [String(history._id), history]));
  const snapshotAt = new Date();
  const minimumReorderQuantity = Math.max(1, Number(settings?.inventory?.minimumReorderQuantity || 10));
  return items.map((item, index) => {
    const requiredQty = Number(item.requiredQty);
    if (!Number.isFinite(requiredQty) || requiredQty <= 0) throw purchaseError(422, `items[${index}].requiredQty must be positive.`);
    const product = productMap.get(String(item.product));
    const stock = stockMap.get(String(product._id)) || { currentStock: 0, stockRate: 0 };
    const currentStock = Number(stock.currentStock || 0);
    const policy = computeReorderPolicy(product, settings?.inventory || {});
    const history = historyMap.get(String(product._id));
    return {
      product: product._id,
      productName: product.itemName,
      productCode: product.productCode || '',
      productImage: product.images?.[0] || '',
      unit: product.unit || item.unit || 'Box',
      purchaseRate: Number(product.purchaseRate || product.basicPrice || 0),
      requiredQty,
      currentStock,
      stockSnapshotAt: snapshotAt,
      remarks: String(item.remarks || ''),
      ...(source === 'reorder_suggestion' && warehouseRecord ? { suggestionProvenance: {
        source,
        key: [branchId, warehouseRecord._id, product._id].map(String).join(':'),
        warehouse: warehouseRecord._id,
        warehouseName: warehouseRecord.name,
        configuredReorderLevel: policy.configuredReorderLevel,
        effectiveReorderLevel: policy.effectiveReorderLevel,
        minimumStockLevel: policy.effectiveMinStockLevel,
        reorderLevelSource: policy.reorderSource,
        minimumStockLevelSource: policy.minSource,
        configurationWarnings: policy.warnings,
        suggestedQty: Math.max(policy.effectiveReorderLevel * 2 - currentStock, minimumReorderQuantity),
        lastSupplier: history?.supplier || undefined,
        lastSupplierName: history?.supplierName || '',
        lastPurchaseRate: Number(history?.rate || stock.stockRate || product.basicPrice || 0),
        snapshotAt,
      } } : {}),
    };
  });
}

router.get('/', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, priority } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const filter = { branch: req.branchId };
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ prNumber: regex }, { requestedByName: regex }, { department: regex }];
    }
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    const [data, total] = await Promise.all([
      PurchaseRequisition.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('warehouse', 'name warehouseCode').lean(),
      PurchaseRequisition.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) { return sendError(res, error); }
});

router.get('/stats', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, draft, submitted, approved, rejected, poCreated] = await Promise.all([
      PurchaseRequisition.countDocuments(scope),
      PurchaseRequisition.countDocuments({ ...scope, status: 'draft' }),
      PurchaseRequisition.countDocuments({ ...scope, status: 'submitted' }),
      PurchaseRequisition.countDocuments({ ...scope, status: 'approved' }),
      PurchaseRequisition.countDocuments({ ...scope, status: 'rejected' }),
      PurchaseRequisition.countDocuments({ ...scope, status: 'po_created' }),
    ]);
    return res.json({ success: true, data: { total, draft, submitted, approved, rejected, poCreated } });
  } catch (error) { return sendError(res, error); }
});

router.get('/:id', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('warehouse', 'name warehouseCode').populate('linkedPO', 'poNumber status grandTotal').lean();
    if (!pr) throw purchaseError(404, 'Purchase requisition not found.');
    return res.json({ success: true, data: pr });
  } catch (error) { return sendError(res, error); }
});

router.post('/', requirePermission('po.management'), async (req, res) => {
  try {
    const productIds = (req.body.items || []).map(item => item.product);
    const source = req.body.source === 'reorder_suggestion' ? 'reorder_suggestion' : 'manual';
    if (source === 'reorder_suggestion' && !req.body.warehouse) throw purchaseError(422, 'A receiving warehouse is required for a stock-suggestion requisition.');

    let warehouseRecord = null;
    if (req.body.warehouse) [warehouseRecord] = await assertWarehousesInBranch([req.body.warehouse], req.branchId);
    const items = await buildRequisitionItems({ branchId: req.branchId, items: req.body.items, warehouseRecord, source });
    const prNumber = await generateBranchNumber(req.branchId, 'purchaseRequisition', req.body.requestDate || new Date());
    const session = await mongoose.startSession();
    let pr;
    try {
      await session.withTransaction(async () => {
        if (source === 'reorder_suggestion') {
          // Serialize reorder PR creation per branch so concurrent/stale clients cannot both pass the open-PR check.
          await BranchSettings.findOneAndUpdate(
            { branch: req.branchId },
            { $inc: { reorderGuardVersion: 1 }, $setOnInsert: { branch: req.branchId, createdBy: req.user._id } },
            { upsert: true, new: true, session, setDefaultsOnInsert: true }
          );
          const existing = await PurchaseRequisition.findOne({
            branch: req.branchId,
            warehouse: warehouseRecord._id,
            status: { $in: ['draft', 'submitted', 'approved'] },
            items: { $elemMatch: { product: { $in: productIds } } },
          }).session(session).select('prNumber status items.product').lean();
          if (existing) {
            const requested = new Set(productIds.map(String));
            const conflicts = (existing.items || []).filter(item => requested.has(String(item.product))).map(item => String(item.product));
            throw purchaseError(409, `Open requisition ${existing.prNumber} (${existing.status}) already covers product(s): ${conflicts.join(', ')}.`);
          }
        }
        [pr] = await PurchaseRequisition.create([{
          prNumber,
          branch: req.branchId,
          requestDate: req.body.requestDate || new Date(),
          requiredByDate: req.body.requiredByDate || undefined,
          requestedBy: req.user._id,
          requestedByName: req.user.name,
          department: String(req.body.department || ''),
          warehouse: warehouseRecord?._id,
          warehouseName: warehouseRecord?.name || '',
          priority: req.body.priority || 'normal',
          source,
          items,
          remarks: String(req.body.remarks || ''),
          status: 'draft',
          createdBy: req.user._id,
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    return res.status(201).json({ success: true, message: `PR ${pr.prNumber} created.`, data: pr });
  } catch (error) { return sendError(res, error); }
});

// Edit a draft PR: add/remove/change item lines, quantity, warehouse, remarks.
// Only drafts are editable; once submitted/approved the line-up is part of an
// approval decision and must not change in place.
router.patch('/:id', requirePermission('po.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let pr;
    await session.withTransaction(async () => {
      const current = await PurchaseRequisition.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw purchaseError(404, 'Purchase requisition not found.');
      if (current.status !== 'draft') throw purchaseError(409, `Only a draft purchase requisition can be edited. Current status: ${current.status}.`);

      const source = current.source === 'reorder_suggestion' ? 'reorder_suggestion' : 'manual';
      let warehouseRecord = null;
      const nextWarehouse = req.body.warehouse ?? current.warehouse;
      if (source === 'reorder_suggestion' && !nextWarehouse) throw purchaseError(422, 'A receiving warehouse is required for a stock-suggestion requisition.');
      if (nextWarehouse) [warehouseRecord] = await assertWarehousesInBranch([nextWarehouse], req.branchId, { session });

      const items = await buildRequisitionItems({ branchId: req.branchId, items: req.body.items, warehouseRecord, source });

      // Preserve the reorder open-PR guard: a draft cannot be edited to cover
      // products already claimed by another open requisition in the same warehouse.
      if (source === 'reorder_suggestion') {
        const productIds = items.map(item => item.product);
        const existing = await PurchaseRequisition.findOne({
          _id: { $ne: current._id },
          branch: req.branchId,
          warehouse: warehouseRecord._id,
          status: { $in: ['draft', 'submitted', 'approved'] },
          items: { $elemMatch: { product: { $in: productIds } } },
        }).session(session).select('prNumber status items.product').lean();
        if (existing) {
          const requested = new Set(productIds.map(String));
          const conflicts = (existing.items || []).filter(item => requested.has(String(item.product))).map(item => String(item.product));
          throw purchaseError(409, `Open requisition ${existing.prNumber} (${existing.status}) already covers product(s): ${conflicts.join(', ')}.`);
        }
      }

      current.items = items;
      if (req.body.warehouse !== undefined) {
        current.warehouse = warehouseRecord?._id;
        current.warehouseName = warehouseRecord?.name || '';
      }
      if (req.body.department !== undefined) current.department = String(req.body.department || '');
      if (req.body.priority !== undefined) current.priority = req.body.priority || 'normal';
      if (req.body.requiredByDate !== undefined) current.requiredByDate = req.body.requiredByDate || undefined;
      if (req.body.remarks !== undefined) current.remarks = String(req.body.remarks || '');
      await current.save({ session });
      pr = current;
    });
    return res.json({ success: true, message: `PR ${pr.prNumber} updated.`, data: pr });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

// Cancel/delete a draft PR (recycle-bin soft delete). Only drafts can be removed.
router.delete('/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const current = await PurchaseRequisition.findOne({ _id: req.params.id, branch: req.branchId }).select('status prNumber').lean();
    if (!current) throw purchaseError(404, 'Purchase requisition not found.');
    if (current.status !== 'draft') throw purchaseError(409, `Only a draft purchase requisition can be deleted. Current status: ${current.status}.`);
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(PurchaseRequisition, req.params.id, {
      user: req.user, module: 'purchase_requisition', titleField: 'prNumber', codeField: 'prNumber',
    });
    return res.status(result.status || 200).json(result);
  } catch (error) { return sendError(res, error); }
});

router.patch('/:id/submit', requirePermission('po.management'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'draft' },
      { $set: { status: 'submitted' } },
      { new: true, runValidators: true }
    );
    if (!pr) throw purchaseError(409, 'Only a draft purchase requisition can be submitted.');
    return res.json({ success: true, message: 'PR submitted.', data: pr });
  } catch (error) { return sendError(res, error); }
});

router.patch('/:id/approve', requirePermission('po.approve'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'submitted' },
      { $set: { status: 'approved', approvedBy: req.user._id, approvalNotes: String(req.body.notes || ''), approvalDate: new Date() } },
      { new: true, runValidators: true }
    );
    if (!pr) throw purchaseError(409, 'Only a submitted purchase requisition can be approved.');
    return res.json({ success: true, message: 'PR approved.', data: pr });
  } catch (error) { return sendError(res, error); }
});

router.patch('/:id/reject', requirePermission('po.approve'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: 'submitted' },
      { $set: { status: 'rejected', approvedBy: req.user._id, approvalNotes: String(req.body.notes || ''), approvalDate: new Date() } },
      { new: true, runValidators: true }
    );
    if (!pr) throw purchaseError(409, 'Only a submitted purchase requisition can be rejected.');
    return res.json({ success: true, message: 'PR rejected.', data: pr });
  } catch (error) { return sendError(res, error); }
});

router.post('/:id/convert-to-po', requirePermission('po.management'), (_req, res) => res.status(405).json({
  success: false,
  code: 'PR_SUPPLIER_QUOTATION_REQUIRED',
  message: 'Convert the selected supplier quotation to create a purchase order.',
}));

export default router;
