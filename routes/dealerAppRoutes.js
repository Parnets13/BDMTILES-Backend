import { Router } from 'express';
import mongoose from 'mongoose';
import Dealer from '../models/Dealer.js';
import Product from '../models/Product.js';
import Stock from '../models/Stock.js';
import Invoice from '../models/Invoice.js';
import DealerLedger from '../models/DealerLedger.js';
import SalesOrder from '../models/SalesOrder.js';
import Quotation from '../models/Quotation.js';
import DealerOrderRequest from '../models/DealerOrderRequest.js';
import DealerScheme from '../models/DealerScheme.js';
import Delivery from '../models/Delivery.js';
// Picking and loading happen UPSTREAM of a Delivery — the row is not created until the
// pick list is `loaded` — so the dealer-facing stage needs both of these to say anything
// about an order before it is on a vehicle.
import PickList from '../models/PickList.js';
import DispatchTrip from '../models/DispatchTrip.js';
import {resolveStage, stageLabel} from '../utils/deliveryStage.js';
import {findDealerPickLists, stagesByOrder, findDealerPickListDetail} from '../services/dealerFulfilmentService.js';
import Payment from '../models/Payment.js';
import SalesReturn from '../models/SalesReturn.js';
import Gift from '../models/Gift.js';
import GiftClaim from '../models/GiftClaim.js';
import DealerPointsLedger from '../models/DealerPointsLedger.js';
import DealerMessage from '../models/DealerMessage.js';
import Complaint from '../models/Complaint.js';
import ComplaintEvidence from '../models/ComplaintEvidence.js';
import PaymentIntimation from '../models/PaymentIntimation.js';
import User from '../models/User.js';
import { protectDealer } from '../middleware/dealerAuth.js';
import { requireDealerPermission } from '../middleware/dealerPermission.js';
import { dealerOrderScope, dealerPrincipalHasPermission } from '../config/dealerPermissions.js';
import { uploadComplaintEvidence } from '../middleware/upload.js';
import { generateUniqueCode } from '../utils/codeGenerator.js';
import { generateDownloadToken } from '../utils/jwt.js';
import { getDealerCreditExposure } from '../services/dealerCreditService.js';
import { resolveDealerBranch } from '../services/dealerAssignmentService.js';
import { resolvePricing } from '../services/pricingResolver.js';
import { buildTrustedRequestItems, orderRequestFingerprint, buildStatusCounts, resolveStatusGroup, statusFilterForGroup } from '../services/dealerOrderRequestService.js';
import { recordDealerResponse, shortfallDto } from '../services/dealerOrderShortfallService.js';
import { requestFingerprint } from '../utils/idempotency.js';
import { generateBranchNumber } from '../utils/branchSequence.js';

const router = Router();
router.use(protectDealer);

/**
 * Whether the calling principal holds `permission`.
 *
 * The dealer account owner always does. An employee does only when the dealer
 * granted it — and `req.dealerPrincipal.permissions` has already had sensitive
 * finance ids stripped when BDMTILES disabled finance delegation for this dealer,
 * so that policy is honoured here for free.
 */
const canSee = (req, permission) => dealerPrincipalHasPermission(req.dealerPrincipal, permission);

/** Finance call sites read better under their own name. Same check. */
const canSeeFinance = canSee;

/** True when the caller may see nothing at all from the finance block. */
const isFinanceBlind = (req) =>
  !canSeeFinance(req, 'finance.creditLimit') && !canSeeFinance(req, 'finance.outstanding');

/**
 * Which slice of orders the caller may see. The decision itself lives in
 * config/dealerPermissions.js as a pure function so it can be asserted in the
 * validator; this only adapts the request to it.
 *
 * Resolved server-side rather than trusting a filter from the app, so a crafted
 * request cannot widen the view past what was granted. This is what makes the
 * app's "My Requests" tab tell the truth: it used to return the whole dealer's
 * book under a "My" label.
 */
const resolveOrderScope = (req) => dealerOrderScope({
  principal: req.dealerPrincipal,
  employeeId: req.dealerEmployee?._id || null,
  requested: req.query.scope,
});

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * What the dealer saves against MRP, worked out once on the server so the list, the
 * detail screen and the related-products strip can never disagree with each other.
 *
 * Returns nulls rather than zeros when there is nothing honest to show: no MRP on the
 * product, no resolved rate, or a rate at or above MRP. A struck-through price has to
 * mean something, and "0% off" or a negative discount would be worse than silence.
 */
const mrpSaving = (mrp, rate) => {
  const listPrice = money(mrp);
  const yourPrice = rate === null || rate === undefined ? null : money(rate);
  if (!(listPrice > 0) || yourPrice === null || !(yourPrice < listPrice)) {
    return { mrp: listPrice > 0 ? listPrice : null, discountPercent: null, savingPerUnit: null };
  }
  return {
    mrp: listPrice,
    // Whole numbers only: "78% off" is the claim, not 78.34%.
    discountPercent: Math.round(((listPrice - yourPrice) / listPrice) * 100),
    savingPerUnit: money(listPrice - yourPrice),
  };
};

/**
 * Remove the catalogue fields the caller was not granted.
 *
 * `catalogue.priceView` and `catalogue.stockView` are separate grants, so the rate
 * block and the quantity are removed independently — a dealer can let an employee
 * see what is in stock without letting them see what it costs. Until this existed
 * both permissions were stored but read by nothing, so unticking "Price View"
 * changed nothing and the employee still saw rates.
 *
 * Keys are DELETED rather than set to null: `dealerRate: null` still tells the app
 * that a rate exists and renders as "free", which is worse than the field being
 * absent. A missing field is the honest signal, and the app hides the control.
 */
const shapeCatalogueItem = (item, { showPrice, showStock }) => {
  const shaped = { ...item };
  if (!showPrice) {
    delete shaped.dealerRate;
    delete shaped.mrp;
    delete shaped.discountPercent;
    delete shaped.savingPerUnit;
    delete shaped.pricing;
  }
  if (!showStock) delete shaped.availableQty;
  return shaped;
};
const appError = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, error) => res
  .status(error.status || 500)
  .json({ success: false, message: error.message || 'Something went wrong.' });

// A dealer's operating branch is derived from their assigned sales executive's
// default branch. Order requests, invoices and ledger are all keyed on it.
// Which active schemes this dealer qualifies for (all / named / by category / by type).
function schemeEligibilityFilter(dealer, branch, now = new Date()) {
  const orClauses = [
    { applicableTo: 'all' },
    { applicableTo: 'specific_dealers', dealers: dealer._id },
  ];
  if (dealer.dealerCategory) {
    orClauses.push({ applicableTo: 'dealer_category', dealerCategory: dealer.dealerCategory });
  }
  const dealerTypeId = dealer.dealerType?._id || dealer.dealerType;
  if (dealerTypeId) orClauses.push({ applicableTo: 'dealer_type', dealerType: dealerTypeId });

  const filter = {
    status: 'active',
    startDate: { $lte: now },
    endDate: { $gte: now },
    $or: orClauses,
  };
  if (branch) filter.branch = branch;
  return filter;
}

// Split open invoices into standard receivable ageing buckets by due date.
function buildAgeing(openInvoices, now = new Date()) {
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const inv of openInvoices) {
    const balance = Number(inv.balanceAmount || 0);
    if (balance <= 0) continue;
    const due = inv.dueDate ? new Date(inv.dueDate) : null;
    if (!due || due >= now) {
      buckets.current += balance;
      continue;
    }
    const days = Math.floor((now - due) / 86400000);
    if (days <= 30) buckets.d1_30 += balance;
    else if (days <= 60) buckets.d31_60 += balance;
    else if (days <= 90) buckets.d61_90 += balance;
    else buckets.d90plus += balance;
  }
  return {
    current: money(buckets.current),
    d1_30: money(buckets.d1_30),
    d31_60: money(buckets.d31_60),
    d61_90: money(buckets.d61_90),
    d90plus: money(buckets.d90plus),
  };
}

