import { Router } from 'express';
import mongoose from 'mongoose';
import SalesOrder from '../../models/SalesOrder.js';
import Product from '../../models/Product.js';
import Stock from '../../models/Stock.js';
import Customer from '../../models/Customer.js';
import Delivery from '../../models/Delivery.js';
import Warehouse from '../../models/Warehouse.js';
import { deriveOrderPricing } from '../../services/orderPricingService.js';
import { generateBranchNumber } from '../../utils/branchSequence.js';
import { reserveSalesOrderInventory, QUANTITY_TOLERANCE } from '../../utils/salesOrderInventory.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';
import { protectCustomer } from '../../middleware/customerAuth.js';

const router = Router();
router.use(protectCustomer);

// How long an unpaid website order may hold its stock. Two days gives the team
// time to call and confirm without letting abandoned orders sit on inventory.
const ONLINE_RESERVATION_TTL_HOURS = Number(process.env.ONLINE_RESERVATION_TTL_HOURS || 48);

// Customer-facing tracking view of a SalesOrder + its Delivery.
const toTracking = (order, delivery) => ({
  orderNumber: order.orderNumber,
  status: order.status,
  paymentStatus: order.paymentStatus,
  orderDate: order.orderDate,
  expectedDeliveryDate: order.expectedDeliveryDate || null,
  deliveryAddress: order.deliveryAddress || '',
  grandTotal: order.grandTotal,
  subtotal: order.subtotal,
  totalDiscount: order.totalDiscount,
  totalSchemeDiscount: order.totalSchemeDiscount,
  totalTax: order.totalTax,
  freightCharges: order.freightCharges,
  loadingCharges: order.loadingCharges,
  installationCharges: order.installationCharges,
  otherCharges: order.otherCharges,
  roundOff: order.roundOff,
  items: (order.items || []).map((it) => ({
    productId: it.product,
    name: it.productName,
    image: it.productImage || '',
    quantity: it.quantity,
    unit: it.unit,
    boxes: it.boxes,
    sqft: it.sqft,
    rate: it.rate,
    totalAmount: it.totalAmount,
  })),
  delivery: delivery
    ? {
        status: delivery.status,
        deliveryNumber: delivery.deliveryNumber,
        // OTP shown to the customer so they can confirm receipt at the door.
        otp: ['assigned', 'in_transit', 'reached'].includes(delivery.status) ? delivery.otp || null : null,
        deliveryDate: delivery.deliveryDate || null,
      }
    : null,
  cancellationReason: order.cancellationReason,
});

// A website customer can only order stock that is actually available. The reservation in
// reserveSalesOrderInventory is the real authority (it moves availableQty -> reservedQty
// under a guard), but its error names only the product. This pre-check mirrors the admin
// stockMovementService#getStockSummary logic — stock is scoped to the online branch and
// summed across ALL warehouses, ALL shades, and ALL batches.  It must match
// onlineAvailability in shopProductRoutes exactly so the storefront, cart, and checkout
// all agree on how much is left.
const assertOnlineStockAvailable = async (items, { branchId, session }) => {
  // Aggregate requested quantities by product (ignore warehouse/shade/batch here —
  // the storefront never exposes those to the customer).
  const required = new Map();
  for (const item of items) {
    const id = String(item.product);
    const current = required.get(id);
    if (current) current.quantity += Number(item.quantity || 0);
    else required.set(id, {
      product: item.product,
      productName: item.productName || item.productCode || 'item',
      quantity: Number(item.quantity || 0),
    });
  }

  const requiredProductIds = [...required.values()].map((v) => v.product);
  const normalizedIds = requiredProductIds.map((id) =>
    (typeof id === 'string' && mongoose.isValidObjectId(id))
      ? new mongoose.Types.ObjectId(id)
      : id,
  );
  const rows = await Stock.aggregate([
      {
        $match: {
          branch: branchId,
          product: { $in: normalizedIds },
        },
      },
      {
        $group: {
          _id: '$product',
          availableQty: {
            $sum: {
              $max: [0, { $ifNull: ['$availableQty', 0] }],
            },
          },
        },
      },
    ]).session(session);

  const availableByProduct = new Map(rows.map((row) => [
    String(row._id),
    Number(row.availableQty || 0),
  ]));

  const shortfalls = [];
  for (const need of required.values()) {
    const available = availableByProduct.get(String(need.product)) || 0;
    if (need.quantity - available > QUANTITY_TOLERANCE) {
      shortfalls.push({ productName: need.productName, requested: need.quantity, available: Math.max(0, available) });
    }
  }
  if (shortfalls.length) {
    const detail = shortfalls
      .map((s) => (s.available > 0
        ? `${s.productName}: only ${s.available} available (you asked for ${s.requested})`
        : `${s.productName}: out of stock`))
      .join('; ');
    throw Object.assign(new Error(`Some items are no longer available. ${detail}.`), {
      status: 409,
      code: 'INSUFFICIENT_STOCK',
      shortfalls,
    });
  }
};

