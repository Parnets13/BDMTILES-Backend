import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import StockMovement, { STOCK_BUCKET_FIELDS } from '../models/StockMovement.js';
import Warehouse from '../models/Warehouse.js';
import BranchSettings from '../models/BranchSettings.js';
import GRN from '../models/GRN.js';
import PurchaseRequisition from '../models/PurchaseRequisition.js';
import PurchaseOrder from '../models/PurchaseOrder.js';

const SEVERITIES = ['out_of_stock', 'critical', 'low_stock', 'adequate'];
const REORDER_SOURCES = ['product', 'branch_fallback'];
const SORT_FIELDS = ['severity', 'available', 'deficit', 'productName', 'stockValue', 'lastMovementAt'];
const DEFAULT_REORDER_FALLBACK = 10;
const DEFAULT_MINIMUM_FALLBACK = 5;
const DEFAULT_MINIMUM_REORDER_QUANTITY = 10;
const quantityShape = () => Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, 0]));
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const id = value => String(value?._id || value || '');
const apiError = (status, message) => Object.assign(new Error(message), { status });

const parseBoolean = (value, fallback, name) => {
  if (value === undefined || value === null || value === '') return fallback;
  if ([true, 'true', '1', 1].includes(value)) return true;
  if ([false, 'false', '0', 0].includes(value)) return false;
  throw apiError(422, `${name} must be true or false.`);
};

const parseCsv = (value, allowed, name) => {
  if (!value) return [];
  const values = String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (!values.length || values.some(item => !allowed.includes(item))) {
    throw apiError(422, `${name} contains an unsupported value.`);
  }
  return [...new Set(values)];
};

const validObjectId = (value, name) => {
  if (!value) return undefined;
  if (!mongoose.isValidObjectId(value)) throw apiError(422, `${name} must be a valid identifier.`);
  return new mongoose.Types.ObjectId(String(value));
};

export const computeReorderPolicy = (product, inventory = {}) => {
  const configuredReorderLevel = number(product?.reorderLevel);
  const configuredMinStockLevel = number(product?.minStockLevel);
  const fallbackReorderLevel = Math.max(1, number(inventory.reorderFallbackLevel) || DEFAULT_REORDER_FALLBACK);
  const fallbackMinStockLevel = inventory.minStockFallbackLevel === undefined || inventory.minStockFallbackLevel === null
    ? DEFAULT_MINIMUM_FALLBACK
    : Math.max(0, number(inventory.minStockFallbackLevel));
  const reorderSource = configuredReorderLevel > 0 ? 'product' : 'branch_fallback';
  const minSource = configuredMinStockLevel > 0 ? 'product' : 'branch_fallback';
  let effectiveReorderLevel = configuredReorderLevel > 0 ? configuredReorderLevel : fallbackReorderLevel;
  const effectiveMinStockLevel = configuredMinStockLevel > 0 ? configuredMinStockLevel : fallbackMinStockLevel;
  const warnings = [];
  if (configuredReorderLevel <= 0) warnings.push('product_reorder_not_configured');
  if (configuredMinStockLevel <= 0) warnings.push('product_minimum_not_configured');
  if (effectiveReorderLevel < effectiveMinStockLevel) {
    effectiveReorderLevel = effectiveMinStockLevel;
    warnings.push('reorder_normalized_to_minimum');
  }
  return {
    configuredReorderLevel,
    configuredMinStockLevel,
    fallbackReorderLevel,
    fallbackMinStockLevel,
    effectiveReorderLevel,
    effectiveMinStockLevel,
    reorderSource,
    minSource,
    warnings,
  };
};

export const classifyStockAlert = (available, policy) => {
  if (available <= 0) return 'out_of_stock';
  if (available <= policy.effectiveMinStockLevel) return 'critical';
  if (available <= policy.effectiveReorderLevel) return 'low_stock';
  return 'adequate';
};

const addQuantities = (target, source) => {
  for (const field of STOCK_BUCKET_FIELDS) target[field] += number(source?.[field]);
  return target;
};

