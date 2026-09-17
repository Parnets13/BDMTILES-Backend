import { Router } from 'express';
import mongoose from 'mongoose';
import CustomerWallet from '../../models/CustomerWallet.js';
import WalletTransaction from '../../models/WalletTransaction.js';
import { protectCustomer } from '../../middleware/customerAuth.js';
import { getOrCreateWallet, applyWalletTransaction } from '../../services/walletService.js';

const router = Router();
router.use(protectCustomer);

// GET /api/v1/shop/wallet — current customer's balance + summary
router.get('/', async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.customer._id);
    res.json({
      success: true,
      data: {
        balance: wallet.balance,
        totalEarned: wallet.totalEarned,
        totalRedeemed: wallet.totalRedeemed,
        status: wallet.status,
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/wallet/transactions — paginated transaction history
router.get('/transactions', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);

    const wallet = await CustomerWallet.findOne({ customer: req.customer._id }).lean();
    if (!wallet) {
      return res.json({ success: true, data: [], pagination: { currentPage: 1, totalPages: 0, totalItems: 0 } });
    }

    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ wallet: wallet._id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({ wallet: wallet._id }),
    ]);

    res.json({
      success: true,
      data: transactions.map((t) => ({
        id: t._id,
        type: t.type,
        amount: t.amount,
        balanceAfter: t.balanceAfter,
        reason: t.reason,
        description: t.description || '',
        referenceOrder: t.referenceOrder || null,
        createdAt: t.createdAt,
      })),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit) || 1,
        totalItems: total,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/shop/wallet/topup — directly credit BDM Cash to the customer's wallet
// (No payment gateway — trust-based: customer adds money, balance goes up immediately)
router.post('/topup', async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount < 1) {
        throw Object.assign(new Error('Enter a valid amount (min ₹1).'), { status: 422 });
      }
      const note = String(req.body?.note || '').trim();

      // Ensure wallet exists before crediting
      await getOrCreateWallet(req.customer._id, { session });

      result = await applyWalletTransaction({
        customerId: req.customer._id,
        type: 'credit',
        amount,
        reason: 'manual_credit',
        description: note || 'Wallet top-up by customer',
        session,
      });
    });

    res.json({
      success: true,
      message: `₹${result.transaction.amount.toLocaleString('en-IN')} added to your BDM Cash wallet.`,
      data: {
        balance: result.wallet.balance,
        amount: result.transaction.amount,
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
});

// POST /api/v1/shop/wallet/topup-request — legacy: customer requests a top-up (kept for reference)
router.post('/topup-request', async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(422).json({ success: false, message: 'Enter a valid amount (min ₹1).' });
    }
    await getOrCreateWallet(req.customer._id);
    res.json({
      success: true,
      message: `Top-up request of ₹${amount} submitted. Our team will credit it after payment verification.`,
      data: { amount },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
