import { Router } from 'express';
import mongoose from 'mongoose';
import Stock from '../models/Stock.js';
import StockMovement, { STOCK_BUCKET_FIELDS, STOCK_MOVEMENT_TYPES, STOCK_SOURCE_TYPES } from '../models/StockMovement.js';
import Warehouse from '../models/Warehouse.js';
import SalesOrder from '../models/SalesOrder.js';
import StockTransfer from '../models/StockTransfer.js';
import GRN from '../models/GRN.js';
import PurchaseReturn from '../models/PurchaseReturn.js';
import SalesReturn from '../models/SalesReturn.js';
import DispatchReturn from '../models/DispatchReturn.js';
import StockAdjustment from '../models/StockAdjustment.js';
import PhysicalStockAudit from '../models/PhysicalStockAudit.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import {
  getStockSummary,
  listMovements,
  listStocks,
  movementSummary,
  reconcileStockBucket,
} from '../services/stockMovementService.js';
import { getCanonicalStockAlerts } from '../services/stockAlertService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);
router.use(requirePermission('stock.view'));

const apiError = (status, message) => Object.assign(new Error(message), { status });
const handleError = (res, error) => res.status(error.status || (error.name === 'CastError' ? 422 : 500)).json({
  success: false,
  message: error.name === 'CastError' ? 'Invalid identifier.' : error.message,
});
const exactItemMatch = stock => ({
  product: stock.product?._id || stock.product,
  warehouse: stock.warehouse?._id || stock.warehouse,
  shade: stock.shade || '',
  batch: stock.batch || '',
});
const itemMatches = (item, stock) => (
  String(item.product?._id || item.product) === String(stock.product?._id || stock.product)
  && String(item.warehouse?._id || item.warehouse || '') === String(stock.warehouse?._id || stock.warehouse)
  && String(item.shade || '') === String(stock.shade || '')
  && String(item.batch || '') === String(stock.batch || '')
);
const transferItemMatches = (item, stock) => (
  String(item.product?._id || item.product) === String(stock.product?._id || stock.product)
  && String(item.shade || '') === String(stock.shade || '')
  && String(item.batch || '') === String(stock.batch || '')
);

// Static routes must remain before /:id routes.
router.get('/', async (req, res) => {
  try {
    const [result, branchTotals] = await Promise.all([listStocks(req.branchId, req.query), getStockSummary(req.branchId)]);
    return res.json({ success: true, ...result, branchTotals });
  } catch (error) { return handleError(res, error); }
});

router.get('/summary', async (req, res) => {
  try { return res.json({ success: true, data: await getStockSummary(req.branchId) }); }
  catch (error) { return handleError(res, error); }
});

router.get('/alerts', async (req, res) => {
  try {
    const result = await getCanonicalStockAlerts(req.branchId, req.query);
    return res.json({ success: true, ...result });
  } catch (error) { return handleError(res, error); }
});

router.get('/filter-options', async (req, res) => {
  try {
    const [warehouses, shades, batches] = await Promise.all([
      Warehouse.find({ branch: req.branchId }).select('warehouseCode name type status city').sort({ name: 1 }).lean(),
      Stock.distinct('shade', { branch: req.branchId, shade: { $ne: '' } }),
      Stock.distinct('batch', { branch: req.branchId, batch: { $ne: '' } }),
    ]);
    return res.json({
      success: true,
      data: {
        warehouses,
        shades: shades.sort((a, b) => a.localeCompare(b)),
        batches: batches.sort((a, b) => a.localeCompare(b)),
        movementTypes: STOCK_MOVEMENT_TYPES,
        sourceTypes: STOCK_SOURCE_TYPES,
        statuses: ['in_stock', 'low_stock', 'out_of_stock', 'reserved', 'quoted', 'damaged', 'blocked', 'in_transit', 'short'],
        deltaFields: STOCK_BUCKET_FIELDS,
      },
    });
  } catch (error) { return handleError(res, error); }
});

router.get('/movements', async (req, res) => {
  try {
    const result = await listMovements(req.branchId, req.query);
    return res.json({ success: true, ...result });
  } catch (error) { return handleError(res, error); }
});

router.get('/movements/summary', async (req, res) => {
  try { return res.json({ success: true, data: await movementSummary(req.branchId, req.query) }); }
  catch (error) { return handleError(res, error); }
});

