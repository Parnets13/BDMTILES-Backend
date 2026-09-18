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
  totalTax: order.totalTax,
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
});

// A website customer can only order stock that is actually available. The reservation in
// reserveSalesOrderInventory is the real authority (it moves availableQty -> reservedQty
// under a guard), but its error names only the product. This pre-check reads the same
// stock key the reservation will target — branch + warehouse + shade + batch — and reports
// exactly how much is left, so the storefront can tell the customer what to do.
const assertOnlineStockAvailable = async (items, { branchId, session }) => {
  // Aggregate the cart by stock key first: two lines of the same product must be
  // checked against their combined quantity, not individually.
  const required = new Map();
  for (const item of items) {
    const key = [item.product, item.warehouse, item.shade || '', item.batch || ''].map(String).join('|');
    const current = required.get(key);
    if (current) current.quantity += Number(item.quantity || 0);
    else required.set(key, {
      product: item.product,
      warehouse: item.warehouse,
      shade: item.shade || '',
      batch: item.batch || '',
      productName: item.productName || item.productCode || 'item',
      quantity: Number(item.quantity || 0),
    });
  }

  const rows = await Stock.find({
    branch: branchId,
    $or: [...required.values()].map(({ product, warehouse, shade, batch }) => ({ product, warehouse, shade, batch })),
  }).select('product warehouse shade batch availableQty').session(session).lean();

  const availableByKey = new Map(rows.map((row) => [
    [row.product, row.warehouse, row.shade || '', row.batch || ''].map(String).join('|'),
    Number(row.availableQty || 0),
  ]));

  const shortfalls = [];
  for (const [key, need] of required) {
    const available = availableByKey.get(key) || 0;
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
      const productIds = rawItems.map((i) => i.productId).filter(mongoose.isValidObjectId);
      const products = await Product.find({ _id: { $in: productIds }, status: 'active', onlineVisible: true })
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

      // Auto-assign the default (first active) warehouse for the online branch to any
      // item that has no warehouse set — customers don't pick a warehouse.
      const defaultWarehouse = await Warehouse.findOne({ branch: branchId, status: 'active' })
        .sort({ type: 1, createdAt: 1 }) // prefer 'main' type first (alphabetically 'main' < 'transit')
        .select('_id')
        .session(session)
        .lean();
      if (!defaultWarehouse) {
        throw Object.assign(new Error('Online ordering is temporarily unavailable. Please try again later.'), { status: 503 });
      }
      priced.items.forEach((item) => {
        if (!item.warehouse) item.warehouse = defaultWarehouse._id;
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
