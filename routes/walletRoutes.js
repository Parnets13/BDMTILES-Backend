import { Router } from 'express';
import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import CustomerWallet from '../models/CustomerWallet.js';
import WalletTransaction from '../models/WalletTransaction.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { getOrCreateWallet, applyWalletTransaction } from '../services/walletService.js';

const router = Router();
router.use(protect);
router.use(requirePermission('wallet.manage'));

// GET /api/v1/wallets — list all wallets with customer info + balance
router.get('/', async (req, res) => {
  try {
    const { search, page = 1, limit = 30 } = req.query;
    const p = Math.max(1, parseInt(page, 10));
    const l = Math.min(100, parseInt(limit, 10) || 30);

    // Find matching customers first if search is given
    let customerFilter = {};
    if (search) {
      const regex = new RegExp(search, 'i');
      const customers = await Customer.find({
        $or: [{ name: regex }, { contactNumber: regex }],
      }).select('_id').lean();
      customerFilter = { customer: { $in: customers.map((c) => c._id) } };
    }

    const [wallets, total] = await Promise.all([
      CustomerWallet.find(customerFilter)
        .populate('customer', 'name contactNumber email city')
        .sort({ updatedAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      CustomerWallet.countDocuments(customerFilter),
    ]);

    res.json({
      success: true,
      data: wallets,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l) || 1, totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/wallets/:customerId — one customer's wallet + transactions
router.get('/:customerId', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId).select('name contactNumber email').lean();
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

    const wallet = await getOrCreateWallet(req.params.customerId);
    const transactions = await WalletTransaction.find({ customer: req.params.customerId })
      .sort({ createdAt: -1 }).limit(50).lean();

    res.json({ success: true, data: { customer, wallet, transactions } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/wallets/:customerId/credit — manually credit BDM Cash
router.post('/:customerId/credit', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const { amount, description } = req.body;
      if (!amount || Number(amount) <= 0) throw Object.assign(new Error('Amount must be positive.'), { status: 422 });

      // Ensure wallet exists
      await getOrCreateWallet(req.params.customerId, { session });

      result = await applyWalletTransaction({
        customerId: req.params.customerId,
        type: 'credit',
        amount: Number(amount),
        reason: 'manual_credit',
        description: String(description || '').trim(),
        createdBy: req.user._id,
        session,
      });
    });
    res.json({ success: true, message: `₹${result.transaction.amount} BDM Cash credited.`, data: result });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
});

// POST /api/v1/wallets/:customerId/debit — manually debit (correction / expiry)
router.post('/:customerId/debit', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const { amount, description, reason = 'manual_debit' } = req.body;
      if (!amount || Number(amount) <= 0) throw Object.assign(new Error('Amount must be positive.'), { status: 422 });

      result = await applyWalletTransaction({
        customerId: req.params.customerId,
        type: 'debit',
        amount: Number(amount),
        reason,
        description: String(description || '').trim(),
        createdBy: req.user._id,
        session,
      });
    });
    res.json({ success: true, message: `₹${result.transaction.amount} BDM Cash debited.`, data: result });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
});

// GET /api/v1/wallets/:customerId/transactions — full paginated transaction history
router.get('/:customerId/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ customer: req.params.customerId })
        .populate('referenceOrder', 'orderNumber')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WalletTransaction.countDocuments({ customer: req.params.customerId }),
    ]);
    res.json({
      success: true,
      data: transactions,
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit) || 1, totalItems: total, itemsPerPage: limit },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
