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

const router = Router();
router.use(protect);
router.use(requireBranch);

const sendError = (res, error) => {
  const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : error.code === 11000 ? 409 : 500);
  return res.status(status).json({ success: false, message: error.message });
};

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
    if (!Array.isArray(req.body.items) || !req.body.items.length) throw purchaseError(422, 'At least one requisition item is required.');
    const productIds = req.body.items.map(item => item.product);
    if (productIds.some(id => !mongoose.isValidObjectId(id))) throw purchaseError(422, 'One or more product identifiers are invalid.');
    if (new Set(productIds.map(String)).size !== productIds.length) throw purchaseError(422, 'Each product may appear only once in a requisition.');
    const source = req.body.source === 'reorder_suggestion' ? 'reorder_suggestion' : 'manual';
    if (source === 'reorder_suggestion' && !req.body.warehouse) throw purchaseError(422, 'A receiving warehouse is required for a stock-suggestion requisition.');

    let warehouseRecord = null;
    if (req.body.warehouse) [warehouseRecord] = await assertWarehousesInBranch([req.body.warehouse], req.branchId);
    const [products, settings] = await Promise.all([
      Product.find({ _id: { $in: productIds }, status: { $ne: 'inactive' } })
        .select('itemName productCode images reorderLevel minStockLevel basicPrice').lean(),
      BranchSettings.findOne({ branch: req.branchId }).select('inventory').lean(),
    ]);
    const productMap = new Map(products.map(product => [String(product._id), product]));
    if (productMap.size !== productIds.length) throw purchaseError(404, 'One or more active products were not found.');

    const stockMatch = {
      branch: new mongoose.Types.ObjectId(String(req.branchId)),
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
        { $match: { branch: new mongoose.Types.ObjectId(String(req.branchId)), status: { $in: ['approved', 'posted'] } } },
        { $unwind: '$items' },
        { $match: grnItemMatch },
        { $sort: { createdAt: -1, _id: -1 } },
        { $group: { _id: '$items.product', supplier: { $first: '$supplier' }, supplierName: { $first: '$supplierName' }, rate: { $first: '$items.rate' } } },
      ]) : Promise.resolve([]),
    ]);
    const stockMap = new Map(stockRows.map(stock => [String(stock._id), stock]));
    const historyMap = new Map(supplierHistory.map(history => [String(history._id), history]));
    const snapshotAt = new Date();
    const fallbackLevel = Math.max(1, Number(settings?.inventory?.reorderFallbackLevel || 10));
    const minimumReorderQuantity = Math.max(1, Number(settings?.inventory?.minimumReorderQuantity || 10));
    const items = req.body.items.map((item, index) => {
      const requiredQty = Number(item.requiredQty);
      if (!Number.isFinite(requiredQty) || requiredQty <= 0) throw purchaseError(422, `items[${index}].requiredQty must be positive.`);
      const product = productMap.get(String(item.product));
      const stock = stockMap.get(String(product._id)) || { currentStock: 0, stockRate: 0 };
      const currentStock = Number(stock.currentStock || 0);
      const configuredReorderLevel = Number(product.reorderLevel || 0);
      const effectiveReorderLevel = configuredReorderLevel > 0 ? configuredReorderLevel : fallbackLevel;
      const minimumStockLevel = Number(product.minStockLevel || 0);
      const history = historyMap.get(String(product._id));
      return {
        product: product._id,
        productName: product.itemName,
        productCode: product.productCode || '',
        productImage: product.images?.[0] || '',
        requiredQty,
        currentStock,
        stockSnapshotAt: snapshotAt,
        remarks: String(item.remarks || ''),
        ...(source === 'reorder_suggestion' ? { suggestionProvenance: {
          source,
          key: [req.branchId, warehouseRecord._id, product._id].map(String).join(':'),
          warehouse: warehouseRecord._id,
          warehouseName: warehouseRecord.name,
          configuredReorderLevel,
          effectiveReorderLevel,
          minimumStockLevel,
          suggestedQty: Math.max(effectiveReorderLevel * 2 - currentStock, minimumStockLevel > 0 ? minimumStockLevel : minimumReorderQuantity),
          lastSupplier: history?.supplier || undefined,
          lastSupplierName: history?.supplierName || '',
          lastPurchaseRate: Number(history?.rate || stock.stockRate || product.basicPrice || 0),
          snapshotAt,
        } } : {}),
      };
    });
    const pr = await PurchaseRequisition.create({
      prNumber: await generateBranchNumber(req.branchId, 'purchaseRequisition', req.body.requestDate || new Date()),
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
    });
    return res.status(201).json({ success: true, message: `PR ${pr.prNumber} created.`, data: pr });
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
