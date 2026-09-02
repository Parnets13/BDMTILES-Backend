import Invoice from '../models/Invoice.js';
import SalesOrder from '../models/SalesOrder.js';
import { roundMoney } from '../utils/pricingCalculations.js';

const withSession = (query, session) => (session ? query.session(session) : query);

export async function getDealerCreditExposure({ branchId, dealer, asOf = new Date(), session = null }) {
  if (!dealer) return null;
  const creditDays = Number(dealer.creditDays);
  const creditDaysValid = Number.isFinite(creditDays) && creditDays >= 0;
  if (!creditDaysValid) {
    return { creditDays, creditDaysValid: false, overdueInvoiceAmount: 0, overdueOrderAmount: 0, overdueAmount: 0, overdueCount: 0 };
  }

  const cutoff = new Date(asOf);
  cutoff.setDate(cutoff.getDate() - creditDays);
  const invoiceQuery = Invoice.find({
    branch: branchId,
    dealer: dealer._id,
    status: { $ne: 'cancelled' },
    balanceAmount: { $gt: 0 },
    $or: [{ dueDate: { $lt: asOf } }, { dueDate: null, invoiceDate: { $lt: cutoff } }],
  }).select('balanceAmount salesOrder').lean();
  const invoices = await withSession(invoiceQuery, session);
  const invoicedOrders = invoices.map(row => row.salesOrder).filter(Boolean);
  const orderQuery = SalesOrder.find({
    branch: branchId,
    dealer: dealer._id,
    _id: { $nin: invoicedOrders },
    status: { $nin: ['draft', 'cancelled', 'expired'] },
    balanceAmount: { $gt: 0 },
    orderDate: { $lt: cutoff },
  }).select('balanceAmount').lean();
  const orders = await withSession(orderQuery, session);
  const overdueInvoiceAmount = roundMoney(invoices.reduce((sum, row) => sum + Number(row.balanceAmount || 0), 0));
  const overdueOrderAmount = roundMoney(orders.reduce((sum, row) => sum + Number(row.balanceAmount || 0), 0));
  return {
    creditDays,
    creditDaysValid: true,
    overdueInvoiceAmount,
    overdueOrderAmount,
    overdueAmount: roundMoney(overdueInvoiceAmount + overdueOrderAmount),
    overdueCount: invoices.length + orders.length,
  };
}