const createCoverageMaps = (documents, itemField, quantityField) => {
  const map = new Map();
  for (const document of documents) {
    for (const item of document[itemField] || []) {
      const key = id(item.product);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ document, item, quantity: number(item[quantityField]) });
    }
  }
  return map;
};

const normalizeQuery = (query = {}, internalAll = false) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requestedLimit = Number.parseInt(query.limit, 10) || 20;
  if (!internalAll && (requestedLimit < 1 || requestedLimit > 200)) throw apiError(422, 'limit must be between 1 and 200.');
  const sortBy = query.sortBy || 'severity';
  const sortOrder = query.sortOrder || 'asc';
  if (!SORT_FIELDS.includes(sortBy)) throw apiError(422, `sortBy must be one of ${SORT_FIELDS.join(', ')}.`);
  if (!['asc', 'desc'].includes(sortOrder)) throw apiError(422, 'sortOrder must be asc or desc.');
  const reorderSource = query.reorderSource ? String(query.reorderSource) : undefined;
  if (reorderSource && !REORDER_SOURCES.includes(reorderSource)) throw apiError(422, `reorderSource must be one of ${REORDER_SOURCES.join(', ')}.`);
  return {
    page,
    limit: internalAll ? Number.MAX_SAFE_INTEGER : requestedLimit,
    search: String(query.search || '').trim(),
    severity: parseCsv(query.severity, SEVERITIES, 'severity'),
    includeAdequate: parseBoolean(query.includeAdequate, false, 'includeAdequate'),
    hasOpenRequisition: query.hasOpenRequisition === undefined ? undefined : parseBoolean(query.hasOpenRequisition, false, 'hasOpenRequisition'),
    warehouse: validObjectId(query.warehouse, 'warehouse'),
    brand: validObjectId(query.brand, 'brand'),
    category: validObjectId(query.category, 'category'),
    reorderSource,
    sortBy,
    sortOrder,
  };
};

const compareRows = (sortBy, direction) => {
  const severityOrder = { out_of_stock: 0, critical: 1, low_stock: 2, adequate: 3 };
  const value = row => ({
    severity: severityOrder[row.severity],
    available: row.quantities.availableQty,
    deficit: row.deficit,
    productName: row.productName.toLocaleLowerCase(),
    stockValue: row.valuation.totalValue,
    lastMovementAt: row.lastMovementAt ? new Date(row.lastMovementAt).getTime() : 0,
  })[sortBy];
  return (left, right) => {
    const a = value(left); const b = value(right);
    let primary = typeof a === 'string' ? a.localeCompare(b) : a - b;
    primary *= direction;
    return primary || left.productName.localeCompare(right.productName) || id(left.product).localeCompare(id(right.product));
  };
};

