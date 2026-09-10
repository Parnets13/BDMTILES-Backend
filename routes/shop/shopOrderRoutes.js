import { Router } from 'express';
import mongoose from 'mongoose';
import SalesOrder from '../../models/SalesOrder.js';
import Product from '../../models/Product.js';
import Customer from '../../models/Customer.js';
import Delivery from '../../models/Delivery.js';
import { deriveOrderPricing } from '../../services/orderPricingService.js';
import { generateBranchNumber } from '../../utils/branchSequence.js';
import { reserveSalesOrderInventory } from '../../utils/salesOrderInventory.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';
import { protectCustomer } from '../../middleware/customerAuth.js';

const router = Router();
router.use(protectCustomer);

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

      // Reuse the same authoritative pricing engine the CRM uses, with walk-in/online scope.
      const priced = await deriveOrderPricing({
        branchId,
        scope: 'walk_in',
        orderType: 'online',
        pricingDate: new Date(),
        items,
        session,
      });

      // Online orders never need staff pricing approval; drop any below-minimum flags.
      const orderNumber = await generateBranchNumber(branchId, 'salesOrder', new Date(), { session });

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

      // Reserve inventory exactly like a confirmed CRM order.
      await reserveSalesOrderInventory(order, { session });

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

// GET /api/v1/shop/orders/:orderNumber — single order tracking (scoped to this customer)
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