// ── Dashboard ────────────────────────────────────────────────────────────────
// GET /api/v1/dealer-app/dashboard
router.get('/dashboard', requireDealerPermission('dashboard.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // An employee without a finance grant must not have the ledger or the invoice
    // list loaded at all — redacting after the query would still put the numbers
    // in memory and one careless response away from leaking them.
    const showCreditLimit = canSeeFinance(req, 'finance.creditLimit');
    const showOutstanding = canSeeFinance(req, 'finance.outstanding');
    const showPayments = dealerPrincipalHasPermission(req.dealerPrincipal, 'payments.view');
    const financeBlind = !showCreditLimit && !showOutstanding;

    // The same scope rule the Orders screen uses, so the Dashboard boxes and the
    // Orders boxes can never show different numbers.
    const { filter: orderScope, scope: orderScopeLabel } = resolveOrderScope(req);

    const invoiceScope = { dealer: dealer._id, status: { $ne: 'cancelled' } };
    const [
      ledgerAgg,
      openInvoices,
      monthOrdersAgg,
      recentOrders,
      pendingOrderCount,
      inTransitCount,
      lastPayment,
      activeSchemeCount,
      newArrivalCount,
      requestStatusRows,
    ] = await Promise.all([
      financeBlind ? Promise.resolve([]) : DealerLedger.aggregate([
        { $match: { dealer: new mongoose.Types.ObjectId(String(dealer._id)) } },
        { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ]),
      financeBlind ? Promise.resolve([]) : Invoice.find({ ...invoiceScope, balanceAmount: { $gt: 0 } })
        .select('invoiceNumber invoiceDate dueDate grandTotal balanceAmount paymentStatus')
        .sort({ dueDate: 1, invoiceDate: 1 }).limit(500).lean(),
      SalesOrder.aggregate([
        { $match: { dealer: new mongoose.Types.ObjectId(String(dealer._id)), orderDate: { $gte: monthStart }, status: { $nin: ['draft', 'cancelled'] } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
      ]),
      SalesOrder.find({ dealer: dealer._id, status: { $nin: ['draft'] } })
        .select('orderNumber orderDate grandTotal status items')
        .sort({ orderDate: -1 }).limit(5).lean(),
      SalesOrder.countDocuments({ dealer: dealer._id, status: { $in: ['confirmed', 'processing', 'partially_dispatched'] } }),
      Delivery.countDocuments({ dealer: dealer._id, status: { $in: ['assigned', 'in_transit', 'reached'] } }),
      showPayments
        ? Payment.findOne({ dealer: dealer._id, paymentType: 'dealer_receipt', status: 'confirmed' })
          .select('paymentNumber paymentDate amount paymentMode').sort({ paymentDate: -1 }).lean()
        : Promise.resolve(null),
      DealerScheme.countDocuments(schemeEligibilityFilter(dealer, branch, now)),
      Product.countDocuments({
        status: 'active',
        dealerVisible: { $ne: false },
        createdAt: { $gte: new Date(now.getTime() - 30 * 86400000) },
      }),
      // The dealer's own request boxes. Scoped exactly like the Orders screen, so
      // an employee sees their own counts and the two screens can never disagree.
      DealerOrderRequest.aggregate([
        { $match: { dealer: dealer._id, ...orderScope } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const requestCounts = buildStatusCounts(requestStatusRows);

    const outstanding = money((ledgerAgg[0]?.debit || 0) - (ledgerAgg[0]?.credit || 0));
    const creditLimit = money(dealer.creditLimit || 0);
    const usedCredit = Math.max(0, outstanding);
    const availableCredit = money(Math.max(0, creditLimit - usedCredit));
    const utilization = creditLimit > 0 ? Math.min(100, Math.round((usedCredit / creditLimit) * 100)) : 0;

    const overdue = openInvoices.filter(inv => inv.dueDate && new Date(inv.dueDate) < now);

    res.json({
      success: true,
      data: {
        dealer: {
          businessName: dealer.businessName,
          dealerCode: dealer.dealerCode,
          dealerType: dealer.dealerType?.name || null,
        },
        // Finance is omitted rather than zeroed when the employee has no grant: a
        // zeroed credit limit reads as "you have no credit", which is a different
        // and misleading statement. `creditHidden` lets the app explain why the
        // section is missing instead of rendering blanks.
        ...(showCreditLimit || showOutstanding
          ? {
            credit: {
              creditLimit: showCreditLimit ? creditLimit : null,
              creditDays: showCreditLimit ? (dealer.creditDays || 0) : null,
              outstanding: showOutstanding ? outstanding : null,
              usedCredit: showOutstanding ? usedCredit : null,
              availableCredit: showOutstanding ? availableCredit : null,
              utilization: showOutstanding ? utilization : null,
            },
          }
          : { creditHidden: true }),
        ...(showOutstanding
          ? {
            invoices: {
              openCount: openInvoices.length,
              overdueCount: overdue.length,
              overdueAmount: money(overdue.reduce((s, i) => s + Number(i.balanceAmount || 0), 0)),
            },
            ageing: buildAgeing(openInvoices, now),
          }
          : { invoicesHidden: true }),
        orders: {
          pending: pendingOrderCount,
          inTransit: inTransitCount,
        },
        // Request boxes, identical in shape to what GET /order-requests returns so
        // the app can render the same component on both screens.
        requestCounts,
        requestScope: orderScopeLabel,
        lastPayment: lastPayment
          ? {
            paymentNumber: lastPayment.paymentNumber,
            paymentDate: lastPayment.paymentDate,
            amount: money(lastPayment.amount || 0),
            paymentMode: lastPayment.paymentMode || '',
          }
          : null,
        schemes: { activeCount: activeSchemeCount },
        newArrivals: { count: newArrivalCount },
        monthOrders: {
          total: money(monthOrdersAgg[0]?.total || 0),
          count: monthOrdersAgg[0]?.count || 0,
        },
        recentOrders: recentOrders.map(o => ({
          orderNumber: o.orderNumber,
          orderDate: o.orderDate,
          grandTotal: money(o.grandTotal || 0),
          status: o.status,
          itemSummary: (o.items || [])[0]?.productName
            ? `${(o.items || [])[0].productName}${(o.items || []).length > 1 ? ` +${o.items.length - 1} more` : ''}`
            : `${(o.items || []).length} item(s)`,
        })),
        salesExecutive: dealer.assignedSalesExecutive
          ? { name: dealer.assignedSalesExecutive.name, phone: dealer.assignedSalesExecutive.phone }
          : null,
        branchResolved: Boolean(branch),
      },
    });
  } catch (error) { sendError(res, error); }
});

// ── Catalogue with dealer-specific rate ──────────────────────────────────────
// GET /api/v1/dealer-app/catalogue?search=&brand=&category=&page=&limit=
router.get('/catalogue', requireDealerPermission('catalogue.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const {
      page = 1, limit = 20, search, brand, category, subcategory,
      size, finish, colour, application,
    } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const filter = { status: 'active', dealerVisible: { $ne: false } };
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ itemName: regex }, { productCode: regex }, { colour: regex }, { design: regex }];
    }
    if (mongoose.isValidObjectId(brand)) filter.brand = brand;
    if (mongoose.isValidObjectId(category)) filter.category = category;
    if (mongoose.isValidObjectId(subcategory)) filter.subcategory = subcategory;
    // 17.3 attribute filters — matched server-side so paging stays correct.
    if (size) filter.tileSize = String(size);
    if (finish) filter.finish = String(finish);
    if (colour) filter.colour = String(colour);
    if (application) filter.applicationArea = String(application);

    const [products, total] = await Promise.all([
      Product.find(filter).sort({ itemName: 1 }).skip((p - 1) * l).limit(l)
        .populate('brand', 'name').populate('category', 'name').lean(),
      Product.countDocuments(filter),
    ]);

    // Branch-scoped available stock per product.
    const productIds = products.map(prod => prod._id);
    const stockRows = (branch && productIds.length) ? await Stock.aggregate([
      { $match: { branch: new mongoose.Types.ObjectId(String(branch)), product: { $in: productIds } } },
      { $group: { _id: '$product', availableQty: { $sum: '$availableQty' } } },
    ]) : [];
    const stockByProduct = new Map(stockRows.map(r => [String(r._id), r.availableQty]));

    // Two independent grants, applied to every row below.
    const showPrice = canSee(req, 'catalogue.priceView');
    const showStock = canSee(req, 'catalogue.stockView');

    const data = await Promise.all(products.map(async (product) => {
      let rate = null;
      try {
        if (branch) {
          const priced = await resolvePricing({
            branchId: branch, dealerId: dealer._id, product, quantity: 1, pricingDate: new Date(),
          });
          // For catalogue: show pricingRate (base + dealer pricing override, but NOT discount mapping)
          // Discount mapping is only applied in cart
          rate = { 
            catalogueRate: money(priced.pricingRate),  // Base rate before discount mapping
            effectiveRate: money(priced.effectiveRate), // Full discounted rate (for cart)
            baseRate: money(priced.baseRate), 
            rateField: priced.rateField 
          };
        }
      } catch { /* pricing is best-effort in the catalogue list */ }
      return shapeCatalogueItem({
        _id: product._id,
        productCode: product.productCode,
        itemName: product.itemName,
        brand: product.brand?.name || '',
        category: product.category?.name || '',
        tileSize: product.tileSize || '',
        finish: product.finish || '',
        colour: product.colour || '',
        unit: product.unit || 'Box',
        piecesPerBox: product.piecesPerBox || 0,
        sqftPerBox: product.sqftPerBox || 0,
        image: product.images?.[0] || '',
        dealerRate: rate?.catalogueRate ?? null,  // Show pricingRate in catalogue, NOT effectiveRate
        effectiveRate: rate?.effectiveRate ?? null,  // For cart calculations (with discount mapping)
        ...mrpSaving(product.mrp, rate?.catalogueRate ?? null),
        availableQty: Number(stockByProduct.get(String(product._id)) || 0),
      }, { showPrice, showStock });
    }));

    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/catalogue/filter-options — brands / categories / sizes
// Must be declared BEFORE /catalogue/:id so it isn't captured as an :id.
router.get('/catalogue/filter-options', requireDealerPermission('catalogue.view'), async (req, res) => {
  try {
    const match = { status: 'active', dealerVisible: { $ne: false } };
    const [brands, categories, sizes, finishes, colours, applications] = await Promise.all([
      Product.aggregate([
        { $match: match },
        { $group: { _id: '$brand' } },
        { $lookup: { from: 'brands', localField: '_id', foreignField: '_id', as: 'brand' } },
        { $unwind: { path: '$brand', preserveNullAndEmptyArrays: false } },
        { $project: { _id: '$brand._id', name: '$brand.name' } },
        { $sort: { name: 1 } },
      ]),
      Product.aggregate([
        { $match: match },
        { $group: { _id: '$category' } },
        { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
        { $unwind: { path: '$category', preserveNullAndEmptyArrays: false } },
        { $project: { _id: '$category._id', name: '$category.name' } },
        { $sort: { name: 1 } },
      ]),
      Product.distinct('tileSize', { ...match, tileSize: { $nin: [null, ''] } }),
      Product.distinct('finish', { ...match, finish: { $nin: [null, ''] } }),
      Product.distinct('colour', { ...match, colour: { $nin: [null, ''] } }),
      Product.distinct('applicationArea', { ...match, applicationArea: { $nin: [null, ''] } }),
    ]);
    const clean = (values) => values.filter(Boolean).map(String).sort((a, b) => a.localeCompare(b));
    res.json({
      success: true,
      data: {
        brands: brands.map(b => ({ id: String(b._id), name: b.name })),
        categories: categories.map(c => ({ id: String(c._id), name: c.name })),
        sizes: clean(sizes),
        finishes: clean(finishes),
        colours: clean(colours),
        applications: clean(applications),
      },
    });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/catalogue/:id — full detail with dealer rate
router.get('/catalogue/:id', requireDealerPermission('catalogue.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const product = await Product.findOne({ _id: req.params.id, status: 'active' })
      .populate('brand', 'name').populate('category', 'name').populate('subcategory', 'name').lean();
    if (!product) throw appError(404, 'Product not found.');

    // Two independent grants — see shapeCatalogueItem.
    const showPrice = canSee(req, 'catalogue.priceView');
    const showStock = canSee(req, 'catalogue.stockView');

    let pricing = null;
    let availableQty = 0;
    if (branch) {
      try {
        const priced = await resolvePricing({ branchId: branch, dealerId: dealer._id, product, quantity: 1, pricingDate: new Date() });
        // For catalogue detail: show pricingRate (before discount mapping)
        // Discount mapping only applies in cart
        const catalogueRate = money(priced.pricingRate);
        pricing = {
          dealerRate: catalogueRate,  // For backward compatibility with app
          catalogueRate,  // Show this rate in product detail
          effectiveRate: money(priced.effectiveRate), // Full discounted rate (for cart reference)
          baseRate: money(priced.baseRate),
          rateField: priced.rateField,
          ...mrpSaving(product.mrp, priced.pricingRate), // Calculate MRP saving against pricingRate
        };
      } catch { /* ignore */ }
      const stockRows = await Stock.aggregate([
        { $match: { branch: new mongoose.Types.ObjectId(String(branch)), product: new mongoose.Types.ObjectId(String(product._id)) } },
        { $group: { _id: null, availableQty: { $sum: '$availableQty' } } },
      ]);
      availableQty = Number(stockRows[0]?.availableQty || 0);
    }

    res.json({
      success: true,
      data: shapeCatalogueItem({
        _id: product._id,
        productCode: product.productCode,
        itemName: product.itemName,
        description: product.description || '',
        brand: product.brand?.name || '',
        category: product.category?.name || '',
        subcategory: product.subcategory?.name || '',
        tileSize: product.tileSize || '',
        thickness: product.thickness || '',
        finish: product.finish || '',
        surface: product.surface || '',
        colour: product.colour || '',
        hsnCode: product.hsnCode || '',
        gstPercentage: product.gstPercentage || 0,
        unit: product.unit || 'Box',
        piecesPerBox: product.piecesPerBox || 0,
        sqftPerBox: product.sqftPerBox || 0,
        weightPerBox: product.weightPerBox || 0,
        images: product.images || [],
        videos: product.videos || [],
        images360: product.images360 || [],
        pricing,
        availableQty,
      }, { showPrice, showStock }),
    });
  } catch (error) { sendError(res, error); }
});

// ── Dealer Order Requests (dealer-initiated) ─────────────────────────────────
// POST /api/v1/dealer-app/order-requests   { items:[{ product, quantity|boxes }], remarks }
router.post('/order-requests', requireDealerPermission('orders.order'), async (req, res) => {
  try {
    const dealer = req.dealer;
    if (!dealer.assignedSalesExecutive?._id && !dealer.assignedSalesExecutive) {
      throw appError(409, 'No sales executive is assigned to your account yet. Please contact BDMTILES.');
    }
    const branch = await resolveDealerBranch(dealer);
    if (!branch) throw appError(409, 'Your account is not linked to a branch yet. Please contact BDMTILES.');

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = await buildTrustedRequestItems(
      rawItems.map(it => ({ product: it.product, quantity: it.quantity ?? it.boxes })),
    );
    const seId = dealer.assignedSalesExecutive?._id || dealer.assignedSalesExecutive;
    const se = await User.findById(seId).select('name').lean();
    const fingerprint = orderRequestFingerprint(dealer._id, items);
    // Idempotency: the app sends a stable key per submission attempt, so a retry
    // or a double tap replays the original request instead of raising a duplicate.
    // Falling back to the cart fingerprint (never a timestamp) keeps older app
    // builds safe too — resubmitting the same cart returns the same request.
    const clientKey = String(req.get('Idempotency-Key') || '').trim().slice(0, 200);
    const sourceKey = `dealer-app:${dealer._id}:${clientKey || fingerprint}`;
    const replay = await DealerOrderRequest.findOne({ sourceKey }).lean();
    if (replay) {
      return res.status(200).json({
        success: true,
        idempotent: true,
        message: 'This request was already submitted.',
        data: replay,
      });
    }
    const requestNumber = await generateBranchNumber(branch, 'dealerOrderRequest', new Date());

    const [created] = await DealerOrderRequest.create([{
      requestNumber,
      branch,
      dealer: dealer._id,
      dealerSnapshot: {
        businessName: dealer.businessName, dealerCode: dealer.dealerCode || '',
        ownerName: dealer.ownerName || '', mobile: dealer.mobile || '',
        address: dealer.address || '', city: dealer.city || '',
      },
      salesExecutive: seId,
      salesExecutiveName: se?.name || '',
      items,
      remarks: String(req.body?.remarks || ''),
      deliveryAddress: String(req.body?.deliveryAddress || '').slice(0, 500),
      expectedDeliveryDate: req.body?.expectedDeliveryDate
        ? new Date(req.body.expectedDeliveryDate)
        : null,
      status: 'submitted',
      submittedAt: new Date(),
      sourceKey,
      requestFingerprint: fingerprint,
      createdBy: seId, // dealer-initiated; SE owns the follow-up
      // Recorded at submission so dealer-employee targets have a stable basis.
      // Null when the dealer owner raised it themselves.
      createdByEmployee: req.dealerEmployee?._id || null,
    }]);

    res.status(201).json({ success: true, message: 'Your order request was submitted. Your sales executive will review it.', data: created });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/order-requests/credit-check?amount=
// SOW 17.4 "Credit limit validation / Outstanding validation".
//
// Deliberately ADVISORY, not blocking: an order request is reviewed by the sales
// executive before it becomes a quotation, and an executive with authority may
// legitimately approve an over-limit order. Hard-blocking here would stop real
// business at the wrong point. The dealer sees the position, the executive
// decides. Declared before /order-requests/:id so it isn't read as an id.
router.get('/order-requests/credit-check', requireDealerPermission('orders.create'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const cartAmount = money(Math.max(0, Number(req.query.amount) || 0));

    // The credit position is finance data. An employee without a finance grant
    // gets no numbers at all — the request is still submitted for approval, so
    // the app simply skips the advisory banner rather than showing a blank one.
    const showCreditLimit = canSeeFinance(req, 'finance.creditLimit');
    const showOutstanding = canSeeFinance(req, 'finance.outstanding');
    if (!showCreditLimit && !showOutstanding) {
      return res.json({
        success: true,
        data: { financeHidden: true, cartAmount, blocking: false, warnings: [] },
      });
    }

    const [ledgerAgg, exposure] = await Promise.all([
      showOutstanding
        ? DealerLedger.aggregate([
          { $match: { dealer: new mongoose.Types.ObjectId(String(dealer._id)) } },
          { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
        ])
        : Promise.resolve([]),
      showOutstanding && branch
        ? getDealerCreditExposure({ branchId: branch, dealer }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const outstanding = money((ledgerAgg[0]?.debit || 0) - (ledgerAgg[0]?.credit || 0));
    const creditLimit = money(dealer.creditLimit || 0);
    const availableCredit = money(Math.max(0, creditLimit - Math.max(0, outstanding)));
    const projected = money(Math.max(0, outstanding) + cartAmount);
    const overBy = money(Math.max(0, projected - creditLimit));

    const warnings = [];
    // A limit warning needs BOTH halves — the limit and the balance it is measured
    // against — so it is only emitted when the caller may see both.
    if (showCreditLimit && showOutstanding) {
      if (creditLimit > 0 && overBy > 0) {
        warnings.push({
          code: 'credit_limit',
          severity: 'warning',
          message: `This request would take your balance to ${projected.toLocaleString('en-IN')}, which is ${overBy.toLocaleString('en-IN')} over your ${creditLimit.toLocaleString('en-IN')} limit. Your sales executive will need to approve it.`,
        });
      }
      if (exposure?.overdueAmount > 0) {
        warnings.push({
          code: 'overdue',
          severity: 'warning',
          message: `You have ${exposure.overdueAmount.toLocaleString('en-IN')} overdue across ${exposure.overdueCount} bill(s). Clearing this may speed up approval.`,
        });
      }
    }

    res.json({
      success: true,
      data: {
        // Nulled per permission rather than omitted, so the app can tell "you may
        // not see this" apart from "this is zero".
        creditLimit: showCreditLimit ? creditLimit : null,
        creditDays: showCreditLimit ? (dealer.creditDays || 0) : null,
        outstanding: showOutstanding ? outstanding : null,
        availableCredit: showOutstanding ? availableCredit : null,
        cartAmount,
        projectedOutstanding: showOutstanding ? projected : null,
        overLimitBy: showCreditLimit && showOutstanding ? overBy : null,
        overdueAmount: showOutstanding ? money(exposure?.overdueAmount || 0) : null,
        overdueCount: showOutstanding ? (exposure?.overdueCount || 0) : null,
        // Requests are never blocked client-side; this is guidance only.
        blocking: false,
        warnings,
      },
    });
  } catch (error) { sendError(res, error); }
});

// A request only tells half the story on its own: the dealer wants to know what it
// became. Resolve every quotation and sales order in its lineage so the app can
// show one continuous progress line instead of stopping at "converted to a
// quotation".
//
// A stock split means one request can produce more than one order, and the order
// belongs to the split's available child rather than to the quotation the request
// is linked to. So the lineage is read from the request's own `outcomes` list,
// with the old lookup by sourceQuotation kept as a fallback for requests that were
// linked before any of this existed.
async function attachRequestOutcomes(requests, dealerId) {
  const quotationIds = [...new Set(requests.flatMap(request => [
    request.sourceQuotation,
    request.availableQuotation,
    request.pendingStockQuotation,
    ...(request.outcomes || []).map(outcome => outcome.quotation),
  ]).filter(Boolean).map(String))];
  const orderIds = [...new Set(requests.flatMap(request => [
    request.sourceSalesOrder,
    ...(request.outcomes || []).map(outcome => outcome.salesOrder),
  ]).filter(Boolean).map(String))];

  const bare = request => ({
    ...request,
    shortfall: shortfallDto(request),
    shortfallRounds: undefined,
    quotation: null,
    availableQuotation: null,
    pendingStockQuotation: null,
    salesOrder: null,
    salesOrders: [],
  });
  if (!quotationIds.length && !orderIds.length) return requests.map(bare);

  const [quotations, ordersById, legacyOrders] = await Promise.all([
    quotationIds.length
      ? Quotation.find({ _id: { $in: quotationIds } })
        .select('quotationNumber status grandTotal validUntil quotationDate splitRole holdExpiresAt').lean()
      : [],
    orderIds.length
      ? SalesOrder.find({ _id: { $in: orderIds }, dealer: dealerId })
        .select('orderNumber status paymentStatus grandTotal orderDate sourceQuotation').lean()
      : [],
    // Requests processed before `outcomes` existed only know their quotation.
    quotationIds.length
      ? SalesOrder.find({ dealer: dealerId, sourceQuotation: { $in: quotationIds } })
        .select('orderNumber status paymentStatus grandTotal orderDate sourceQuotation').lean()
      : [],
  ]);

  const quotationById = new Map(quotations.map(entry => [String(entry._id), entry]));
  const orderById = new Map([...legacyOrders, ...ordersById].map(entry => [String(entry._id), entry]));
  const ordersByQuotation = new Map();
  for (const order of [...ordersById, ...legacyOrders]) {
    const key = String(order.sourceQuotation || '');
    if (!key || ordersByQuotation.has(key)) continue;
    ordersByQuotation.set(key, order);
  }

  const quotationDto = (id) => {
    const entry = id ? quotationById.get(String(id)) : null;
    return entry ? {
      _id: entry._id,
      quotationNumber: entry.quotationNumber,
      status: entry.status,
      splitRole: entry.splitRole || 'none',
      grandTotal: money(entry.grandTotal),
      validUntil: entry.validUntil,
      quotationDate: entry.quotationDate,
      holdExpiresAt: entry.holdExpiresAt || null,
    } : null;
  };
  const orderDto = (entry) => entry ? {
    _id: entry._id,
    orderNumber: entry.orderNumber,
    status: entry.status,
    paymentStatus: entry.paymentStatus,
    grandTotal: money(entry.grandTotal),
    orderDate: entry.orderDate,
  } : null;

  return requests.map((request) => {
    const fromOutcomes = (request.outcomes || [])
      .map(outcome => ({
        kind: outcome.kind,
        at: outcome.at,
        quotation: quotationDto(outcome.quotation),
        salesOrder: orderDto(orderById.get(String(outcome.salesOrder || ''))),
      }))
      .filter(entry => entry.salesOrder || entry.quotation);
    const salesOrders = fromOutcomes.map(entry => entry.salesOrder).filter(Boolean);
    // Fall back to the pre-split lineage when this request has no outcomes.
    if (!salesOrders.length) {
      const legacy = orderDto(
        orderById.get(String(request.sourceSalesOrder || ''))
        || ordersByQuotation.get(String(request.sourceQuotation || '')),
      );
      if (legacy) salesOrders.push(legacy);
    }
    return {
      ...request,
      shortfall: shortfallDto(request),
      // The raw rounds carry internal bookkeeping; `shortfall` is the shaped view.
      shortfallRounds: undefined,
      quotation: quotationDto(request.sourceQuotation),
      availableQuotation: quotationDto(request.availableQuotation),
      pendingStockQuotation: quotationDto(request.pendingStockQuotation),
      // Kept for older app builds that read a single order.
      salesOrder: salesOrders[0] || null,
      salesOrders,
      outcomes: fromOutcomes,
    };
  });
}

const REQUEST_FIELDS = [
  'requestNumber', 'status', 'items', 'remarks', 'deliveryAddress', 'expectedDeliveryDate',
  'submittedAt', 'createdAt', 'approvedAt', 'approvalRemarks', 'rejectionReason', 'rejectedAt',
  'cancelledAt', 'cancellationReason', 'sourceQuotation', 'linkedAt', 'revision',
  'editHistory', 'editedAt', 'salesExecutiveName',
  // Stock-aware processing: what was reserved, what is still being negotiated.
  'stockPlan', 'availableQuotation', 'pendingStockQuotation', 'sourceSalesOrder',
  'processedAt', 'convertedAt', 'outcomes', 'pendingStockFulfilledAt',
  'shortfallStatus', 'shortfallRounds', 'shortfallSettledAt',
].join(' ');

// GET /api/v1/dealer-app/order-requests?status=&page=&limit=
router.get('/order-requests', requireDealerPermission('orders.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const { page = 1, limit = 20, status } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const { filter: scoped, scope } = resolveOrderScope(req);
    const scopeFilter = { dealer: dealer._id, ...scoped };

    // Which box the dealer tapped. An unknown key falls back to `all` rather than
    // to an empty list, so a stale app build shows everything instead of nothing.
    const group = resolveStatusGroup(req.query.group);
    // `status` is still honoured for older app builds that filter by raw status.
    const groupFilter = req.query.group
      ? statusFilterForGroup(group)
      : (status ? { status } : {});

    const [rows, total, statusRows] = await Promise.all([
      DealerOrderRequest.find({ ...scopeFilter, ...groupFilter })
        .sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .select(REQUEST_FIELDS).lean(),
      DealerOrderRequest.countDocuments({ ...scopeFilter, ...groupFilter }),
      // Counts deliberately ignore the status filter: the boxes have to show the
      // full picture so the dealer can see how much sits in each bucket, not only
      // the one they happen to be looking at.
      DealerOrderRequest.aggregate([
        { $match: scopeFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const data = await attachRequestOutcomes(rows, dealer._id);
    res.json({
      success: true,
      data,
      scope,
      group,
      counts: buildStatusCounts(statusRows),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) { sendError(res, error); }
});

router.get('/order-requests/:id', requireDealerPermission('orders.view'), async (req, res) => {
  try {
    const request = await DealerOrderRequest.findOne({ _id: req.params.id, dealer: req.dealer._id })
      .select(REQUEST_FIELDS).lean();
    if (!request) throw appError(404, 'Order request not found.');
    const [enriched] = await attachRequestOutcomes([request], req.dealer._id);
    res.json({ success: true, data: enriched });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/order-requests/:id/shortfall
//
// Just the part of the request that is waiting on the dealer. The detail endpoint
// already carries this, but the app polls this one on its own so a pending answer
// can be surfaced without re-fetching the whole request.
router.get('/order-requests/:id/shortfall', requireDealerPermission('orders.view'), async (req, res) => {
  try {
    const request = await DealerOrderRequest.findOne({ _id: req.params.id, dealer: req.dealer._id })
      .select('requestNumber status shortfallStatus shortfallRounds shortfallSettledAt processedAt')
      .lean();
    if (!request) throw appError(404, 'Order request not found.');
    res.json({
      success: true,
      data: {
        requestNumber: request.requestNumber,
        status: request.status,
        awaitingResponse: request.shortfallStatus === 'awaiting_dealer',
        ...shortfallDto(request),
      },
    });
  } catch (error) { sendError(res, error); }
});

// POST /api/v1/dealer-app/order-requests/:id/shortfall/respond
//   { round, lines: [{ product, response: 'accepted'|'changed'|'rejected', quantity?, remark? }], remark? }
//
// The dealer's answer covers the short quantity only. Whatever they say here, the
// Sales Order already raised for the available quantity is untouched — it is
// reserved stock and is not theirs or ours to reopen from this screen.
//
// `round` is required so an answer to an offer the branch has since revised is
// rejected rather than applied to numbers the dealer never saw.
router.post('/order-requests/:id/shortfall/respond', requireDealerPermission('orders.shortfallRespond'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const round = Number(req.body?.round);
    if (!Number.isInteger(round) || round < 1) {
      throw appError(422, 'A valid round is required. Open the request again to see the current offer.');
    }
    const lines = req.body?.lines;
    if (!Array.isArray(lines) || !lines.length) throw appError(422, 'Answer each item before submitting.');
    if (lines.length > 100) throw appError(422, 'Too many items in one response.');

    let result;
    await session.withTransaction(async () => {
      result = await recordDealerResponse({
        requestId: req.params.id,
        dealerId: req.dealer._id,
        round,
        responses: lines,
        dealerRemark: req.body?.remark,
        session,
      });
    });

    const request = await DealerOrderRequest.findById(result.request._id).select(REQUEST_FIELDS).lean();
    const [enriched] = await attachRequestOutcomes([request], req.dealer._id);
    res.json({
      success: true,
      message: result.outcome === 'rejected'
        ? 'Thanks — we have recorded that you do not want the pending quantity.'
        : result.outcome === 'changed'
          ? 'Thanks — the branch will confirm the new availability date for your updated quantity.'
          : 'Thanks — your confirmation has been recorded and the branch will raise the pending order.',
      data: enriched,
    });
  } catch (error) { sendError(res, error); }
  finally { await session.endSession(); }
});

// POST /api/v1/dealer-app/order-requests/:id/cancel   { reason? }
//
// A dealer can withdraw their own request while it is still waiting for review.
// Once the branch has approved it, rejected it, or built a quotation from it, the
// decision is no longer the dealer's to reverse — they contact their executive.
// This is the only writer of the 'cancelled' status.
router.post('/order-requests/:id/cancel', requireDealerPermission('orders.cancel'), async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    const cancelled = await DealerOrderRequest.findOneAndUpdate(
      { _id: req.params.id, dealer: req.dealer._id, status: 'submitted' },
      {
        $set: {
          status: 'cancelled',
          cancelledBy: req.dealer._id,
          cancelledAt: new Date(),
          cancellationReason: reason,
        },
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true },
    ).select(REQUEST_FIELDS).lean();

    if (!cancelled) {
      const existing = await DealerOrderRequest.findOne({ _id: req.params.id, dealer: req.dealer._id })
        .select('status').lean();
      if (!existing) throw appError(404, 'Order request not found.');
      throw appError(409, existing.status === 'cancelled'
        ? 'This request is already cancelled.'
        : `This request is already ${String(existing.status).replace(/_/g, ' ')} and can no longer be cancelled. Please contact your sales executive.`);
    }
    res.json({ success: true, message: `Request ${cancelled.requestNumber} cancelled.`, data: cancelled });
  } catch (error) { sendError(res, error); }
});

// ── Orders (confirmed sales orders) ──────────────────────────────────────────
router.get('/orders', requireDealerPermission('orders.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const { filter: scoped, scope } = resolveOrderScope(req);
    const filter = { dealer: req.dealer._id, status: { $nin: ['draft'] }, ...scoped };
    if (status) filter.status = status;

    const [data, total, agg] = await Promise.all([
      SalesOrder.find(filter).sort({ orderDate: -1 }).skip((p - 1) * l).limit(l)
        .select('orderNumber orderDate status grandTotal balanceAmount paymentStatus items').lean(),
      SalesOrder.countDocuments(filter),
      // Value of everything in scope, not just the page — this is the headline
      // number on the "My Sales" view, so it must not change when you scroll.
      SalesOrder.aggregate([
        { $match: { ...filter, status: { $nin: ['draft', 'cancelled'] } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
      ]),
    ]);

    // An order being picked or already packed still reads as "approved" — SalesOrder has
    // no status between approved and dispatched. Annotating the row is what makes
    // "packed" visible on the order itself, which is where a dealer looks for it.
    const stageByOrder = await stagesByOrder(req.dealer._id, data.map(o => o._id));

    res.json({
      success: true,
      data: data.map(o => ({...o, fulfilment: stageByOrder.get(String(o._id)) || null})),
      scope,
      summary: {
        orderCount: agg[0]?.count || 0,
        totalValue: Math.round(((agg[0]?.total || 0) + Number.EPSILON) * 100) / 100,
      },
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/orders/:id — order detail scoped to the dealer
router.get('/orders/:id', requireDealerPermission('orders.view'), async (req, res) => {
  try {
    const order = await SalesOrder.findOne({ _id: req.params.id, dealer: req.dealer._id })
      .select('orderNumber orderDate status paymentStatus grandTotal subtotal totalDiscount totalTax freightCharges loadingCharges otherCharges roundOff advanceAmount balanceAmount deliveryAddress expectedDeliveryDate items')
      .lean();
    if (!order) throw appError(404, 'Order not found.');

    // Live stock per product so the app can offer "reorder" without letting the
    // dealer request more than is currently available.
    const branch = await resolveDealerBranch(req.dealer);
    const productIds = (order.items || []).map(it => it.product).filter(Boolean);
    const stockRows = (branch && productIds.length) ? await Stock.aggregate([
      { $match: { branch: new mongoose.Types.ObjectId(String(branch)), product: { $in: productIds } } },
      { $group: { _id: '$product', availableQty: { $sum: '$availableQty' } } },
    ]) : [];
    const stockByProduct = new Map(stockRows.map(r => [String(r._id), r.availableQty]));

    const stageByOrder = await stagesByOrder(req.dealer._id, [order._id]);

    res.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        orderDate: order.orderDate,
        status: order.status,
        // Null when nothing is being picked yet — the caller should leave `status`
        // alone rather than inventing a stage.
        fulfilment: stageByOrder.get(String(order._id)) || null,
        paymentStatus: order.paymentStatus,
        deliveryAddress: order.deliveryAddress,
        expectedDeliveryDate: order.expectedDeliveryDate,
        totals: {
          subtotal: money(order.subtotal),
          totalDiscount: money(order.totalDiscount),
          totalTax: money(order.totalTax),
          freightCharges: money(order.freightCharges),
          loadingCharges: money(order.loadingCharges),
          otherCharges: money(order.otherCharges),
          roundOff: money(order.roundOff),
          grandTotal: money(order.grandTotal),
          advanceAmount: money(order.advanceAmount),
          balanceAmount: money(order.balanceAmount),
        },
        items: (order.items || []).map(it => ({
          product: it.product || null,
          productName: it.productName,
          productCode: it.productCode,
          image: it.productImage || '',
          unit: it.unit,
          availableQty: Number(stockByProduct.get(String(it.product)) || 0),
          quantity: Number(it.quantity || 0),
          dispatchedQuantity: Number(it.dispatchedQuantity || 0),
          remainingQuantity: Number(it.remainingQuantity || 0),
          rate: money(it.rate),
          discount: money(it.discount),
          taxableAmount: money(it.taxableAmount),
          gstPercentage: Number(it.gstPercentage || 0),
          totalAmount: money(it.totalAmount),
        })),
      },
    });
  } catch (error) { sendError(res, error); }
});

// ── Invoices ─────────────────────────────────────────────────────────────────
router.get('/invoices', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const filter = { dealer: req.dealer._id, status: { $ne: 'cancelled' } };
    if (status === 'open') filter.balanceAmount = { $gt: 0 };
    if (status === 'paid') filter.paymentStatus = 'paid';
    const [rows, total] = await Promise.all([
      Invoice.find(filter).sort({ invoiceDate: -1 }).skip((p - 1) * l).limit(l)
        .select('invoiceNumber invoiceDate dueDate grandTotal paidAmount balanceAmount paymentStatus orderNumber').lean(),
      Invoice.countDocuments(filter),
    ]);
    // 17.5 "Credit days remaining" — negative once the due date has passed.
    const today = new Date();
    const data = rows.map(inv => ({
      ...inv,
      creditDaysRemaining: inv.dueDate
        ? Math.ceil((new Date(inv.dueDate) - today) / 86400000)
        : null,
    }));
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/invoices/:id — invoice detail scoped to the dealer
router.get('/invoices/:id', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const inv = await Invoice.findOne({ _id: req.params.id, dealer: req.dealer._id })
      .select('invoiceNumber invoiceDate dueDate status paymentStatus paidAmount balanceAmount grandTotal subtotal totalDiscount taxableTotal totalCgst totalSgst totalIgst totalTax freightCharges loadingCharges otherCharges roundOff isInterState orderNumber paymentTerms amountInWords items sellerName sellerGstin buyerName buyerGstin')
      .lean();
    if (!inv) throw appError(404, 'Invoice not found.');
    res.json({
      success: true,
      data: {
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        status: inv.status,
        paymentStatus: inv.paymentStatus,
        orderNumber: inv.orderNumber,
        paymentTerms: inv.paymentTerms,
        creditDaysRemaining: inv.dueDate
          ? Math.ceil((new Date(inv.dueDate) - new Date()) / 86400000)
          : null,
        amountInWords: inv.amountInWords,
        isInterState: Boolean(inv.isInterState),
        seller: { name: inv.sellerName, gstin: inv.sellerGstin },
        buyer: { name: inv.buyerName, gstin: inv.buyerGstin },
        totals: {
          subtotal: money(inv.subtotal),
          totalDiscount: money(inv.totalDiscount),
          taxableTotal: money(inv.taxableTotal),
          totalCgst: money(inv.totalCgst),
          totalSgst: money(inv.totalSgst),
          totalIgst: money(inv.totalIgst),
          totalTax: money(inv.totalTax),
          freightCharges: money(inv.freightCharges),
          loadingCharges: money(inv.loadingCharges),
          otherCharges: money(inv.otherCharges),
          roundOff: money(inv.roundOff),
          grandTotal: money(inv.grandTotal),
          paidAmount: money(inv.paidAmount),
          balanceAmount: money(inv.balanceAmount),
        },
        items: (inv.items || []).map(it => ({
          productName: it.productName,
          productCode: it.productCode,
          hsnCode: it.hsnCode,
          unit: it.unit,
          quantity: Number(it.quantity || 0),
          rate: money(it.rate),
          discount: money(it.discount),
          gstPercentage: Number(it.gstPercentage || 0),
          totalAmount: money(it.totalAmount ?? it.lineTotal),
        })),
      },
    });
  } catch (error) { sendError(res, error); }
});

// ── Statement / ledger ───────────────────────────────────────────────────────
router.get('/statement', requireDealerPermission('finance.ledger'), async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const [entries, total, agg] = await Promise.all([
      DealerLedger.find({ dealer: req.dealer._id }).sort({ entryDate: -1 }).skip((p - 1) * l).limit(l)
        .select('entryType entryDate referenceNumber debit credit description').lean(),
      DealerLedger.countDocuments({ dealer: req.dealer._id }),
      DealerLedger.aggregate([
        { $match: { dealer: new mongoose.Types.ObjectId(String(req.dealer._id)) } },
        { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ]),
    ]);
    res.json({
      success: true,
      data: entries,
      summary: { outstanding: money((agg[0]?.debit || 0) - (agg[0]?.credit || 0)) },
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) { sendError(res, error); }
});

// ── Schemes & rewards (17.6) ─────────────────────────────────────────────────
// GET /api/v1/dealer-app/schemes — active schemes the dealer is eligible for.
// Eligibility is derived from applicableTo (all / specific dealer / category / type).
router.get('/schemes', requireDealerPermission('schemes.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const now = new Date();

    const filter = schemeEligibilityFilter(dealer, branch, now);

    const schemes = await DealerScheme.find(filter)
      .select('schemeNumber schemeName basis calculationType targetAmount targetQuantity rate fixedAmount slabs startDate endDate description termsAndConditions products')
      .populate('products', 'itemName productCode')
      .sort({ endDate: 1 }).lean();

    // Progress needs realised value/quantity for this dealer within the scheme window.
    // We compute achieved invoice value/quantity per scheme window (best-effort, not authoritative).
    const data = await Promise.all(schemes.map(async (s) => {
      let achievedValue = 0;
      let achievedQty = 0;
      try {
        const invAgg = await Invoice.aggregate([
          { $match: {
            dealer: new mongoose.Types.ObjectId(String(dealer._id)),
            status: { $ne: 'cancelled' },
            invoiceDate: { $gte: new Date(s.startDate), $lte: new Date(s.endDate) },
          } },
          { $group: { _id: null, value: { $sum: '$grandTotal' }, qty: { $sum: { $sum: '$items.quantity' } } } },
        ]);
        achievedValue = money(invAgg[0]?.value || 0);
        achievedQty = Number(invAgg[0]?.qty || 0);
      } catch { /* progress best-effort */ }

      const target = s.basis === 'invoice_quantity' ? Number(s.targetQuantity || 0) : Number(s.targetAmount || 0);
      const achieved = s.basis === 'invoice_quantity' ? achievedQty : achievedValue;
      const progress = target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0;
      const daysLeft = Math.max(0, Math.ceil((new Date(s.endDate) - now) / 86400000));

      return {
        _id: s._id,
        schemeNumber: s.schemeNumber,
        schemeName: s.schemeName,
        description: s.description || '',
        terms: s.termsAndConditions || '',
        basis: s.basis,
        calculationType: s.calculationType,
        target,
        achieved,
        progress,
        unit: s.basis === 'invoice_quantity' ? 'qty' : 'value',
        startDate: s.startDate,
        endDate: s.endDate,
        daysLeft,
        // 17.6 "Eligible products" — empty means the scheme applies to everything.
        eligibleProducts: (s.products || []).map(pr => ({
          _id: pr._id,
          itemName: pr.itemName,
          productCode: pr.productCode,
        })),
      };
    }));

    res.json({ success: true, data });
  } catch (error) { sendError(res, error); }
});

// ── Notifications feed (17.7) ────────────────────────────────────────────────
// Synthesized from the dealer's own domain events (no dealer-recipient store
// exists yet). Categories: order, dispatch, invoice, payment, scheme, offer.
//
// Each source is read ONLY when the caller holds the permission that would let
// them open the matching screen. Without that, this feed was a side door: an
// employee with no payments grant could read invoice balances, ledger credits and
// credit-note amounts, which every other screen redacts. Skipping the QUERY — not
// blanking the text afterwards — is what keeps those numbers out of memory.
// GET /api/v1/dealer-app/notifications
router.get('/notifications', requireDealerPermission('dashboard.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const now = new Date();
    const items = [];

    const showOrders = canSee(req, 'orders.view');
    // Invoices, ledger credits and credit notes are all money.
    const showMoney = canSee(req, 'payments.view');
    const showSchemes = canSee(req, 'schemes.view');
    const showDeliveries = canSee(req, 'deliveries.view');
    const showArrivals = canSee(req, 'catalogue.view');

    const [
      recentOrders,
      recentInvoices,
      recentPayments,
      expiringSchemes,
      recentDeliveries,
      recentCreditNotes,
      newArrivals,
      // Orders still in the warehouse. Without this the feed could only ever talk about
      // rows that already exist as deliveries, so an order that was picked, packed or
      // loaded produced no entry at all — which is why "notification not showing" and
      // "packed order not appearing" turned out to be the same bug.
      warehousePickLists,
    ] = await Promise.all([
      showOrders ? SalesOrder.find({ dealer: dealer._id, status: { $nin: ['draft'] } })
        .select('orderNumber orderDate status updatedAt grandTotal').sort({ updatedAt: -1 }).limit(10).lean() : [],
      showMoney ? Invoice.find({ dealer: dealer._id, status: { $ne: 'cancelled' } })
        .select('invoiceNumber invoiceDate dueDate grandTotal balanceAmount paymentStatus').sort({ invoiceDate: -1 }).limit(10).lean() : [],
      showMoney ? DealerLedger.find({ dealer: dealer._id, credit: { $gt: 0 } })
        .select('referenceNumber entryDate credit description').sort({ entryDate: -1 }).limit(6).lean() : [],
      showSchemes && branch ? DealerScheme.find({
        branch, status: 'active', endDate: { $gte: now, $lte: new Date(now.getTime() + 14 * 86400000) },
        $or: [{ applicableTo: 'all' }, { dealers: dealer._id }],
      }).select('schemeName endDate').limit(6).lean() : [],
      // Dispatch + delivery updates (17.7)
      showDeliveries ? Delivery.find({ dealer: dealer._id })
        .select('deliveryNumber deliveryDate status orderNumber startTime completionTime updatedAt')
        .sort({ updatedAt: -1 }).limit(10).lean() : [],
      // Credit note generated (17.7)
      showMoney ? SalesReturn.find({ dealer: dealer._id, creditNoteNumber: { $nin: [null, ''] } })
        .select('creditNoteNumber creditNoteDate grandTotal returnDate')
        .sort({ creditNoteDate: -1 }).limit(6).lean() : [],
      // New arrivals (17.7) — dealer-visible products added in the last 30 days
      showArrivals ? Product.find({
        status: 'active',
        dealerVisible: { $ne: false },
        createdAt: { $gte: new Date(now.getTime() - 30 * 86400000) },
      }).select('itemName productCode createdAt brand').sort({ createdAt: -1 }).limit(6).lean() : [],
      showDeliveries ? findDealerPickLists(dealer._id, {limit: 10, includeLoaded: true}) : [],
    ]);

    for (const o of recentOrders) {
      items.push({
        id: `order-${o._id}`, type: 'order',
        title: `Order ${o.orderNumber} — ${String(o.status || '').replace(/_/g, ' ')}`,
        body: `Order total ${money(o.grandTotal || 0)}.`,
        date: o.updatedAt || o.orderDate,
      });
    }
    for (const inv of recentInvoices) {
      const overdue = inv.dueDate && new Date(inv.dueDate) < now && Number(inv.balanceAmount) > 0;
      items.push({
        id: `invoice-${inv._id}`, type: overdue ? 'payment' : 'invoice',
        title: overdue ? `Payment reminder — ${inv.invoiceNumber}` : `Invoice ${inv.invoiceNumber} generated`,
        body: overdue
          ? `Balance ${money(inv.balanceAmount || 0)} was due on ${new Date(inv.dueDate).toLocaleDateString('en-IN')}.`
          : `Invoice total ${money(inv.grandTotal || 0)}.`,
        date: overdue ? inv.dueDate : inv.invoiceDate,
      });
    }
    for (const pay of recentPayments) {
      items.push({
        id: `pay-${pay._id}`, type: 'payment',
        title: 'Payment received',
        body: `${money(pay.credit || 0)} credited${pay.referenceNumber ? ` (${pay.referenceNumber})` : ''}.`,
        date: pay.entryDate,
      });
    }
    for (const s of expiringSchemes) {
      items.push({
        id: `scheme-${s._id}`, type: 'scheme',
        title: 'Scheme expiring soon',
        body: `${s.schemeName} ends on ${new Date(s.endDate).toLocaleDateString('en-IN')}.`,
        date: s.endDate,
      });
    }

    // Dispatch vs delivery are distinct SOW categories, so split on status.
    const DELIVERED_STATES = ['delivered', 'partially_delivered'];
    for (const d of recentDeliveries) {
      const delivered = DELIVERED_STATES.includes(d.status);
      const readable = String(d.status || '').replace(/_/g, ' ');
      items.push({
        id: `delivery-${d._id}`,
        type: delivered ? 'delivery' : 'dispatch',
        title: delivered
          ? `Delivered — ${d.deliveryNumber}`
          : `Dispatch update — ${d.deliveryNumber}`,
        body: delivered
          ? `Your consignment${d.orderNumber ? ` for ${d.orderNumber}` : ''} was ${readable}.`
          : `Status: ${readable}${d.orderNumber ? ` · ${d.orderNumber}` : ''}.`,
        date: d.completionTime || d.startTime || d.updatedAt || d.deliveryDate,
        deliveryId: d._id,
      });
    }

    // Warehouse updates. These have no delivery to point at — that is the whole reason
    // they were missing — so they carry the order number instead.
    for (const p of warehousePickLists) {
      const picked =
        p.totalRequestedQty > 0
          ? ` ${p.totalPickedQty} of ${p.totalRequestedQty} picked.`
          : '';
      items.push({
        id: `picklist-${p._id}`,
        type: 'dispatch',
        title: `${p.stageLabel} — ${p.orderNumber || p.pickListNumber}`,
        body:
          p.stage === 'picking'
            ? `Your order is being picked in the warehouse.${picked}`
            : p.stage === 'packing'
            ? 'Your order is packed and being made ready for dispatch.'
            : 'Your order is loaded on the vehicle and waiting to leave.',
        date: p.since,
        orderNumber: p.orderNumber || '',
      });
    }

    for (const cn of recentCreditNotes) {
      items.push({
        id: `creditnote-${cn._id}`, type: 'credit_note',
        title: `Credit note ${cn.creditNoteNumber} issued`,
        body: `${money(cn.grandTotal || 0)} credited to your account.`,
        date: cn.creditNoteDate || cn.returnDate,
      });
    }

    for (const pr of newArrivals) {
      items.push({
        id: `arrival-${pr._id}`, type: 'new_arrival',
        title: 'New arrival',
        body: `${pr.itemName}${pr.productCode ? ` (${pr.productCode})` : ''} is now available.`,
        date: pr.createdAt,
        productId: pr._id,
      });
    }

    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ success: true, data: items.slice(0, 40) });
  } catch (error) { sendError(res, error); }
});

// ── Support / complaints (17.8) ──────────────────────────────────────────────
// GET /api/v1/dealer-app/complaints
router.get('/complaints', requireDealerPermission('complaints.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const filter = { dealer: req.dealer._id };
    if (status) filter.status = status;
    const [data, total] = await Promise.all([
      Complaint.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .select('complaintNumber category description priority status orderNumber invoiceNumber requiresReturn createdAt resolvedAt').lean(),
      Complaint.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/complaints/:id — full detail incl. resolution history
router.get('/complaints/:id', requireDealerPermission('complaints.view'), async (req, res) => {
  try {
    const c = await Complaint.findOne({ _id: req.params.id, dealer: req.dealer._id })
      .select('complaintNumber category description priority status orderNumber invoiceNumber requiresReturn returnReceived creditNoteIssued creditNoteNumber creditNoteAmount products complaintPhotos resolutionHistory resolutionNotes resolvedAt createdAt assignedToName')
      .lean();
    if (!c) throw appError(404, 'Complaint not found.');
    res.json({ success: true, data: c });
  } catch (error) { sendError(res, error); }
});

// POST /api/v1/dealer-app/complaints — create a ticket with optional images.
// multipart/form-data: category, description, priority, orderNumber?, invoiceNumber?, images[]
router.post('/complaints', requireDealerPermission('complaints.create'), (req, res) => {
  uploadComplaintEvidence(req, res, async (uploadErr) => {
    try {
      if (uploadErr) throw appError(400, uploadErr.message || 'Image upload failed.');
      const dealer = req.dealer;
      const branch = await resolveDealerBranch(dealer);
      const { category, description, priority, orderNumber, invoiceNumber } = req.body || {};
      if (!description || !String(description).trim()) throw appError(422, 'Please describe the issue.');

      const allowedCategories = ['damaged_goods', 'wrong_product', 'quality_issue', 'shade_mismatch', 'size_issue', 'short_delivery', 'billing_error', 'payment_issue', 'delivery_delay', 'packing_issue', 'other'];
      const cat = allowedCategories.includes(category) ? category : 'other';
      const pri = ['low', 'medium', 'high', 'critical'].includes(priority) ? priority : 'medium';
      // 17.8 "Return request" — the dealer asks for goods to go back; warehouse
      // verification and any credit note stay with staff.
      const requiresReturn = String(req.body?.requiresReturn) === 'true';

      const files = Array.isArray(req.files) ? req.files : [];
      const evidenceDocs = branch && files.length
        ? await ComplaintEvidence.insertMany(files.map((f) => ({
            branch,
            uploadedBy: dealer.assignedSalesExecutive?._id || dealer.assignedSalesExecutive || dealer._id,
            url: `/uploads/complaints/${f.filename}`,
            originalName: f.originalname,
            mimeType: f.mimetype,
            size: f.size,
            status: 'attached',
            attachedAt: new Date(),
          })))
        : [];

      const complaintNumber = await generateUniqueCode(Complaint, 'complaintNumber', 'CMP-', 5);
      const complaint = await Complaint.create({
        complaintNumber,
        branch: branch || undefined,
        dealer: dealer._id,
        dealerName: dealer.businessName,
        orderNumber: orderNumber || undefined,
        invoiceNumber: invoiceNumber || undefined,
        category: cat,
        description: String(description).trim(),
        priority: pri,
        status: 'open',
        requiresReturn,
        assignedTo: dealer.assignedSalesExecutive?._id || dealer.assignedSalesExecutive || undefined,
        assignedToName: dealer.assignedSalesExecutive?.name || '',
        complaintPhotos: evidenceDocs.map((d) => ({ evidence: d._id, url: d.url, caption: '' })),
        createdByName: dealer.businessName,
      });

      res.status(201).json({ success: true, message: `Complaint ${complaint.complaintNumber} raised. Your sales executive will follow up.`, data: complaint });
    } catch (error) { sendError(res, error); }
  });
});

// ── Payment intimation / UTR upload (17.5) ───────────────────────────────────
// GET /api/v1/dealer-app/payment-intimations
router.get('/payment-intimations', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const data = await PaymentIntimation.find({ dealer: req.dealer._id })
      .sort({ createdAt: -1 }).limit(50)
      .select('intimationNumber invoiceNumber amount paymentDate paymentMode utrNumber chequeNumber bankName status reviewNote createdAt').lean();
    res.json({ success: true, data });
  } catch (error) { sendError(res, error); }
});

// POST /api/v1/dealer-app/payment-intimations — dealer notifies a payment.
// multipart/form-data (proof optional): amount, paymentMode, utrNumber?, chequeNumber?,
// bankName?, invoiceNumber?, invoiceId?, paymentDate?, referenceNote?, images[] (first used as proof)
router.post('/payment-intimations', requireDealerPermission('payments.collection'), (req, res) => {
  uploadComplaintEvidence(req, res, async (uploadErr) => {
    try {
      if (uploadErr) throw appError(400, uploadErr.message || 'Proof upload failed.');
      const dealer = req.dealer;
      const branch = await resolveDealerBranch(dealer);
      const { amount, paymentMode, utrNumber, chequeNumber, bankName, invoiceNumber, invoiceId, paymentDate, referenceNote } = req.body || {};

      const amt = Number(amount);
      if (!amt || amt <= 0) throw appError(422, 'Enter a valid payment amount.');
      const mode = ['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'other'].includes(paymentMode) ? paymentMode : 'neft';
      if (mode === 'cheque' && !String(chequeNumber || '').trim()) throw appError(422, 'Cheque number is required for cheque payments.');
      if (['neft', 'rtgs', 'imps', 'upi'].includes(mode) && !String(utrNumber || '').trim()) {
        throw appError(422, 'UTR / reference number is required for bank transfers.');
      }

      // Validate optional invoice linkage belongs to this dealer.
      let linkedInvoice = null;
      if (invoiceId && mongoose.isValidObjectId(invoiceId)) {
        linkedInvoice = await Invoice.findOne({ _id: invoiceId, dealer: dealer._id }).select('invoiceNumber').lean();
      }

      const files = Array.isArray(req.files) ? req.files : [];
      const proofUrl = files[0] ? `/uploads/complaints/${files[0].filename}` : '';

      const intimationNumber = await generateUniqueCode(PaymentIntimation, 'intimationNumber', 'PI-', 5);
      const record = await PaymentIntimation.create({
        intimationNumber,
        branch: branch || undefined,
        dealer: dealer._id,
        dealerName: dealer.businessName,
        invoice: linkedInvoice?._id || undefined,
        invoiceNumber: linkedInvoice?.invoiceNumber || invoiceNumber || '',
        amount: money(amt),
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        paymentMode: mode,
        utrNumber: String(utrNumber || '').trim(),
        chequeNumber: String(chequeNumber || '').trim(),
        bankName: String(bankName || '').trim(),
        referenceNote: String(referenceNote || '').trim(),
        proofUrl,
        status: 'submitted',
        // Recorded at submission so dealer-employee collection targets have a
        // stable basis. Null when the dealer owner submitted it themselves.
        createdByEmployee: req.dealerEmployee?._id || null,
      });

      res.status(201).json({ success: true, message: `Payment intimation ${record.intimationNumber} submitted. Accounts will verify and update your ledger.`, data: record });
    } catch (error) { sendError(res, error); }
  });
});

// ── Document downloads (17.5) ────────────────────────────────────────────────
// The app asks for a short-lived link, then opens it in the device viewer. The
// token is bound to this dealer and this one document.
const downloadBase = (req) => `${req.protocol}://${req.get('host')}/api/v1/dealer-downloads`;

// POST /api/v1/dealer-app/invoices/:id/download-link
router.post('/invoices/:id/download-link', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const inv = await Invoice.findOne({ _id: req.params.id, dealer: req.dealer._id })
      .select('invoiceNumber').lean();
    if (!inv) throw appError(404, 'Invoice not found.');
    const token = generateDownloadToken(req.dealer._id, 'invoice', req.params.id);
    res.json({
      success: true,
      data: {
        url: `${downloadBase(req)}/invoices/${req.params.id}.pdf?token=${token}`,
        fileName: `${inv.invoiceNumber || 'invoice'}.pdf`,
        expiresInSeconds: 300,
      },
    });
  } catch (error) { sendError(res, error); }
});

// POST /api/v1/dealer-app/receipts/:id/download-link
router.post('/receipts/:id/download-link', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const pay = await Payment.findOne({
      _id: req.params.id, dealer: req.dealer._id, paymentType: 'dealer_receipt',
    }).select('paymentNumber').lean();
    if (!pay) throw appError(404, 'Receipt not found.');
    const token = generateDownloadToken(req.dealer._id, 'receipt', req.params.id);
    res.json({
      success: true,
      data: {
        url: `${downloadBase(req)}/receipts/${req.params.id}.pdf?token=${token}`,
        fileName: `${pay.paymentNumber || 'receipt'}.pdf`,
        expiresInSeconds: 300,
      },
    });
  } catch (error) { sendError(res, error); }
});

// ── Deliveries / tracking (17.4) ─────────────────────────────────────────────
//
// The handover OTP is the dealer's proof that they received the goods: the driver
// asks for it and staff type it into Delivery Tracking to verify. Staff endpoints
// deliberately strip it (deliveryRoutes uses select('-otp') and safeDelivery
// deletes it), so the DEALER is the only party who may read it — otherwise the
// code exists but nobody can produce it and the verification step is unusable.
//
// Only while the goods are actually in play, and never once verified: after that
// the code has served its purpose and there is no reason to keep showing it.
const OTP_VISIBLE_STATES = ['assigned', 'in_transit', 'reached'];
const handoverOtp = delivery =>
  (!delivery?.otpVerified && OTP_VISIBLE_STATES.includes(delivery?.status) ? delivery.otp || '' : '');

// GET /api/v1/dealer-app/deliveries?status=&page=&limit=
router.get('/deliveries', requireDealerPermission('deliveries.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const filter = { dealer: req.dealer._id };
    if (status === 'open') filter.status = { $in: ['assigned', 'in_transit', 'reached'] };
    else if (status) filter.status = status;

    const [data, total] = await Promise.all([
      Delivery.find(filter).sort({ deliveryDate: -1 }).skip((p - 1) * l).limit(l)
        .select('deliveryNumber deliveryDate status orderNumber invoiceNumber tripNumber dispatchTrip deliveryExecutiveName items completionTime otp otpVerified vehicleNumber')
        .lean(),
      Delivery.countDocuments(filter),
    ]);

    // Resolve the upstream stage for the whole page in two queries rather than two per
    // delivery. The pick lists come off the delivery's own item lineage, so this stays
    // scoped to rows the dealer is already allowed to see — it cannot leak another
    // dealer's order through a shared pick list.
    const pickIds = [...new Set(data.flatMap(d => (d.items || []).map(i => i.pickList).filter(Boolean).map(String)))];
    const tripIds = [...new Set(data.map(d => d.dispatchTrip).filter(Boolean).map(String))];
    const [picks, trips] = await Promise.all([
      pickIds.length ? PickList.find({_id: {$in: pickIds}}).select('status').lean() : [],
      tripIds.length ? DispatchTrip.find({_id: {$in: tripIds}}).select('status').lean() : [],
    ]);
    const pickById = new Map(picks.map(x => [String(x._id), x.status]));
    const tripById = new Map(trips.map(x => [String(x._id), x.status]));

    const deliveries = data.map(d => {
      const pickStatus = (d.items || []).map(i => pickById.get(String(i.pickList))).find(Boolean) || '';
      const tripStatus = tripById.get(String(d.dispatchTrip)) || '';
      const stage = resolveStage({
        pickListStatus: pickStatus,
        tripStatus,
        deliveryStatus: d.status,
      });
      return {
        _id: d._id,
        deliveryNumber: d.deliveryNumber,
        deliveryDate: d.deliveryDate,
        status: d.status,
        // What the dealer is shown. `status` stays as the delivery's own state for
        // anything that keys off it.
        stage,
        stageLabel: stageLabel(stage),
        orderNumber: d.orderNumber || '',
        invoiceNumber: d.invoiceNumber || '',
        itemCount: (d.items || []).length,
        deliveryExecutiveName: d.deliveryExecutiveName || '',
        completionTime: d.completionTime || null,
        vehicleNumber: d.vehicleNumber || '',
        otp: handoverOtp(d),
        otpVerified: Boolean(d.otpVerified),
        preDispatch: false,
      };
    });

    // Orders still in the warehouse have no Delivery row, so however far along they had
    // got they were invisible here — a packed order simply did not appear. They go on
    // top of page 1: they are the most recent thing happening to the dealer's orders,
    // and the app only ever requests page 1.
    const preDispatch =
      p === 1
        ? (await findDealerPickLists(req.dealer._id, {limit: 10})).map(row => ({
            _id: row._id,
            // No delivery number exists yet, so the order number is what the dealer
            // actually recognises; the pick list number is the fallback.
            deliveryNumber: row.orderNumber || row.pickListNumber,
            deliveryDate: row.since,
            status: row.status,
            stage: row.stage,
            stageLabel: row.stageLabel,
            orderNumber: row.orderNumber,
            invoiceNumber: '',
            itemCount: row.itemCount,
            deliveryExecutiveName: '',
            completionTime: null,
            vehicleNumber: '',
            otp: '',
            otpVerified: false,
            // Lets the app tell a not-yet-dispatched order from a real delivery, so it
            // never offers a handover OTP for goods still in the warehouse.
            preDispatch: true,
          }))
        : [];

    // Merged by date rather than simply concatenated. Both halves arrive date-sorted
    // from their own query, but concatenating put every warehouse row above every
    // delivery regardless of age — a two-week-old packed order sat above a delivery
    // that went out this morning.
    const combined = [...preDispatch, ...deliveries].sort(
      (a, b) => new Date(b.deliveryDate || 0) - new Date(a.deliveryDate || 0),
    );

    res.json({
      success: true,
      data: combined,
      pagination: {
        currentPage: p,
        totalPages: Math.ceil((total + preDispatch.length) / l),
        totalItems: total + preDispatch.length,
      },
    });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/deliveries/:id — full detail incl. proof of delivery
router.get('/deliveries/:id', requireDealerPermission('deliveries.view'), async (req, res) => {
  try {
    const d = await Delivery.findOne({ _id: req.params.id, dealer: req.dealer._id })
      .select('deliveryNumber deliveryDate status orderNumber invoiceNumber tripNumber dispatchTrip deliveryAddress contactPhone deliveryExecutiveName items podImage podSignature podDocumentUrl receiverName startTime reachTime completionTime deliveryRemarks failureReason failureRemarks rescheduleDate otp otpVerified otpVerifiedAt vehicleNumber vehicleType driverName driverPhone')
      .populate('items.product', 'itemName productCode unit')
      .lean();
    if (!d) {
      // The deliveries list also carries rows for orders still in the warehouse, whose
      // `_id` is a PickList rather than a Delivery. The lookup above only searches
      // Delivery, so without this branch every one of those rows opened straight to
      // "Delivery not found".
      const preDispatch = await findDealerPickListDetail(req.dealer._id, req.params.id);
      if (!preDispatch) throw appError(404, 'Delivery not found.');
      return res.json({success: true, data: preDispatch});
    }

    // Picking and loading happen BEFORE this Delivery exists — the row is created when
    // the pick list reaches `loaded` — so the upstream timestamps have to be read back
    // off the pick list and the trip. Without this the timeline began at "Assigned" and
    // made it look as though nothing at all had happened to the order until then.
    const pickIds = [...new Set((d.items || []).map(i => i.pickList).filter(Boolean).map(String))];
    const [picks, trip] = await Promise.all([
      pickIds.length
        ? PickList.find({_id: {$in: pickIds}})
            .select('status pickDate assignedAt pickingStartTime sortingStartTime packingEndTime loadingEndTime')
            .sort({pickDate: 1})
            .lean()
        : [],
      d.dispatchTrip
        ? DispatchTrip.findById(d.dispatchTrip)
            .select('status loadingStartTime dispatchTime')
            .lean()
        : null,
    ]);

    // One delivery can span several pick lists, so each warehouse step takes the
    // EARLIEST matching timestamp — the point at which that stage began for the order as
    // a whole, not one pick list's arbitrary timing.
    const earliest = (key) =>
      picks.map(x => x[key]).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
    // Loading is the one step where the LAST pick list matters: the order is only fully
    // loaded once the final one is.
    const latest = (key) =>
      picks.map(x => x[key]).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;

    const stage = resolveStage({
      pickListStatus: picks[0]?.status || '',
      tripStatus: trip?.status || '',
      deliveryStatus: d.status,
    });

    // Built from the real timestamps the flow records. A step with no timestamp stays
    // pending rather than claiming to be done.
    const timeline = [
      {key: 'picking', label: 'Picking', at: earliest('pickingStartTime') || earliest('assignedAt') || earliest('pickDate')},
      {key: 'packing', label: 'Packing', at: earliest('sortingStartTime') || earliest('packingEndTime')},
      {key: 'loading', label: 'Loading', at: trip?.loadingStartTime || latest('loadingEndTime')},
      {key: 'assigned', label: 'Assigned', at: d.deliveryDate || null},
      {key: 'in_transit', label: 'In transit', at: d.startTime || trip?.dispatchTime || null},
      {key: 'reached', label: 'Reached location', at: d.reachTime || null},
      {key: 'delivered', label: 'Delivered', at: d.completionTime || null},
    ];

    res.json({
      success: true,
      data: {
        deliveryNumber: d.deliveryNumber,
        deliveryDate: d.deliveryDate,
        completionTime: d.completionTime || null,
        status: d.status,
        // What the dealer is shown. The raw warehouse statuses are deliberately NOT
        // exposed — collapsing them is the point, and "sorted" is not the dealer's
        // business.
        stage,
        stageLabel: stageLabel(stage),
        orderNumber: d.orderNumber || '',
        invoiceNumber: d.invoiceNumber || '',
        tripNumber: d.tripNumber || '',
        deliveryAddress: d.deliveryAddress || '',
        contactPhone: d.contactPhone || '',
        deliveryExecutiveName: d.deliveryExecutiveName || '',
        // Which vehicle is bringing the goods, and who is driving it.
        vehicleNumber: d.vehicleNumber || '',
        vehicleType: d.vehicleType || '',
        driverName: d.driverName || '',
        driverPhone: d.driverPhone || '',
        receiverName: d.receiverName || '',
        remarks: d.deliveryRemarks || '',
        failureReason: d.failureReason || '',
        failureRemarks: d.failureRemarks || '',
        rescheduleDate: d.rescheduleDate || null,
        // Shown to the dealer so they can read it out at the door.
        otp: handoverOtp(d),
        otpVerified: Boolean(d.otpVerified),
        otpVerifiedAt: d.otpVerifiedAt || null,
        timeline,
        pod: {
          image: d.podImage || '',
          signature: d.podSignature || '',
          document: d.podDocumentUrl || '',
        },
        items: (d.items || []).map(it => ({
          productName: it.product?.itemName || '',
          productCode: it.product?.productCode || '',
          unit: it.enteredUnit || it.product?.unit || 'Box',
          dispatchedQuantity: Number(it.dispatchedQuantity || 0),
          acceptedQuantity: Number(it.acceptedQuantity || 0),
          shortQuantity: Number(it.shortQuantity || 0),
          damagedQuantity: Number(it.damagedRejectedQuantity || 0),
        })),
      },
    });
  } catch (error) { sendError(res, error); }
});

// ── Receipts (17.5) ──────────────────────────────────────────────────────────
// Confirmed dealer receipts posted by accounts — the dealer's payment history.
router.get('/receipts', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const filter = {
      dealer: req.dealer._id,
      paymentType: 'dealer_receipt',
      status: { $in: ['confirmed', 'pending', 'bounced'] },
    };
    const [rows, total] = await Promise.all([
      Payment.find(filter).sort({ paymentDate: -1 }).skip((p - 1) * l).limit(l)
        .select('paymentNumber paymentDate amount paymentMode status bankName chequeNumber transactionRef againstOrders remarks')
        .lean(),
      Payment.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: rows.map(r => ({
        _id: r._id,
        paymentNumber: r.paymentNumber,
        paymentDate: r.paymentDate,
        amount: money(r.amount || 0),
        paymentMode: r.paymentMode || '',
        status: r.status,
        bankName: r.bankName || '',
        chequeNumber: r.chequeNumber || '',
        reference: r.transactionRef || '',
        against: (r.againstOrders || []).map(a => a.orderNumber).filter(Boolean),
        remarks: r.remarks || '',
      })),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) { sendError(res, error); }
});

// ── Credit notes (17.5) ──────────────────────────────────────────────────────
// Sales returns that produced a credit note for this dealer.
router.get('/credit-notes', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const filter = {
      dealer: req.dealer._id,
      creditNoteNumber: { $nin: [null, ''] },
    };
    const [rows, total] = await Promise.all([
      SalesReturn.find(filter).sort({ creditNoteDate: -1, createdAt: -1 }).skip((p - 1) * l).limit(l)
        .select('returnNumber creditNoteNumber creditNoteDate grandTotal invoiceNumber status returnDate items')
        .lean(),
      SalesReturn.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: rows.map(r => ({
        _id: r._id,
        creditNoteNumber: r.creditNoteNumber,
        creditNoteDate: r.creditNoteDate || r.returnDate,
        amount: money(r.grandTotal || 0),
        returnNumber: r.returnNumber || '',
        invoiceNumber: r.invoiceNumber || '',
        status: r.status || '',
        itemCount: (r.items || []).length,
      })),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) { sendError(res, error); }
});

// ── Debit notes (17.5) ───────────────────────────────────────────────────────
// There is no standalone DebitNote document in the platform; debit notes are
// posted to the dealer ledger by accounts. We surface those entries read-only.
router.get('/debit-notes', requireDealerPermission('payments.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const filter = { dealer: req.dealer._id, entryType: 'debit_note' };
    const [rows, total] = await Promise.all([
      DealerLedger.find(filter).sort({ entryDate: -1 }).skip((p - 1) * l).limit(l)
        .select('referenceNumber entryDate debit credit description').lean(),
      DealerLedger.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: rows.map(r => ({
        _id: r._id,
        debitNoteNumber: r.referenceNumber || '',
        date: r.entryDate,
        // A debit note increases what the dealer owes, so it lands in `debit`.
        amount: money(r.debit || 0),
        description: r.description || '',
      })),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total },
    });
  } catch (error) { sendError(res, error); }
});

// ── Similar products (17.3) ──────────────────────────────────────────────────
// Same category (falling back to brand), excluding the product itself.
router.get('/catalogue/:id/similar', requireDealerPermission('catalogue.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const base = await Product.findOne({ _id: req.params.id }).select('category brand tileSize').lean();
    if (!base) throw appError(404, 'Product not found.');

    const scope = { status: 'active', dealerVisible: { $ne: false }, _id: { $ne: base._id } };
    let products = [];
    if (base.category) {
      products = await Product.find({ ...scope, category: base.category })
        .select('productCode itemName brand tileSize finish colour unit images mrp')
        .populate('brand', 'name').limit(10).lean();
    }
    if (products.length < 4 && base.brand) {
      const extra = await Product.find({
        ...scope,
        brand: base.brand,
        _id: { $nin: [base._id, ...products.map(x => x._id)] },
      }).select('productCode itemName brand tileSize finish colour unit images mrp')
        .populate('brand', 'name').limit(10 - products.length).lean();
      products = [...products, ...extra];
    }

    const showPrice = canSee(req, 'catalogue.priceView');
    const showStock = canSee(req, 'catalogue.stockView');

    const data = await Promise.all(products.map(async (product) => {
      let rate = null;
      try {
        if (branch) {
          const priced = await resolvePricing({
            branchId: branch, dealerId: dealer._id, product, quantity: 1, pricingDate: new Date(),
          });
          // For related products: show pricingRate (before discount mapping)
          rate = money(priced.pricingRate);
        }
      } catch { /* pricing is best-effort here */ }
      return shapeCatalogueItem({
        _id: product._id,
        productCode: product.productCode,
        itemName: product.itemName,
        brand: product.brand?.name || '',
        tileSize: product.tileSize || '',
        finish: product.finish || '',
        unit: product.unit || 'Box',
        image: product.images?.[0] || '',
        dealerRate: rate,
        ...mrpSaving(product.mrp, rate),
      }, { showPrice, showStock });
    }));

    res.json({ success: true, data });
  } catch (error) { sendError(res, error); }
});

// ── Points & rewards (17.6 / 14) ─────────────────────────────────────────────
/**
 * Which gifts a dealer may see and claim.
 * A gift with no branch is global; a branch-scoped gift is only offered to
 * dealers of that branch. dealerTypes empty means "open to every dealer type".
 */
function giftVisibilityFilter(dealerTypeId, branch, now = new Date()) {
  const and = [
    { $or: [{ validFrom: null }, { validFrom: { $exists: false } }, { validFrom: { $lte: now } }] },
    { $or: [{ validTo: null }, { validTo: { $exists: false } }, { validTo: { $gte: now } }] },
    {
      $or: [
        { dealerTypes: { $size: 0 } },
        { dealerTypes: { $exists: false } },
        ...(dealerTypeId ? [{ dealerTypes: dealerTypeId }] : []),
      ],
    },
  ];
  if (branch) {
    // Global gifts stay visible alongside this branch's own gifts.
    and.push({ $or: [{ branch: null }, { branch: { $exists: false } }, { branch }] });
  }
  return { status: 'active', $and: and };
}

// Aggregate the append-only ledger into a spendable balance. 'pending' entries
// are deliberately excluded from the balance — they are shown separately.
async function pointsSummary(dealerId, session = null) {
  const agg = DealerPointsLedger.aggregate([
    { $match: { dealer: new mongoose.Types.ObjectId(String(dealerId)) } },
    {
      $group: {
        _id: null,
        earned: { $sum: { $cond: [{ $eq: ['$entryType', 'earned'] }, '$points', 0] } },
        pending: { $sum: { $cond: [{ $eq: ['$entryType', 'pending'] }, '$points', 0] } },
        redeemed: { $sum: { $cond: [{ $eq: ['$entryType', 'redeemed'] }, '$points', 0] } },
        reversed: { $sum: { $cond: [{ $eq: ['$entryType', 'reversed'] }, '$points', 0] } },
        expired: { $sum: { $cond: [{ $eq: ['$entryType', 'expired'] }, '$points', 0] } },
        adjustment: {
          $sum: {
            $cond: [
              { $eq: ['$entryType', 'adjustment'] },
              { $multiply: ['$points', { $ifNull: ['$direction', 1] }] },
              0,
            ],
          },
        },
      },
    },
  ]);
  if (session) agg.session(session);
  const [row] = await agg;
  const earned = Number(row?.earned || 0);
  const pending = Number(row?.pending || 0);
  const redeemed = Number(row?.redeemed || 0);
  const reversed = Number(row?.reversed || 0);
  const expired = Number(row?.expired || 0);
  const adjustment = Number(row?.adjustment || 0);
  const balance = earned + reversed + adjustment - redeemed - expired;
  return { earned, pending, redeemed, reversed, expired, adjustment, balance: Math.max(0, balance) };
}

// GET /api/v1/dealer-app/points
router.get('/points', requireDealerPermission('points.view'), async (req, res) => {
  try {
    const [summary, entries] = await Promise.all([
      pointsSummary(req.dealer._id),
      DealerPointsLedger.find({ dealer: req.dealer._id })
        .sort({ entryDate: -1, createdAt: -1 }).limit(40)
        .select('entryType points direction description entryDate referenceNumber expiresAt')
        .lean(),
    ]);
    res.json({
      success: true,
      data: {
        summary,
        entries: entries.map(e => ({
          _id: e._id,
          entryType: e.entryType,
          points: Number(e.points || 0),
          direction: e.direction || 1,
          description: e.description || '',
          entryDate: e.entryDate,
          referenceNumber: e.referenceNumber || '',
          expiresAt: e.expiresAt || null,
        })),
      },
    });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/gifts — catalogue with affordability for this dealer
router.get('/gifts', requireDealerPermission('points.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const now = new Date();
    const dealerTypeId = dealer.dealerType?._id || dealer.dealerType;

    const filter = giftVisibilityFilter(dealerTypeId, branch, now);

    const [gifts, summary] = await Promise.all([
      Gift.find(filter).sort({ pointsRequired: 1 })
        .select('giftCode name description category pointsRequired approxValue images stockQty claimedQty validTo')
        .lean(),
      pointsSummary(dealer._id),
    ]);

    res.json({
      success: true,
      data: gifts.map(g => {
        const unlimited = g.stockQty === null || g.stockQty === undefined;
        const remaining = unlimited ? null : Math.max(0, Number(g.stockQty) - Number(g.claimedQty || 0));
        return {
          _id: g._id,
          giftCode: g.giftCode,
          name: g.name,
          description: g.description || '',
          category: g.category || '',
          pointsRequired: Number(g.pointsRequired || 0),
          approxValue: money(g.approxValue || 0),
          image: g.images?.[0] || '',
          remaining,
          inStock: unlimited || remaining > 0,
          affordable: summary.balance >= Number(g.pointsRequired || 0),
          shortBy: Math.max(0, Number(g.pointsRequired || 0) - summary.balance),
          validTo: g.validTo || null,
        };
      }),
      summary,
    });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/gift-claims
router.get('/gift-claims', requireDealerPermission('points.view'), async (req, res) => {
  try {
    const data = await GiftClaim.find({ dealer: req.dealer._id })
      .sort({ createdAt: -1 }).limit(50)
      .select('claimNumber giftName giftImage quantity pointsSpent status reviewRemarks courierName trackingNumber dispatchedAt deliveredAt createdAt')
      .lean();
    res.json({ success: true, data });
  } catch (error) { sendError(res, error); }
});

// POST /api/v1/dealer-app/gift-claims  { gift, quantity?, deliveryAddress?, remarks? }
// Debits points inside a transaction so the same points can never fund two claims.
router.post('/gift-claims', requireDealerPermission('points.view'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const dealer = req.dealer;
    const branch = await resolveDealerBranch(dealer);
    const giftId = req.body?.gift;
    if (!mongoose.isValidObjectId(giftId)) throw appError(422, 'Select a gift to claim.');
    const quantity = Math.max(1, parseInt(req.body?.quantity, 10) || 1);

    const dealerTypeId = dealer.dealerType?._id || dealer.dealerType;

    let created;
    await session.withTransaction(async () => {
      // Re-check visibility, not just existence — a dealer must not be able to
      // claim another branch's gift by guessing its id.
      const gift = await Gift.findOne({
        _id: giftId,
        ...giftVisibilityFilter(dealerTypeId, branch),
      }).session(session);
      if (!gift) throw appError(404, 'This gift is not available for your account.');
      if (!gift.isAvailable()) throw appError(409, 'This gift is no longer available.');

      const unlimited = gift.stockQty === null || gift.stockQty === undefined;
      const remaining = unlimited ? Infinity : Number(gift.stockQty) - Number(gift.claimedQty || 0);
      if (quantity > remaining) {
        throw appError(409, `Only ${remaining} left. Please reduce the quantity.`);
      }

      const pointsPerUnit = Number(gift.pointsRequired || 0);
      const pointsSpent = pointsPerUnit * quantity;

      const summary = await pointsSummary(dealer._id, session);
      if (summary.balance < pointsSpent) {
        throw appError(
          409,
          `You need ${pointsSpent} points for this gift but have ${summary.balance}.`,
        );
      }

      const claimNumber = await generateUniqueCode(GiftClaim, 'claimNumber', 'GC-', 5);
      const [claim] = await GiftClaim.create([{
        claimNumber,
        branch: branch || undefined,
        dealer: dealer._id,
        dealerName: dealer.businessName,
        dealerCode: dealer.dealerCode || '',
        gift: gift._id,
        giftName: gift.name,
        giftImage: gift.images?.[0] || '',
        quantity,
        pointsPerUnit,
        pointsSpent,
        status: 'pending',
        deliveryAddress: String(req.body?.deliveryAddress || dealer.deliveryAddress || dealer.address || '').slice(0, 500),
        dealerRemarks: String(req.body?.remarks || '').slice(0, 500),
        salesExecutive: dealer.assignedSalesExecutive?._id || dealer.assignedSalesExecutive || undefined,
        sourceKey: `gift-claim:${dealer._id}:${gift._id}:${Date.now()}`,
      }], { session });

      await DealerPointsLedger.create([{
        branch: branch || undefined,
        dealer: dealer._id,
        entryType: 'redeemed',
        points: pointsSpent,
        description: `Claimed ${quantity} × ${gift.name}`,
        giftClaim: claim._id,
        referenceNumber: claim.claimNumber,
        sourceKey: `redeem:${claim._id}`,
      }], { session });

      if (!unlimited) {
        await Gift.updateOne(
          { _id: gift._id },
          { $inc: { claimedQty: quantity } },
          { session },
        );
      }

      created = claim;
    });

    res.status(201).json({
      success: true,
      message: `Claim ${created.claimNumber} submitted. You'll be notified once it is approved.`,
      data: created,
    });
  } catch (error) {
    sendError(res, error);
  } finally {
    session.endSession();
  }
});

// POST /api/v1/dealer-app/gift-claims/:id/cancel — only while still pending
router.post('/gift-claims/:id/cancel', requireDealerPermission('points.view'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let updated;
    await session.withTransaction(async () => {
      const claim = await GiftClaim.findOne({
        _id: req.params.id, dealer: req.dealer._id,
      }).session(session);
      if (!claim) throw appError(404, 'Claim not found.');
      if (claim.status !== 'pending') {
        throw appError(409, 'Only claims that are still pending can be cancelled.');
      }

      claim.status = 'cancelled';
      if (!claim.pointsReversed) {
        await DealerPointsLedger.create([{
          branch: claim.branch,
          dealer: claim.dealer,
          entryType: 'reversed',
          points: claim.pointsSpent,
          description: `Cancelled claim ${claim.claimNumber} — points returned`,
          giftClaim: claim._id,
          referenceNumber: claim.claimNumber,
          sourceKey: `reverse:${claim._id}`,
        }], { session });
        claim.pointsReversed = true;
        await Gift.updateOne(
          { _id: claim.gift, claimedQty: { $gte: claim.quantity } },
          { $inc: { claimedQty: -claim.quantity } },
          { session },
        );
      }
      await claim.save({ session });
      updated = claim;
    });

    res.json({
      success: true,
      message: `Claim cancelled. ${updated.pointsSpent} points returned to your balance.`,
      data: updated,
    });
  } catch (error) {
    sendError(res, error);
  } finally {
    session.endSession();
  }
});

// ── Chat with the assigned sales executive (17.8) ─────────────────────────────
// GET /api/v1/dealer-app/messages?complaint=
router.get('/messages', requireDealerPermission('chat.view'), async (req, res) => {
  try {
    const filter = { dealer: req.dealer._id };
    if (mongoose.isValidObjectId(req.query.complaint)) filter.complaint = req.query.complaint;

    const rows = await DealerMessage.find(filter)
      .sort({ createdAt: 1 }).limit(300)
      .select('senderRole senderName body attachments createdAt readByDealerAt readByExecutiveAt complaint')
      .lean();

    // Opening the thread marks the executive's messages as read.
    await DealerMessage.updateMany(
      { dealer: req.dealer._id, senderRole: 'executive', readByDealerAt: null },
      { $set: { readByDealerAt: new Date() } },
    );

    const se = req.dealer.assignedSalesExecutive;
    res.json({
      success: true,
      data: rows,
      executive: se ? { name: se.name, phone: se.phone } : null,
    });
  } catch (error) { sendError(res, error); }
});

// GET /api/v1/dealer-app/messages/unread-count
router.get('/messages/unread-count', requireDealerPermission('chat.view'), async (req, res) => {
  try {
    const count = await DealerMessage.countDocuments({
      dealer: req.dealer._id, senderRole: 'executive', readByDealerAt: null,
    });
    res.json({ success: true, data: { count } });
  } catch (error) { sendError(res, error); }
});

// POST /api/v1/dealer-app/messages  { body, complaint? }
router.post('/messages', requireDealerPermission('chat.view'), async (req, res) => {
  try {
    const dealer = req.dealer;
    const body = String(req.body?.body || '').trim();
    if (!body) throw appError(422, 'Type a message to send.');
    if (body.length > 2000) throw appError(422, 'Message is too long (2000 characters max).');

    const seId = dealer.assignedSalesExecutive?._id || dealer.assignedSalesExecutive;
    if (!seId) {
      throw appError(409, 'No sales executive is assigned to your account yet. Please contact BDMTILES.');
    }
    const branch = await resolveDealerBranch(dealer);

    const message = await DealerMessage.create({
      branch: branch || undefined,
      dealer: dealer._id,
      senderRole: 'dealer',
      salesExecutive: seId,
      senderName: dealer.businessName,
      body,
      complaint: mongoose.isValidObjectId(req.body?.complaint) ? req.body.complaint : undefined,
      readByDealerAt: new Date(),
    });

    res.status(201).json({ success: true, data: message });
  } catch (error) { sendError(res, error); }
});

export default router;
