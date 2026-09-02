import Invoice from '../models/Invoice.js';
import SalesOrder from '../models/SalesOrder.js';

const paymentError = (status, message) => Object.assign(new Error(message), { status });

function paymentState(paidAmount, balanceAmount) {
  if (balanceAmount <= 0.01) return 'paid';
  return paidAmount > 0.01 ? 'partial' : 'pending';
}

async function synchronizeSalesOrder(invoice, session) {
  if (!invoice.salesOrder) return;
  const paidAmount = Math.max(0, Number(invoice.paidAmount) || 0);
  const balanceAmount = Math.max(0, Number(invoice.balanceAmount) || 0);
  const result = await SalesOrder.updateOne(
    {
      _id: invoice.salesOrder,
      branch: invoice.branch,
      dealer: invoice.dealer,
      status: { $ne: 'cancelled' },
    },
    {
      $set: {
        advanceAmount: paidAmount,
        balanceAmount,
        paymentStatus: paymentState(paidAmount, balanceAmount),
      },
    },
    { session }
  );
  if (!result.matchedCount) {
    throw paymentError(409, 'The linked Sales Order is unavailable for payment synchronization.');
  }
}

export async function applyDealerInvoiceAllocation({ invoiceId, branch, dealer, amount, session }) {
  const allocatedAmount = Number(amount);
  const invoice = await Invoice.findOneAndUpdate(
    {
      _id: invoiceId,
      branch,
      dealer,
      status: { $ne: 'cancelled' },
      balanceAmount: { $gte: allocatedAmount },
    },
    { $inc: { paidAmount: allocatedAmount, balanceAmount: -allocatedAmount } },
    { new: true, session }
  );
  if (!invoice) throw paymentError(409, 'An invoice balance changed before the payment could be applied.');

  invoice.paidAmount = Math.max(0, Number(invoice.paidAmount) || 0);
  invoice.balanceAmount = Number(invoice.balanceAmount) <= 0.01 ? 0 : Number(invoice.balanceAmount);
  invoice.paymentStatus = paymentState(invoice.paidAmount, invoice.balanceAmount);
  await invoice.save({ session });
  await synchronizeSalesOrder(invoice, session);
  return invoice;
}

export async function reverseDealerInvoiceAllocation({ invoiceId, branch, dealer, amount, session }) {
  const allocatedAmount = Number(amount);
  const invoice = await Invoice.findOne({
    _id: invoiceId,
    branch,
    dealer,
    status: { $ne: 'cancelled' },
  }).session(session);
  if (!invoice) throw paymentError(409, 'An allocated invoice no longer exists.');
  if (Number(invoice.paidAmount) + 0.01 < allocatedAmount) {
    throw paymentError(409, 'Invoice paid amount is lower than the payment allocation being reversed.');
  }

  invoice.paidAmount = Math.max(0, Number(invoice.paidAmount) - allocatedAmount);
  invoice.balanceAmount = Math.min(Number(invoice.grandTotal), Number(invoice.balanceAmount) + allocatedAmount);
  invoice.paymentStatus = paymentState(invoice.paidAmount, invoice.balanceAmount);
  await invoice.save({ session });
  await synchronizeSalesOrder(invoice, session);
  return invoice;
}