// POST /api/v1/shop/orders
// body: { items:[{ productId, quantity(boxes) }], deliveryAddress, name?, notes? }
router.post('/', async (req, res) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rawItems.length === 0) {
    return res.status(422).json({ success: false, message: 'Your cart is empty.' });
  }
  const deliveryAddress = String(req.body?.deliveryAddress || req.customer.deliveryAddress || '').trim();
  if (!deliveryAddress) {
    return res.status(422).json({ success: false, message: 'A delivery address is required.' });
  }

  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      const branchId = await getOnlineBranchId();

      // Validate products are online-visible; the server owns pricing (never trust client rates).
      const submittedProductIds = rawItems.map((i) => i.productId).filter(mongoose.isValidObjectId);
      const products = await Product.find({ _id: { $in: submittedProductIds }, status: 'active', onlineVisible: true })
        .select('_id')
        .session(session)
        .lean();
      const allowed = new Set(products.map((p) => String(p._id)));

      const items = rawItems.map((i, index) => {
        if (!mongoose.isValidObjectId(i.productId) || !allowed.has(String(i.productId))) {
          throw Object.assign(new Error(`Item ${index + 1} is not available online.`), { status: 422 });
        }
        const quantity = Number(i.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw Object.assign(new Error(`Item ${index + 1} has an invalid quantity.`), { status: 422 });
        }
        return { product: i.productId, quantity, unit: 'Box' };
      });

      // Reuse the same authoritative pricing engine the CRM uses, with walk-in/online
      // scope. The website sells at MRP, so the tier is pinned: a walk-in resolution
      // otherwise lands on retailRate and the customer would be charged something
      // other than the price they were shown.
      const priced = await deriveOrderPricing({
        branchId,
        scope: 'walk_in',
        orderType: 'online',
        preferredTier: 'mrp',
        pricingDate: new Date(),
        items,
        session,
      });

      // Online orders never need staff pricing approval; drop any below-minimum flags.
      const orderNumber = await generateBranchNumber(branchId, 'salesOrder', new Date(), { session });

      // Website customers never pick a warehouse, shade, or batch. We need to
      // assign a concrete stock bucket (warehouse + shade + batch) per item so
      // the reservation engine `reserveSalesOrderInventory` can move qty from
      // `availableQty` -> `reservedQty`.  Strategy mirrors admin StockPage:
      //
      //   1. Consider every warehouse in the online branch (matches the
      //      aggregation used by `assertOnlineStockAvailable` above AND by the
      //      shopProductRoutes `onlineAvailability` helper — so numbers always
      //      agree between the list/detail/cart/checkout views).
      //   2. For every product, pick the bucket (warehouse + shade + batch)
      //      with the largest `availableQty` so reservations prefer full bins.
      //   3. If a product truly has no bucket with stock anywhere, fall back
      //      to the earliest-created warehouse with empty shade/batch so the
      //      final reservation guard still runs and errors properly.
      const branchWarehouses = await Warehouse.find({ branch: branchId })
        .sort({ type: 1, createdAt: 1 })
        .select('_id')
        .session(session)
        .lean();
      if (!branchWarehouses.length) {
        throw Object.assign(new Error('Online ordering is temporarily unavailable. Please try again later.'), { status: 503 });
      }
      const fallbackWarehouse = branchWarehouses[0]._id;
      const productIds = priced.items.map((i) => i.product);
      const normalizedIds = productIds.map((id) =>
        (typeof id === 'string' && mongoose.isValidObjectId(id))
          ? new mongoose.Types.ObjectId(id)
          : id,
      );
      const warehouseIds = branchWarehouses.map((w) => w._id);

      // Rank all buckets (warehouse + shade + batch) by availableQty for the
      // products in this order, then take the single best bucket per product.
      const bestBuckets = await Stock.aggregate([
        {
          $match: {
            branch: branchId,
            warehouse: { $in: warehouseIds },
            product: { $in: normalizedIds },
            availableQty: { $gt: 0 },
          },
        },
        { $sort: { availableQty: -1, updatedAt: -1 } },
        {
          $group: {
            _id: '$product',
            warehouse: { $first: '$warehouse' },
            shade: { $first: '$shade' },
            batch: { $first: '$batch' },
          },
        },
      ]).session(session);

      const bucketByProduct = new Map(
        bestBuckets.map((b) => [
          String(b._id),
          {
            warehouse: b.warehouse,
            shade: b.shade || '',
            batch: b.batch || '',
          },
        ]),
      );

      // Apply bucket assignment to each priced item. Explicitly-provided
      // warehouse/shade/batch (e.g. future features) are never overwritten.
      priced.items.forEach((item) => {
        const assigned = bucketByProduct.get(String(item.product));
        if (assigned) {
          if (!item.warehouse) item.warehouse = assigned.warehouse;
          if (!item.shade) item.shade = assigned.shade;
          if (!item.batch) item.batch = assigned.batch;
        } else {
          // No warehouse has stock; reservation step will still surface this.
          // Use the earliest-created warehouse + empty shade/batch so the
          // reservation guard runs against a deterministic valid key.
          if (!item.warehouse) item.warehouse = fallbackWarehouse;
          if (!item.shade) item.shade = '';
          if (!item.batch) item.batch = '';
        }
      });

      // A website customer can only buy what is actually on the shelf. Check availability
      // up front so the shortfall can be named per item, instead of surfacing the generic
      // reservation guard error. The reservation below is still the authority — this is
      // only here to give the customer a useful message.
      await assertOnlineStockAvailable(priced.items, { branchId, session });

      [order] = await SalesOrder.create([{
        orderNumber,
        branch: branchId,
        orderDate: new Date(),
        customerName: (req.body?.name || req.customer.name || '').trim(),
        customerPhone: req.customer.contactNumber,
        orderType: 'online',
        items: priced.items,
        subtotal: priced.subtotal,
        totalDiscount: priced.totalDiscount,
        totalSchemeDiscount: priced.totalSchemeDiscount,
        totalTax: priced.totalTax,
        freightCharges: priced.freightCharges,
        loadingCharges: priced.loadingCharges,
        installationCharges: priced.installationCharges,
        otherCharges: priced.otherCharges,
        roundOff: priced.roundOff,
        grandTotal: priced.grandTotal,
        balanceAmount: priced.grandTotal,
        paymentStatus: 'pending', // COD-style: collected at delivery
        deliveryAddress,
        status: 'confirmed',
        confirmationRequested: true,
        approvalStatus: 'not_required',
        remarks: `Online order placed by ${req.customer.contactNumber}.${req.body?.notes ? ` Note: ${String(req.body.notes).trim()}` : ''}`,
        tallySyncStatus: 'not_synced',
      }], { session });

      // Reserve inventory exactly like a confirmed CRM order. This must NOT be swallowed:
      // a website order is a real reservation against real stock, so if it cannot be
      // reserved the whole transaction aborts and no order is created. Letting the order
      // through unreserved would sell stock that does not exist and leave the warehouse
      // holding an order it cannot fulfil.
      // Nothing is paid up front on a website order, so the reservation gets a
      // deadline. If the order is not confirmed within it, the expiry sweeper
      // puts the stock back and cancels the order, otherwise a few abandoned
      // carts could hold the whole shelf indefinitely.
      await reserveSalesOrderInventory(order, {
        session,
        expiresInHours: ONLINE_RESERVATION_TTL_HOURS,
      });

      // Keep the customer's default delivery address fresh for next time.
      await Customer.updateOne(
        { _id: req.customer._id },
        { $set: { deliveryAddress, lastPurchaseDate: new Date() } },
        { session }
      );
    });

    return res.status(201).json({
      success: true,
      message: 'Order placed.',
      data: { orderNumber: order.orderNumber, status: order.status, grandTotal: order.grandTotal },
    });
  } catch (error) {
    return res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({
      success: false,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      // Per-item shortfall so the cart can show what to reduce, not just a banner.
      ...(Array.isArray(error.shortfalls) ? { shortfalls: error.shortfalls } : {}),
      message: error.message,
    });
  } finally {
    await session.endSession();
  }
});