export const getCanonicalStockAlerts = async (branchId, query = {}, options = {}) => {
  const filters = normalizeQuery(query, options.internalAll);
  const branchObjectId = new mongoose.Types.ObjectId(String(branchId));
  let warehouseRecord = null;
  if (filters.warehouse) {
    warehouseRecord = await Warehouse.findOne({ _id: filters.warehouse, branch: branchObjectId, status: 'active' })
      .select('warehouseCode name type status city').lean();
    if (!warehouseRecord) throw apiError(422, 'warehouse must be active and belong to the current branch.');
  }

  const productFilter = { status: 'active' };
  if (filters.brand) productFilter.brand = filters.brand;
  if (filters.category) productFilter.category = filters.category;
  if (filters.search) {
    const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    productFilter.$or = [{ itemName: regex }, { productCode: regex }, { aliasName: regex }];
  }

  const [settings, products] = await Promise.all([
    BranchSettings.findOne({ branch: branchObjectId }).select('inventory').lean(),
    Product.find(productFilter)
      .select('productCode itemName aliasName brand category tileSize finish images unit inventoryBaseUom reorderLevel minStockLevel basicPrice purchaseRate landingCost')
      .populate('brand', 'name code').populate('category', 'name code').lean(),
  ]);
  const inventory = settings?.inventory || {};
  const productIds = products.map(product => product._id);
  const stockMatch = { branch: branchObjectId, product: { $in: productIds }, ...(warehouseRecord ? { warehouse: warehouseRecord._id } : {}) };
  const documentWarehouseMatch = warehouseRecord ? { warehouse: warehouseRecord._id } : {};
  const poWarehouseMatch = warehouseRecord ? { receivingWarehouse: warehouseRecord._id } : {};

  const [stockRows, lastMovements, supplierHistory, requisitions, purchaseOrders] = productIds.length ? await Promise.all([
    Stock.find(stockMatch).populate('warehouse', 'warehouseCode name type status city').lean(),
    StockMovement.aggregate([
      { $match: stockMatch },
      { $sort: { occurredAt: -1, _id: -1 } },
      { $group: { _id: '$product', occurredAt: { $first: '$occurredAt' }, movementType: { $first: '$movementType' }, sourceType: { $first: '$sourceType' }, sourceId: { $first: '$sourceId' }, sourceNumber: { $first: '$sourceNumber' } } },
    ]),
    GRN.aggregate([
      { $match: { branch: branchObjectId, status: 'posted' } },
      { $unwind: '$items' },
      { $match: { 'items.product': { $in: productIds }, ...(warehouseRecord ? { 'items.warehouse': warehouseRecord._id } : {}) } },
      { $sort: { postedAt: -1, grnDate: -1, _id: -1 } },
      { $group: { _id: '$items.product', history: { $push: { grn: '$_id', grnNumber: '$grnNumber', receivedAt: { $ifNull: ['$postedAt', '$grnDate'] }, supplier: '$supplier', supplierName: '$supplierName', rate: '$items.rate', warehouse: '$items.warehouse', acceptedQty: '$items.acceptedQty' } } } },
      { $project: { history: { $slice: ['$history', 5] } } },
    ]),
    PurchaseRequisition.find({ branch: branchObjectId, status: { $in: ['draft', 'submitted', 'approved'] }, 'items.product': { $in: productIds }, ...documentWarehouseMatch })
      .select('prNumber status warehouse warehouseName requestDate requiredByDate items').lean(),
    PurchaseOrder.find({ branch: branchObjectId, status: { $in: ['draft', 'submitted', 'pending_approval', 'approved', 'sent', 'partial_received'] }, 'items.product': { $in: productIds }, ...poWarehouseMatch })
      .select('poNumber status receivingWarehouse poDate expectedDeliveryDate supplier supplierName sourceRequisition items').lean(),
  ]) : [[], [], [], [], []];

  const stockMap = new Map();
  for (const row of stockRows) {
    const key = id(row.product);
    if (!stockMap.has(key)) stockMap.set(key, []);
    stockMap.get(key).push(row);
  }
  const movementMap = new Map(lastMovements.map(item => [id(item._id), item]));
  const historyMap = new Map(supplierHistory.map(item => [id(item._id), item.history || []]));
  const prMap = createCoverageMaps(requisitions, 'items', 'requiredQty');
  const poMap = createCoverageMaps(purchaseOrders, 'items', 'pendingQty');
  const snapshotAt = new Date();
  const minimumReorderQuantity = Math.max(1, number(inventory.minimumReorderQuantity) || DEFAULT_MINIMUM_REORDER_QUANTITY);

  let rows = products.map(product => {
    const key = id(product._id);
    const buckets = (stockMap.get(key) || []).map(stock => {
      const effectiveRate = number(stock.landingCost) > 0 ? number(stock.landingCost) : number(stock.purchaseRate);
      return {
        stockId: stock._id,
        warehouse: stock.warehouse || null,
        shade: stock.shade || '', batch: stock.batch || '',
        zone: stock.zone || '', rack: stock.rack || '', bin: stock.bin || '',
        quantities: Object.fromEntries(STOCK_BUCKET_FIELDS.map(field => [field, number(stock[field])])),
        valuation: { purchaseRate: number(stock.purchaseRate), landingCost: number(stock.landingCost), effectiveRate, totalValue: number(stock.totalQty) * effectiveRate, availableValue: number(stock.availableQty) * effectiveRate },
        lastGRNDate: stock.lastGRNDate || null,
        updatedAt: stock.updatedAt || null,
      };
    });
    const quantities = quantityShape();
    const warehouseGroups = new Map();
    let totalValue = 0; let availableValue = 0;
    for (const bucket of buckets) {
      addQuantities(quantities, bucket.quantities);
      totalValue += bucket.valuation.totalValue;
      availableValue += bucket.valuation.availableValue;
      const warehouseKey = id(bucket.warehouse);
      if (!warehouseGroups.has(warehouseKey)) warehouseGroups.set(warehouseKey, { warehouse: bucket.warehouse, quantities: quantityShape(), stockIds: [], buckets: [], valuation: { totalValue: 0, availableValue: 0 } });
      const group = warehouseGroups.get(warehouseKey);
      addQuantities(group.quantities, bucket.quantities);
      group.stockIds.push(bucket.stockId);
      group.buckets.push(bucket);
      group.valuation.totalValue += bucket.valuation.totalValue;
      group.valuation.availableValue += bucket.valuation.availableValue;
    }
    const policy = computeReorderPolicy(product, inventory);
    const warnings = [...policy.warnings];
    if (quantities.availableQty < 0) warnings.push('negative_available_stock');
    const severity = classifyStockAlert(quantities.availableQty, policy);
    const openPrEntries = prMap.get(key) || [];
    const openPoEntries = poMap.get(key) || [];
    const openRequisitions = openPrEntries.map(({ document, item, quantity }) => ({ _id: document._id, prNumber: document.prNumber, status: document.status, warehouse: document.warehouse, warehouseName: document.warehouseName, requiredQty: quantity, requestDate: document.requestDate, requiredByDate: document.requiredByDate, itemId: item._id }));
    const openPurchaseOrders = openPoEntries.map(({ document, item, quantity }) => ({ _id: document._id, poNumber: document.poNumber, status: document.status, warehouse: document.receivingWarehouse, supplier: document.supplier, supplierName: document.supplierName, pendingQty: quantity, poDate: document.poDate, expectedDeliveryDate: document.expectedDeliveryDate, sourceRequisition: document.sourceRequisition, itemId: item._id }));
    const firmPoQty = openPurchaseOrders.filter(item => ['approved', 'sent', 'partial_received'].includes(item.status)).reduce((sum, item) => sum + item.pendingQty, 0);
    const openPrQty = openRequisitions.reduce((sum, item) => sum + item.requiredQty, 0);
    const deficit = Math.max(0, policy.effectiveReorderLevel - quantities.availableQty);
    const suggestedQuantity = Math.max(0, policy.effectiveReorderLevel * 2 - quantities.availableQty, minimumReorderQuantity);
    const supplierHistoryRows = historyMap.get(key) || [];
    const lastReceipt = supplierHistoryRows[0] || null;
    const fallbackRate = number(product.landingCost) || number(product.purchaseRate) || number(product.basicPrice);
    const effectiveRate = quantities.totalQty ? totalValue / quantities.totalQty : number(lastReceipt?.rate) || fallbackRate;
    const lastMovement = movementMap.get(key) || null;
    return {
      product: product._id,
      productCode: product.productCode || '', productName: product.itemName,
      productImage: product.images?.[0] || '', brand: product.brand || null, category: product.category || null,
      tileSize: product.tileSize || '', finish: product.finish || '', unit: product.inventoryBaseUom || product.unit || 'Unit',
      stockScope: warehouseRecord ? 'warehouse' : 'branch', warehouse: warehouseRecord,
      quantities, stockIds: buckets.map(bucket => bucket.stockId), buckets,
      warehouseBreakdown: [...warehouseGroups.values()],
      thresholds: policy, reorderLevelSource: policy.reorderSource,
      severity, deficit, suggestedQuantity,
      netSuggestedQuantity: Math.max(0, suggestedQuantity - openPrQty - firmPoQty),
      valuation: { effectiveRate, totalValue, availableValue, suggestedValue: suggestedQuantity * effectiveRate },
      lastGRNAt: buckets.reduce((latest, bucket) => !latest || (bucket.lastGRNDate && new Date(bucket.lastGRNDate) > new Date(latest)) ? bucket.lastGRNDate : latest, null) || lastReceipt?.receivedAt || null,
      lastMovementAt: lastMovement?.occurredAt || null, lastMovement,
      lastReceipt, supplierHistory: supplierHistoryRows,
      openRequisitions, openPurchaseOrders, hasOpenRequisition: openRequisitions.length > 0,
      procurement: { openPrQty, firmPoQty, openPrCount: openRequisitions.length, openPoCount: openPurchaseOrders.length },
      configurationWarnings: warnings,
      snapshotAt,
    };
  });

  if (filters.reorderSource) rows = rows.filter(row => row.thresholds.reorderSource === filters.reorderSource);
  if (filters.hasOpenRequisition !== undefined) rows = rows.filter(row => row.hasOpenRequisition === filters.hasOpenRequisition);

  const warningCounts = {};
  const summary = {
    totalProducts: rows.length,
    outOfStock: rows.filter(row => row.severity === 'out_of_stock').length,
    critical: rows.filter(row => row.severity === 'critical').length,
    lowStock: rows.filter(row => row.severity === 'low_stock').length,
    adequate: rows.filter(row => row.severity === 'adequate').length,
    totalDeficit: rows.reduce((sum, row) => sum + row.deficit, 0),
    totalValue: rows.reduce((sum, row) => sum + row.valuation.totalValue, 0),
    availableValue: rows.reduce((sum, row) => sum + row.valuation.availableValue, 0),
    openReorderCount: rows.filter(row => row.hasOpenRequisition).length,
    configurationWarnings: { products: rows.filter(row => row.configurationWarnings.length).length, total: 0, byCode: warningCounts },
  };
  for (const row of rows) for (const warning of row.configurationWarnings) warningCounts[warning] = (warningCounts[warning] || 0) + 1;
  summary.configurationWarnings.total = Object.values(warningCounts).reduce((sum, count) => sum + count, 0);

  const requestedSeverities = filters.severity.length ? filters.severity : (filters.includeAdequate ? SEVERITIES : SEVERITIES.filter(value => value !== 'adequate'));
  rows = rows.filter(row => requestedSeverities.includes(row.severity));
  rows.sort(compareRows(filters.sortBy, filters.sortOrder === 'desc' ? -1 : 1));
  const totalItems = rows.length;
  const pageRows = options.internalAll ? rows : rows.slice((filters.page - 1) * filters.limit, filters.page * filters.limit);

  return {
    data: pageRows,
    pagination: { currentPage: filters.page, totalPages: options.internalAll ? 1 : Math.ceil(totalItems / filters.limit), totalItems, itemsPerPage: options.internalAll ? totalItems : filters.limit },
    summary,
    scope: {
      branch: branchObjectId, warehouse: warehouseRecord, stockScope: warehouseRecord ? 'warehouse' : 'branch', snapshotAt,
      fallbackReorderLevel: Math.max(1, number(inventory.reorderFallbackLevel) || DEFAULT_REORDER_FALLBACK),
      fallbackMinStockLevel: inventory.minStockFallbackLevel === undefined || inventory.minStockFallbackLevel === null
        ? DEFAULT_MINIMUM_FALLBACK
        : Math.max(0, number(inventory.minStockFallbackLevel)),
      minimumReorderQuantity,
    },
    appliedFilters: { ...filters, warehouse: warehouseRecord?._id || null },
  };
};

export const STOCK_ALERT_SEVERITIES = SEVERITIES;
