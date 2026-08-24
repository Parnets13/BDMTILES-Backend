import { Router } from 'express';
import Payment from '../models/Payment.js';
import SalesOrder from '../models/SalesOrder.js';
import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import { protect, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(protect);

// GET /api/v1/payments — list
router.get('/', requirePermission('payment'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, paymentType, status, paymentMode, dealer, supplier } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);
    let filter = {};
    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [{ paymentNumber: r }, { partyName: r }, { chequeNumber: r }, { transactionRef: r }];
    }
    if (paymentType) filter.paymentType = paymentType;
    if (status) filter.status = status;
    if (paymentMode) filter.paymentMode = paymentMode;
    if (dealer) filter.dealer = dealer;
    if (supplier) filter.supplier = supplier;

    const [payments, total] = await Promise.all([
      Payment.find(filter).sort({ paymentDate: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('supplier', 'companyName supplierCode')
        .lean(),
      Payment.countDocuments(filter),
    ]);
    res.json({ success: true, data: payments, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/payments/stats
router.get('/stats', requirePermission('payment'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [totalReceipts, totalPayments, todayReceipts, monthReceipts, pendingCheques] = await Promise.all([
      Payment.aggregate([{ $match: { paymentType: 'dealer_receipt', status: 'confirmed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.aggregate([{ $match: { paymentType: 'supplier_payment', status: 'confirmed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.aggregate([{ $match: { paymentType: 'dealer_receipt', status: 'confirmed', paymentDate: { $gte: today } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Payment.aggregate([{ $match: { paymentType: 'dealer_receipt', status: 'confirmed', paymentDate: { $gte: thisMonth } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Payment.countDocuments({ paymentMode: 'cheque', status: 'pending' }),
    ]);
    res.json({
      success: true,
      data: {
        totalReceipts: totalReceipts[0]?.total || 0,
        totalPayments: totalPayments[0]?.total || 0,
        todayReceipts: todayReceipts[0]?.total || 0,
        todayCount: todayReceipts[0]?.count || 0,
        monthReceipts: monthReceipts[0]?.total || 0,
        pendingCheques,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/payments/:id
router.get('/:id', requirePermission('payment'), async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('dealer', 'businessName dealerCode mobile city currentOutstanding')
      .populate('supplier', 'companyName supplierCode mobile')
      .lean();
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    res.json({ success: true, data: payment });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/v1/payments — record payment
router.post('/', requirePermission('payment'), async (req, res) => {
  try {
    const data = { ...req.body, createdBy: req.user._id };

    // Auto-generate payment number (safe against recycled records)
    const { generateUniqueCode } = await import('../utils/codeGenerator.js');
    const prefix = data.paymentType === 'dealer_receipt' ? 'RCP-' : 'PAY-';
    data.paymentNumber = await generateUniqueCode(Payment, 'paymentNumber', prefix, 5);

    // Set party name
    if (data.dealer) {
      const dealer = await Dealer.findById(data.dealer).lean();
      if (dealer) data.partyName = dealer.businessName;
    } else if (data.supplier) {
      const sup = await Supplier.findById(data.supplier).lean();
      if (sup) data.partyName = sup.companyName;
    }

    // Cheque starts as pending
    if (data.paymentMode === 'cheque') {
      data.status = 'pending';
    }

    data.tallySyncStatus = 'not_synced';
    const payment = await Payment.create(data);

    // Update dealer outstanding on confirmed receipt
    if (payment.status === 'confirmed' && payment.paymentType === 'dealer_receipt' && payment.dealer) {
      await Dealer.findByIdAndUpdate(payment.dealer, { $inc: { currentOutstanding: -payment.amount } });
    }

    // Update sales order payment status if allocated
    if (payment.status === 'confirmed' && payment.againstOrders?.length) {
      for (const ao of payment.againstOrders) {
        if (ao.orderModel === 'SalesOrder') {
          const so = await SalesOrder.findById(ao.order);
          if (so) {
            const paidAmount = (so.advanceAmount || 0) + ao.allocatedAmount;
            so.advanceAmount = paidAmount;
            so.balanceAmount = so.grandTotal - paidAmount;
            so.paymentStatus = so.balanceAmount <= 0 ? 'paid' : 'partial';
            await so.save();
          }
        }
      }
    }

    res.status(201).json({ success: true, message: 'Payment recorded.', data: payment });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/payments/:id/confirm — confirm cheque
router.patch('/:id/confirm', requirePermission('payment'), async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Not found.' });
    if (payment.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending payments can be confirmed.' });

    payment.status = 'confirmed';
    await payment.save();

    // Update dealer outstanding
    if (payment.paymentType === 'dealer_receipt' && payment.dealer) {
      await Dealer.findByIdAndUpdate(payment.dealer, { $inc: { currentOutstanding: -payment.amount } });
    }

    // Update supplier outstanding
    if (payment.paymentType === 'supplier_payment' && payment.supplier) {
      const Supplier = (await import('../models/Supplier.js')).default;
      await Supplier.findByIdAndUpdate(payment.supplier, { $inc: { currentOutstanding: -payment.amount } });
    }

    // Update SO payment status
    if (payment.againstOrders?.length) {
      for (const ao of payment.againstOrders) {
        if (ao.orderModel === 'SalesOrder') {
          const so = await SalesOrder.findById(ao.order);
          if (so) {
            so.advanceAmount = (so.advanceAmount || 0) + ao.allocatedAmount;
            so.balanceAmount = so.grandTotal - so.advanceAmount;
            so.paymentStatus = so.balanceAmount <= 0 ? 'paid' : 'partial';
            await so.save();
          }
        }
      }
    }

    res.json({ success: true, message: 'Payment confirmed.', data: payment });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/payments/:id/bounce — mark cheque bounced
router.patch('/:id/bounce', requirePermission('payment'), async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Not found.' });

    payment.status = 'bounced';
    payment.bounceReason = req.body.reason || '';
    payment.bounceCharges = req.body.charges || 0;
    await payment.save();

    // Reverse outstanding if was already confirmed
    if (payment.paymentType === 'dealer_receipt' && payment.dealer) {
      await Dealer.findByIdAndUpdate(payment.dealer, { $inc: { currentOutstanding: payment.amount + (payment.bounceCharges || 0) } });
    }

    res.json({ success: true, message: 'Payment marked as bounced.', data: payment });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/payments/dealer-orders/:dealerId — pending orders for allocation
router.get('/dealer-orders/:dealerId', requirePermission('payment'), async (req, res) => {
  try {
    const orders = await SalesOrder.find({
      dealer: req.params.dealerId,
      paymentStatus: { $in: ['pending', 'partial'] },
      status: { $nin: ['cancelled', 'draft'] },
    }).select('orderNumber orderDate grandTotal advanceAmount balanceAmount').sort({ orderDate: -1 }).lean();
    res.json({ success: true, data: orders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
