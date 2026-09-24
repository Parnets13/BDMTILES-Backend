import { Router } from 'express';
import Dealer from '../models/Dealer.js';
import Invoice from '../models/Invoice.js';
import Payment from '../models/Payment.js';
import { verifyDownloadToken } from '../utils/jwt.js';
import { streamInvoicePdf, streamReceiptPdf } from '../services/dealerPdfService.js';

/**
 * Dealer document downloads (SOW 17.5).
 *
 * These are deliberately NOT behind `protectDealer`: the URL is opened by the
 * device's browser / PDF viewer, which cannot attach an Authorization header.
 * Authorisation instead comes from a short-lived token that is bound to one
 * dealer AND one document, minted by an authenticated endpoint.
 *
 * Permission-wise this is a two-step chain: the mint endpoint
 * (`POST /dealer-app/invoices/:id/download-link`) requires `payments.view`, so an
 * employee the dealer has not granted that cannot obtain a token in the first
 * place. Revoking the permission does not retroactively kill a token already
 * minted, which is accepted: the token is bound to this dealer and this one
 * document, and expires in 5 minutes.
 */
const router = Router();

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const deny = (res, message = 'This download link is invalid or has expired.') =>
  res.status(401).json({ success: false, message });

async function authorise(req, res, docType) {
  const token = String(req.query.token || '');
  if (!token) return null;
  let decoded;
  try {
    decoded = verifyDownloadToken(token, docType, req.params.id);
  } catch {
    return null;
  }
  const dealer = await Dealer.findById(decoded.dealerId)
    .select('businessName dealerCode address city state pinCode gstin status appAccess')
    .lean();
  if (!dealer || dealer.status !== 'active' || !dealer.appAccess) return null;
  return dealer;
}

// GET /api/v1/dealer-downloads/invoices/:id.pdf?token=...
router.get('/invoices/:id.pdf', async (req, res) => {
  try {
    const dealer = await authorise(req, res, 'invoice');
    if (!dealer) return deny(res);

    const inv = await Invoice.findOne({ _id: req.params.id, dealer: dealer._id })
      .select('invoiceNumber invoiceDate dueDate status paymentStatus paidAmount balanceAmount grandTotal subtotal totalDiscount taxableTotal totalCgst totalSgst totalIgst totalTax freightCharges loadingCharges otherCharges roundOff isInterState orderNumber amountInWords items buyerName buyerGstin')
      .lean();
    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    return streamInvoicePdf(res, {
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      orderNumber: inv.orderNumber,
      amountInWords: inv.amountInWords,
      isInterState: Boolean(inv.isInterState),
      buyer: { name: inv.buyerName, gstin: inv.buyerGstin },
      totals: {
        subtotal: money(inv.subtotal),
        totalDiscount: money(inv.totalDiscount),
        taxableTotal: money(inv.taxableTotal),
        totalCgst: money(inv.totalCgst),
        totalSgst: money(inv.totalSgst),
        totalIgst: money(inv.totalIgst),
        freightCharges: money(inv.freightCharges),
        loadingCharges: money(inv.loadingCharges),
        roundOff: money(inv.roundOff),
        grandTotal: money(inv.grandTotal),
        paidAmount: money(inv.paidAmount),
        balanceAmount: money(inv.balanceAmount),
      },
      items: (inv.items || []).map((it) => ({
        productName: it.productName,
        hsnCode: it.hsnCode,
        unit: it.unit,
        quantity: Number(it.quantity || 0),
        rate: money(it.rate),
        gstPercentage: Number(it.gstPercentage || 0),
        totalAmount: money(it.totalAmount ?? it.lineTotal),
      })),
    }, dealer);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not generate the invoice PDF.' });
  }
});

// GET /api/v1/dealer-downloads/receipts/:id.pdf?token=...
router.get('/receipts/:id.pdf', async (req, res) => {
  try {
    const dealer = await authorise(req, res, 'receipt');
    if (!dealer) return deny(res);

    const r = await Payment.findOne({
      _id: req.params.id,
      dealer: dealer._id,
      paymentType: 'dealer_receipt',
    })
      .select('paymentNumber paymentDate amount paymentMode status bankName chequeNumber transactionRef againstOrders remarks')
      .lean();
    if (!r) return res.status(404).json({ success: false, message: 'Receipt not found.' });

    return streamReceiptPdf(res, {
      paymentNumber: r.paymentNumber,
      paymentDate: r.paymentDate,
      amount: money(r.amount),
      paymentMode: r.paymentMode,
      status: r.status,
      bankName: r.bankName,
      chequeNumber: r.chequeNumber,
      reference: r.transactionRef,
      against: (r.againstOrders || []).map((a) => a.orderNumber).filter(Boolean),
      remarks: r.remarks,
    }, dealer);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not generate the receipt PDF.' });
  }
});

export default router;