// GET /api/v1/shop/orders — this customer's orders (scoped by phone)
router.get('/', async (req, res) => {
  try {
    const orders = await SalesOrder.find({ orderType: 'online', customerPhone: req.customer.contactNumber })
      .sort({ orderDate: -1 })
      .limit(100)
      .lean();

    const deliveries = await Delivery.find({ salesOrder: { $in: orders.map((o) => o._id) } })
      .select('salesOrder status deliveryNumber otp deliveryDate')
      .lean();
    const deliveryByOrder = new Map(deliveries.map((d) => [String(d.salesOrder), d]));

    return res.json({
      success: true,
      data: orders.map((o) => toTracking(o, deliveryByOrder.get(String(o._id)))),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/orders/by-number?orderNumber=SO/BLR001/...
// Uses a query param instead of a path param so slashes in the order number don't break routing.
router.get('/by-number', async (req, res) => {
  try {
    const orderNumber = String(req.query.orderNumber || '').trim();
    if (!orderNumber) return res.status(422).json({ success: false, message: 'orderNumber is required.' });

    const order = await SalesOrder.findOne({
      orderNumber,
      orderType: 'online',
      customerPhone: req.customer.contactNumber,
    }).lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    const delivery = await Delivery.findOne({ salesOrder: order._id })
      .select('status deliveryNumber otp deliveryDate')
      .lean();

    return res.json({ success: true, data: toTracking(order, delivery) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/orders/:orderNumber — kept for backward compat (simple IDs without slashes)
router.get('/:orderNumber', async (req, res) => {
  try {
    const order = await SalesOrder.findOne({
      orderNumber: req.params.orderNumber,
      orderType: 'online',
      customerPhone: req.customer.contactNumber,
    }).lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    const delivery = await Delivery.findOne({ salesOrder: order._id })
      .select('status deliveryNumber otp deliveryDate')
      .lean();

    return res.json({ success: true, data: toTracking(order, delivery) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