router.get('/:id/detail', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw apiError(422, 'stock id must be a valid identifier.');
    const stock = await Stock.findOne({ _id: req.params.id, branch: req.branchId })
      .populate({ path: 'product', populate: [{ path: 'brand', select: 'name code status' }, { path: 'category', select: 'name code status' }, { path: 'subcategory', select: 'name code status' }] })
      .populate('warehouse')
      .lean();
    if (!stock) throw apiError(404, 'Stock bucket not found in the active branch.');

    const reconciliation = await reconcileStockBucket(stock);
    const match = exactItemMatch(stock);
    const itemElemMatch = { product: match.product, warehouse: match.warehouse, shade: match.shade, batch: match.batch };
    const [recentMovements, recentInbound, recentOutbound, openOrders, transfers, grns, purchaseReturns, salesReturns, dispatchReturns, stockAdjustments, physicalAudits] = await Promise.all([
      StockMovement.find({ stock: stock._id }).sort({ occurredAt: -1, _id: -1 }).limit(25)
        .populate('actor', 'name role').populate('relatedWarehouse', 'warehouseCode name branch').lean(),
      StockMovement.find({ stock: stock._id, 'deltas.totalQty': { $gt: 0 } }).sort({ occurredAt: -1, _id: -1 }).limit(10).populate('actor', 'name role').lean(),
      StockMovement.find({ stock: stock._id, 'deltas.totalQty': { $lt: 0 } }).sort({ occurredAt: -1, _id: -1 }).limit(10).populate('actor', 'name role').lean(),
      SalesOrder.find({ branch: req.branchId, status: { $nin: ['cancelled', 'delivered'] }, items: { $elemMatch: { ...itemElemMatch, reservedQuantity: { $gt: 0 } } } })
        .select('orderNumber orderDate status reservationStatus dealer dealerName items').sort({ orderDate: -1 }).limit(25).lean(),
      StockTransfer.find({ status: 'in_transit', $or: [{ sourceBranch: req.branchId, fromWarehouse: match.warehouse }, { destinationBranch: req.branchId, toWarehouse: match.warehouse }], items: { $elemMatch: { product: match.product, shade: match.shade, batch: match.batch } } })
        .select('transferNumber transferDate sourceBranch destinationBranch fromWarehouse toWarehouse status dispatchDate items').sort({ dispatchDate: -1 }).limit(25)
        .populate('fromWarehouse toWarehouse', 'warehouseCode name branch').lean(),
      GRN.find({ branch: req.branchId, status: 'posted', items: { $elemMatch: itemElemMatch } }).select('grnNumber grnDate supplier supplierName purchaseOrder poNumber items postedAt').sort({ postedAt: -1 }).limit(10).lean(),
      PurchaseReturn.find({ branch: req.branchId, status: { $in: ['debit_issued', 'reversed'] }, items: { $elemMatch: itemElemMatch } }).select('debitNoteNumber returnDate status supplier supplierName items approvalDate reversedAt').sort({ updatedAt: -1 }).limit(10).lean(),
      SalesReturn.find({ branch: req.branchId, status: { $in: ['credit_issued', 'refund_pending', 'replacement_pending', 'reversed'] }, items: { $elemMatch: itemElemMatch } }).select('returnNumber returnDate status dealer dealerName items approvalDate reversedAt').sort({ updatedAt: -1 }).limit(10).lean(),
      DispatchReturn.find({ branch: req.branchId, items: { $elemMatch: itemElemMatch } }).select('returnNumber requestedAt status delivery salesOrder items postedAt').sort({ updatedAt: -1 }).limit(10).lean(),
      StockAdjustment.find({ branch: req.branchId, status: { $in: ['submitted', 'approved', 'reversed'] }, lines: { $elemMatch: itemElemMatch } })
        .select('adjustmentNumber status reason remarks lines submittedAt approvedAt reversedAt postingVersion').sort({ updatedAt: -1 }).limit(10).lean(),
      PhysicalStockAudit.find({ branch: req.branchId, status: { $in: ['submitted', 'approved', 'reversed'] }, lines: { $elemMatch: { stock: stock._id } } })
        .select('auditNumber status warehouse scope baselineAt remarks lines submittedAt approvedAt reversedAt postingVersion').sort({ updatedAt: -1 }).limit(10).lean(),
    ]);

    const rate = Number(stock.landingCost || 0) > 0 ? Number(stock.landingCost) : Number(stock.purchaseRate || 0);
    const reorderLevel = Number(stock.product?.reorderLevel || 0);
    const available = Number(stock.availableQty || 0);
    const statuses = {
      availability: available <= 0 ? 'out_of_stock' : available <= reorderLevel ? 'low_stock' : 'in_stock',
      reserved: Number(stock.reservedQty || 0) > 0,
      quoted: Number(stock.quotedQty || 0) > 0,
      blocked: Number(stock.blockedQty || 0) > 0,
      damaged: Number(stock.damagedQty || 0) > 0,
      inTransit: Number(stock.transitQty || 0) > 0,
      short: Number(stock.shortQty || 0) > 0,
    };
    const scopedItems = rows => rows.map(row => ({ ...row, items: (row.items || []).filter(item => itemMatches(item, stock)) }));
    const scopedTransferItems = rows => rows.map(row => ({ ...row, items: (row.items || []).filter(item => transferItemMatches(item, stock)) }));
    const openReservations = openOrders.map(order => ({ ...order, items: (order.items || []).filter(item => itemMatches(item, stock) && Number(item.reservedQuantity || 0) > 0) }));

    return res.json({
      success: true,
      data: {
        stock,
        identity: { branch: stock.branch, product: stock.product?._id, warehouse: stock.warehouse?._id, shade: stock.shade, batch: stock.batch },
        product: stock.product,
        uom: { unit: stock.product?.unit, inventoryBaseUom: stock.baseUnit || stock.product?.inventoryBaseUom || stock.product?.unit, uomVersion: stock.uomVersion || stock.product?.inventoryUomVersion || 1, conversions: stock.product?.uomConversions || [], piecesPerBox: stock.product?.piecesPerBox, sqftPerBox: stock.product?.sqftPerBox, weightPerBox: stock.product?.weightPerBox },
        packaging: { piecesPerBox: stock.product?.piecesPerBox, sqftPerBox: stock.product?.sqftPerBox, weightPerBox: stock.product?.weightPerBox },
        specification: { tileSize: stock.product?.tileSize, thickness: stock.product?.thickness, finish: stock.product?.finish, surface: stock.product?.surface, colour: stock.product?.colour, design: stock.product?.design, grade: stock.product?.grade, tileType: stock.product?.tileType, applicationArea: stock.product?.applicationArea },
        warehouse: stock.warehouse,
        location: { zone: stock.zone, rack: stock.rack, bin: stock.bin },
        valuation: { purchaseRate: stock.purchaseRate, landingCost: stock.landingCost, effectiveRate: rate, totalValue: Number(stock.totalQty || 0) * rate, availableValue: available * rate },
        statuses,
        journal: { ...reconciliation, recentMovements, recentInbound, recentOutbound },
        openReservations,
        inTransitTransfers: scopedTransferItems(transfers),
        recentGRNs: scopedItems(grns),
        recentPurchaseReturns: scopedItems(purchaseReturns),
        recentSalesReturns: scopedItems(salesReturns),
        recentDispatchReturns: scopedItems(dispatchReturns),
        recentStockAdjustments: stockAdjustments.map((document) => ({ ...document, lines: (document.lines || []).filter((line) => itemMatches(line, stock)) })),
        recentPhysicalAudits: physicalAudits.map((document) => ({ ...document, lines: (document.lines || []).filter((line) => String(line.stock) === String(stock._id)) })),
        queryLimits: { movements: 25, inbound: 10, outbound: 10, openReservations: 25, transfers: 25, documentsPerType: 10 },
      },
    });
  } catch (error) { return handleError(res, error); }
});

router.get('/:id/movements', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw apiError(422, 'stock id must be a valid identifier.');
    const stock = await Stock.findOne({ _id: req.params.id, branch: req.branchId }).select('_id').lean();
    if (!stock) throw apiError(404, 'Stock bucket not found in the active branch.');
    const result = await listMovements(req.branchId, req.query, stock._id);
    return res.json({ success: true, stock: stock._id, ...result });
  } catch (error) { return handleError(res, error); }
});

export default router;
