import mongoose from 'mongoose';
import CustomerWallet from '../models/CustomerWallet.js';
import WalletTransaction from '../models/WalletTransaction.js';

const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Get or create the wallet for a customer.
 * Pass an optional mongoose session for transaction safety.
 */
export async function getOrCreateWallet(customerId, { session = null } = {}) {
  let wallet = await CustomerWallet.findOne({ customer: customerId })
    .session(session).lean();
  if (!wallet) {
    const [created] = await CustomerWallet.create(
      [{ customer: customerId, balance: 0, totalEarned: 0, totalRedeemed: 0 }],
      session ? { session } : {}
    );
    wallet = created.toObject ? created.toObject() : created;
  }
  return wallet;
}

/**
 * Credit or debit the wallet atomically.
 * Returns the updated wallet and the new transaction.
 */
export async function applyWalletTransaction({
  customerId,
  type,          // 'credit' | 'debit'
  amount,
  reason,
  description = '',
  referenceOrder = null,
  createdBy = null,
  expiresAt = null,
  session = null,
}) {
  const amt = round(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw Object.assign(new Error('Amount must be positive.'), { status: 422 });

  const walletDoc = await CustomerWallet.findOne({ customer: customerId }).session(session);
  if (!walletDoc) throw Object.assign(new Error('Wallet not found.'), { status: 404 });

  if (type === 'debit') {
    if (walletDoc.balance < amt) throw Object.assign(new Error('Insufficient BDM Cash balance.'), { status: 422, code: 'INSUFFICIENT_BALANCE' });
    walletDoc.balance = round(walletDoc.balance - amt);
    walletDoc.totalRedeemed = round(walletDoc.totalRedeemed + amt);
  } else {
    walletDoc.balance = round(walletDoc.balance + amt);
    walletDoc.totalEarned = round(walletDoc.totalEarned + amt);
  }

  await walletDoc.save({ session });

  const [txn] = await WalletTransaction.create(
    [{
      customer: customerId,
      wallet: walletDoc._id,
      type,
      amount: amt,
      balanceAfter: walletDoc.balance,
      reason,
      description,
      referenceOrder: referenceOrder || undefined,
      createdBy: createdBy || undefined,
      expiresAt: expiresAt || undefined,
    }],
    session ? { session } : {}
  );

  return { wallet: walletDoc.toObject(), transaction: txn.toObject() };
}
