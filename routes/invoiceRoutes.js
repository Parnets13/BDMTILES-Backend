import { Router } from 'express';
import Invoice from '../models/Invoice.js';
import SalesOrder from '../models/SalesOrder.js';
import DispatchTrip from '../models/DispatchTrip.js';
import PickList from '../models/PickList.js';
import Payment from '../models/Payment.js';
import SalesReturn from '../models/SalesReturn.js';
import BranchSettings from '../models/BranchSettings.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { gstStateMatchesCode, isKnownGstStateCode } from '../utils/gstJurisdiction.js';
import { QUANTITY_TOLERANCE } from '../utils/salesOrderInventory.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

// Number to words (Indian format)
function numberToWords(num) {
  if (num === 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const convert = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convert(n % 100) : '');
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '');
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '');
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '');
  };
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  let result = convert(rupees) + ' Rupees';
  if (paise > 0) result += ' and ' + convert(paise) + ' Paise';
  return result + ' Only';
}

// GET /api/v1/invoices — list invoices
router.get('/', requirePermission('invoice'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, invoiceType, dealer, dateFrom, dateTo } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, parseInt(limit) || 20);

    let filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ invoiceNumber: regex }, { buyerName: regex }, { buyerCode: regex }, { orderNumber: regex }];
    }
    if (status) filter.status = status;
    if (invoiceType) filter.invoiceType = invoiceType;
    if (dealer) filter.dealer = dealer;
    if (dateFrom || dateTo) {
      filter.invoiceDate = {};
      if (dateFrom) filter.invoiceDate.$gte = new Date(dateFrom);
      if (dateTo) filter.invoiceDate.$lte = new Date(dateTo);
    }

    const [invoices, total] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('dealer', 'businessName dealerCode')
        .populate('createdBy', 'name')
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    res.json({ success: true, data: invoices, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/v1/invoices/stats
router.get('/stats', requirePermission('invoice'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, generated, sent, cancelled, totalValue] = await Promise.all([
      Invoice.countDocuments(scope),
      Invoice.countDocuments({ ...scope, status: 'generated' }),
      Invoice.countDocuments({ ...scope, status: 'sent' }),
      Invoice.countDocuments({ ...scope, status: 'cancelled' }),
      Invoice.aggregate([{ $match: { ...scope, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
    ]);
    res.json({ success: true, data: { total, generated, sent, cancelled, totalValue: totalValue[0]?.total || 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Sorting List → invoice handoff ────────────────────────────────────────────
// Feeds the "Create Invoice" dropdown. A pick list enters it exactly when the
// Sorting List starts showing the "Pack" action — i.e. sorting was verified and
// completed (status `sorted`) — and stays until it is invoiced. Sorting posts the
// authoritative quantities (short/damage movements), so that is the first point
// an invoice can be raised from; packing only records physical box counts.
// A row is billable from `sorted` onwards; dispatch removes it from this queue.
const SORTING_PIPELINE = ['sorted', 'packed', 'ready_for_dispatch'];
const PICK_STAGE_RANK = { sorted: 2, packed: 3, ready_for_dispatch: 4 };
const PICK_STAGE_LABEL = {
  sorted: 'Sorted',
  packed: 'Packed',
  ready_for_dispatch: 'Ready for dispatch',
};

router.get('/pending-orders', requirePermission('invoice'), async (req, res) => {
  try {
    const { search = '', limit = 200 } = req.query;

    const invoiced = await Invoice.find({ branch: req.branchId, status: { $ne: 'cancelled' } })
      .select('salesOrder').lean();
    const invoicedIds = new Set(invoiced.map(row => String(row.salesOrder)).filter(Boolean));

    // The sorting queue is the whole candidate set.
    const pickLists = await PickList.find({ branch: req.branchId, status: { $in: SORTING_PIPELINE } })
      .select('salesOrder pickListNumber status totalBoxes totalPickedQty deliveryRoute items.salesOrderItem items.sortedQty items.pickedQty')
      .lean();
    const liveLists = pickLists.filter(list => !invoicedIds.has(String(list.salesOrder)));
    if (!liveLists.length) {
      return res.json({ success: true, data: [], counts: { sorting: 0, billable: 0 } });
    }

    const orderIds = [...new Set(liveLists.map(list => String(list.salesOrder)))];
    const orders = await SalesOrder.find({ branch: req.branchId, _id: { $in: orderIds } })
      .select('orderNumber dealerName dealerCode customerName status orderDate grandTotal items dealer')
      .populate('dealer', 'businessName dealerCode gstin state')
      .lean();

    const data = orders.map(order => {
      const lists = liveLists.filter(list => String(list.salesOrder) === String(order._id));
      const items = order.items || [];

      // Least-advanced live pick list decides the stage: an order with one packed
      // and one still-awaiting-sort list is not "packed" yet.
      const stage = lists.reduce((lowest, list) => {
        const rank = PICK_STAGE_RANK[list.status] ?? 0;
        return rank < lowest.rank ? { rank, status: list.status } : lowest;
      }, { rank: 99, status: 'verified' });

      // Sorted quantity per order line, so the picker knows whether the whole
      // order can be billed and the backend won't reject the click.
      const sortedByOrderItem = new Map();
      for (const list of lists) {
        for (const line of list.items || []) {
          const key = String(line.salesOrderItem || '');
          if (!key) continue;
          const qty = Number(line.sortedQty ?? line.pickedQty ?? 0);
          sortedByOrderItem.set(key, (sortedByOrderItem.get(key) || 0) + qty);
        }
      }
      const sortedLines = items.filter(item => (sortedByOrderItem.get(String(item._id)) || 0) > QUANTITY_TOLERANCE);
      const sortedValue = sortedLines.reduce((sum, item) => (
        sum + (sortedByOrderItem.get(String(item._id)) || 0) * Number(item.rate || 0)
      ), 0);
      const unpackedLine = items.find(item => (
        (sortedByOrderItem.get(String(item._id)) || 0)
        < Number(item.quantity || 0) - Number(item.cancelledRemainingQuantity || 0) - QUANTITY_TOLERANCE
      ));

      // Billable from `sorted` onwards — the whole sorting queue is invoiceable
      // as long as every line is fully sorted.
      const eligible = !unpackedLine && sortedLines.length > 0;

      let blockReason = '';
      if (!eligible) {
        blockReason = unpackedLine
          ? `${unpackedLine.productName || unpackedLine.productCode || 'A line'} is sorted to only ${(sortedByOrderItem.get(String(unpackedLine._id)) || 0).toFixed(2)} of ${(Number(unpackedLine.quantity || 0) - Number(unpackedLine.cancelledRemainingQuantity || 0)).toFixed(2)} ${unpackedLine.unit || 'Box'}. Finish sorting or cancel the remainder.`
          : 'No sorted quantity to invoice yet.';
      }

      return {
        _id: order._id,
        orderNumber: order.orderNumber,
        dealerName: order.dealerName || order.dealer?.businessName || order.customerName || '—',
        dealerCode: order.dealerCode || order.dealer?.dealerCode || '',
        dealerGstin: order.dealer?.gstin || '',
        orderStatus: order.status,
        orderDate: order.orderDate,
        stage: stage.status,
        stageLabel: PICK_STAGE_LABEL[stage.status] || stage.status,
        bucket: eligible ? 'billable' : 'sorting',
        pickListNumbers: lists.map(list => list.pickListNumber),
        pickListStatuses: lists.map(list => list.status),
        route: lists.map(list => list.deliveryRoute).find(Boolean) || '',
        boxes: lists.reduce((sum, list) => sum + Number(list.totalBoxes || 0), 0),
        pickedQty: lists.reduce((sum, list) => sum + Number(list.totalPickedQty || 0), 0),
        totalLines: items.length,
        sortedLines: sortedLines.length,
        orderValue: Number(order.grandTotal || 0),
        sortedValue: Math.round(sortedValue * 100) / 100,
        eligible,
        blockReason,
      };
    });

    const needle = String(search || '').trim().toLowerCase();
    const filtered = needle
      ? data.filter(row => `${row.orderNumber} ${row.dealerName} ${row.dealerCode} ${row.pickListNumbers.join(' ')} ${row.route}`
        .toLowerCase().includes(needle))
      : data;

    // Most advanced sorting stage first (ready → packed → sorted → awaiting),
    // newest first inside a stage.
    filtered.sort((a, b) => (
      (PICK_STAGE_RANK[b.stage] ?? 0) - (PICK_STAGE_RANK[a.stage] ?? 0)
      || (new Date(b.orderDate) - new Date(a.orderDate))
    ));

    const page = filtered.slice(0, Math.min(300, Math.max(1, parseInt(limit) || 200)));
    res.json({
      success: true,
      data: page,
      counts: {
        sorting: page.filter(row => row.bucket === 'sorting').length,
        billable: page.filter(row => row.bucket === 'billable').length,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

function validGstin(value) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(value || '').trim().toUpperCase());
}

// POST /api/v1/invoices/generate-from-so/:soId — generate invoice from Sales Order
router.post('/generate-from-so/:soId', requirePermission('invoice'), async (req, res) => {
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) {
    return res.status(422).json({ success: false, message: 'A valid Idempotency-Key header is required.' });
  }
  const sourceKey = `${String(req.branchId)}:${rawIdempotencyKey}`;
  const requestFingerprint = fingerprintRequest({ salesOrder: req.params.soId, ...req.body });
  try {
    const so = await SalesOrder.findOne({ _id: req.params.soId, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode gstin pan address city state mobile creditDays paymentTerms')
      .populate('items.product', 'productCode itemName hsnCode images piecesPerBox sqftPerBox')
      .lean();

    if (!so) return res.status(404).json({ success: false, message: 'Sales Order not found.' });

    // A previously generated active invoice is always the authoritative retry result.
    const existing = await Invoice.findOne({ branch: req.branchId, salesOrder: so._id, status: { $ne: 'cancelled' } }).lean();
    if (existing) {
      if (existing.sourceKey === sourceKey && existing.requestFingerprint
        && existing.requestFingerprint !== requestFingerprint) {
        return res.status(409).json({ success: false, message: 'This Idempotency-Key was already used with a different invoice request.' });
      }
      return res.json({ success: true, message: `Invoice ${existing.invoiceNumber} already exists for this order.`, data: existing });
    }

    if (['draft', 'cancelled'].includes(so.status)) {
      return res.status(409).json({ success: false, code: 'FINAL_DISPATCH_REQUIRED', message: `Cannot generate an invoice for a ${so.status} order.` });
    }

    const orderedRemaining = item => Number(item.quantity || 0) - Number(item.cancelledRemainingQuantity || 0);
    const dispatchedOf = item => Math.max(0, Number(item.dispatchedQuantity || 0) - Number(item.dispatchReversedQuantity || 0));
    const incompleteLine = (so.items || []).find(item => orderedRemaining(item) - dispatchedOf(item) > QUANTITY_TOLERANCE);
    const anyDispatched = (so.items || []).some(item => dispatchedOf(item) > QUANTITY_TOLERANCE);

    // Two legitimate billing points:
    //   1. post-dispatch (unchanged) — lines come from dispatchedQuantity and a
    //      stock-deducted trip must exist;
    //   2. pre-dispatch — the pick list is packed and marked "Ready for
    //      dispatch", so the invoice is raised from the sorted quantities while
    //      the truck is still in the yard (this is what the "invoice confirmed"
    //      check at final dispatch verification expects).
    // A half-dispatched order is never invoiced: that would double-bill lines.
    let dispatchTrips = [];
    let billedFromSorting = false;
    let sortingPickLists = [];

    if (incompleteLine && anyDispatched) {
      return res.status(409).json({
        success: false,
        code: 'FINAL_DISPATCH_REQUIRED',
        message: `${incompleteLine.productName || incompleteLine.productCode || 'Every order line'} must be dispatched or have its remainder formally cancelled before final invoicing.`,
      });
    }

    if (incompleteLine) {
      sortingPickLists = await PickList.find({
        branch: req.branchId,
        salesOrder: so._id,
        status: { $in: ['sorted', 'packed', 'ready_for_dispatch'] },
        stockConsumedAt: null,
      }).select('pickListNumber items.salesOrderItem items.sortedQty items.pickedQty').lean();

      if (!sortingPickLists.length) {
        return res.status(409).json({
          success: false,
          code: 'FINAL_DISPATCH_REQUIRED',
          message: 'Invoicing needs a pick list with completed sorting (Sorted or later) or a completed dispatch.',
        });
      }
      billedFromSorting = true;
    } else {
      dispatchTrips = await DispatchTrip.find({
        branch: req.branchId,
        status: { $in: ['dispatched', 'in_transit', 'completed'] },
        stockDeductedAt: { $ne: null },
        'orders.salesOrder': so._id,
      }).select('_id tripNumber stockDeductedAt').sort({ stockDeductedAt: 1 }).lean();
      if (!dispatchTrips.length) {
        return res.status(409).json({
          success: false,
          code: 'FULL_DISPATCH_REQUIRED',
          message: 'Invoice generation requires a linked dispatched trip with completed stock deduction.',
        });
      }
    }

    if (!so.dealer) {
      return res.status(422).json({ success: false, message: 'A dealer with a complete tax profile is required for a tax invoice.' });
    }
    const sellerGstin = String(req.branch.gstin || '').trim().toUpperCase();
    const sellerState = String(req.branch.state || '').trim();
    const sellerStateCode = String(req.branch.stateCode || '').trim();
    const buyerGstin = String(so.dealer.gstin || '').trim().toUpperCase();
    const buyerState = String(so.dealer.state || '').trim();
    const buyerName = String(so.dealerName || so.dealer.businessName || so.customerName || '').trim();
    if (!sellerState || !/^\d{2}$/.test(sellerStateCode) || !isKnownGstStateCode(sellerStateCode)
      || !gstStateMatchesCode(sellerStateCode, sellerState) || !validGstin(sellerGstin)
      || sellerGstin.slice(0, 2) !== sellerStateCode) {
      return res.status(422).json({ success: false, message: 'The active branch requires a valid GSTIN, state, and matching two-digit state code.' });
    }
    const buyerStateCode = buyerGstin.slice(0, 2);
    if (!buyerName || !buyerState || !validGstin(buyerGstin)
      || !isKnownGstStateCode(buyerStateCode) || !gstStateMatchesCode(buyerStateCode, buyerState)) {
      return res.status(422).json({ success: false, message: 'The dealer requires a name, valid GSTIN, and matching canonical GST state.' });
    }

    const invoiceNumber = await generateBranchNumber(req.branchId, 'invoice', new Date());

    // Pre-dispatch billing reads the sorted quantity off the pick lists; the
    // dispatched path keeps using dispatchedQuantity.
    const sortedQtyByOrderItem = new Map();
    if (billedFromSorting) {
      for (const pickList of sortingPickLists) {
        for (const line of pickList.items || []) {
          const key = String(line.salesOrderItem || '');
          if (!key) continue;
          const qty = Number(line.sortedQty ?? line.pickedQty ?? 0);
          sortedQtyByOrderItem.set(key, (sortedQtyByOrderItem.get(key) || 0) + qty);
        }
      }
      const unpackedLine = (so.items || []).find(item => (
        (sortedQtyByOrderItem.get(String(item._id)) || 0) < orderedRemaining(item) - QUANTITY_TOLERANCE
      ));
      if (unpackedLine) {
        const sortedQty = sortedQtyByOrderItem.get(String(unpackedLine._id)) || 0;
        return res.status(409).json({
          success: false,
          code: 'SORTING_INCOMPLETE',
          message: `${unpackedLine.productName || unpackedLine.productCode || 'A line'} is sorted to only ${sortedQty.toFixed(2)} of ${orderedRemaining(unpackedLine).toFixed(2)} ${unpackedLine.unit || 'Box'}. Finish sorting or cancel the remainder before invoicing.`,
        });
      }
    }

    // Build invoice items with full details
    const items = so.items.map(item => ({
      item,
      qty: billedFromSorting
        ? Math.max(0, sortedQtyByOrderItem.get(String(item._id)) || 0)
        : dispatchedOf(item),
    })).filter(row => row.qty > QUANTITY_TOLERANCE).map(({ item, qty }) => {
      const prod = item.product || {};
      const orderedQty = Number(item.quantity || 0);
      const commercialRatio = orderedQty > 0 ? qty / orderedQty : 0;
      const rate = item.rate || 0;
      const baseAmount = qty * rate;

      let discountAmt = 0;
      if (item.discountType === 'percentage') {
        discountAmt = (baseAmount * (item.discount || 0)) / 100;
      } else {
        discountAmt = (item.discount || 0) * qty;
      }

      const taxable = baseAmount - discountAmt - (Number(item.schemeDiscount || 0) * commercialRatio);
      const gstPct = item.gstPercentage || 18;
      const gstAmt = (taxable * gstPct) / 100;

      // Determine CGST/SGST vs IGST based on inter-state flag (set later)
      // For now calculate both — we'll choose which to use based on state comparison
      const halfGst = gstAmt / 2;

      return {
        salesOrderItem: item._id,
        product: prod._id || item.product,
        productCode: item.productCode || prod.productCode || '',
        productName: item.productName || prod.itemName || '',
        productImage: item.productImage || prod.images?.[0] || '',
        hsnCode: prod.hsnCode || '',
        shade: item.shade || '',
        batch: item.batch || '',
        quantity: qty,
        unit: item.unit || 'Box',
        baseQuantity: qty * Number(item.conversionFactor || 1),
        baseUnit: item.baseUnit || item.unit || 'Box',
        conversionFactor: Number(item.conversionFactor || 1),
        uomVersion: Number(item.uomVersion || 1),
        boxes: Number(item.boxes || orderedQty) * commercialRatio,
        pieces: Number(item.pieces || (orderedQty * (prod.piecesPerBox || 0))) * commercialRatio,
        sqft: Number(item.sqft || (orderedQty * (prod.sqftPerBox || 0))) * commercialRatio,
        rate,
        discount: item.discount || 0,
        discountType: item.discountType || 'flat',
        discountAmount: Math.round(discountAmt * 100) / 100,
        schemeDiscount: Math.round(Number(item.schemeDiscount || 0) * commercialRatio * 100) / 100,
        taxableAmount: Math.round(taxable * 100) / 100,
        gstPercentage: gstPct,
        cgst: Math.round(halfGst * 100) / 100,
        sgst: Math.round(halfGst * 100) / 100,
        igst: 0, // Will be set if inter-state
        gstAmount: Math.round(gstAmt * 100) / 100,
        totalAmount: Math.round((taxable + gstAmt) * 100) / 100,
      };
    });

    if (!items.length) return res.status(409).json({ success: false, code: 'NO_DISPATCHED_QUANTITY', message: 'A final invoice requires at least one billable line.' });
    // Determine interstate treatment from GST jurisdiction codes, never from missing/free-text state names.
    const branchSettings = await BranchSettings.findOne({ branch: req.branchId }).lean();
    const isInterState = buyerStateCode !== sellerStateCode;

    // If inter-state, convert CGST+SGST to IGST
    if (isInterState) {
      items.forEach(item => {
        item.igst = item.gstAmount;
        item.cgst = 0;
        item.sgst = 0;
      });
    }

    const taxableTotal = items.reduce((s, i) => s + i.taxableAmount, 0);
    const totalCgst = items.reduce((s, i) => s + i.cgst, 0);
    const totalSgst = items.reduce((s, i) => s + i.sgst, 0);
    const totalIgst = items.reduce((s, i) => s + i.igst, 0);
    const totalTax = totalCgst + totalSgst + totalIgst;
    const totalDiscount = items.reduce((s, i) => s + i.discountAmount, 0);
    const totalSchemeDiscount = items.reduce((s, i) => s + i.schemeDiscount, 0);

    const cancelledHeaderCharges = so.status === 'partially_closed' ? (so.closureFinancialSummary?.headerCharges || {}) : {};
    const invoiceCharges = Object.fromEntries(['freightCharges', 'loadingCharges', 'installationCharges', 'otherCharges'].map(field => [field, Math.max(0, Number(so[field] || 0) - Number(cancelledHeaderCharges[field] || 0))]));
    const chargesTotal = Object.values(invoiceCharges).reduce((sum, value) => sum + value, 0);
    const rawGrand = taxableTotal + totalTax + chargesTotal;
    const closureGrandTotal = Number(so.closureFinancialSummary?.expectedFinalInvoiceGrandTotal);
    const grandTotal = so.status === 'partially_closed' && Number.isFinite(closureGrandTotal)
      ? closureGrandTotal
      : Math.round(rawGrand);
    const roundOff = grandTotal - rawGrand;
    const paidAmount = Math.min(grandTotal, Math.max(0, Number(so.advanceAmount) || 0));
    const balanceAmount = Math.max(0, grandTotal - paidAmount);
    const paymentStatus = balanceAmount <= 0.01 ? 'paid' : paidAmount > 0.01 ? 'partial' : 'pending';

    // Credit terms flow from the dealer master onto the invoice: due date =
    // invoice date + creditDays, so ledger/aging and payment reminders are accurate.
    const invoiceDate = new Date();
    const creditDays = Math.max(0, Number(so.dealer?.creditDays ?? 0));
    const dueDate = new Date(invoiceDate.getTime() + creditDays * 24 * 60 * 60 * 1000);
    const paymentTermsText = String(so.dealer?.paymentTerms || (creditDays ? `${creditDays} days credit` : ''));

    const invoice = await Invoice.create({
      invoiceNumber,
      sourceKey,
      requestFingerprint,
      activeSalesOrderKey: `${String(req.branchId)}:${String(so._id)}`,
      branch: req.branchId,
      invoiceDate,
      invoiceType: 'tax_invoice',
      gstType: 'output', // Sales invoice = Output GST
      isInterState,
      salesOrder: so._id,
      orderNumber: so.orderNumber,
      dispatchTrips: dispatchTrips.map(trip => trip._id),
      dispatchNumbers: dispatchTrips.map(trip => trip.tripNumber),
      stockDispatchedAt: dispatchTrips.at(-1)?.stockDeductedAt,
      sellerName: req.branch.legalName || req.branch.name,
      sellerGstin,
      sellerAddress: [req.branch.address, req.branch.city, sellerState, req.branch.pinCode].filter(Boolean).join(', '),
      sellerState,
      sellerStateCode,
      termsAndConditions: branchSettings?.invoiceTerms || '',

      // Buyer
      buyerType: so.orderType || 'dealer',
      dealer: so.dealer?._id,
      buyerName,
      buyerCode: so.dealerCode || '',
      buyerGstin,
      buyerPan: so.dealer?.pan || '',
      buyerAddress: so.dealer?.address || '',
      buyerCity: so.dealer?.city || '',
      buyerState,
      buyerStateCode,
      buyerPhone: so.dealer?.mobile || so.customerPhone || '',
      deliveryAddress: so.deliveryAddress || '',
      internalNotes: billedFromSorting
        ? `Raised from ${sortingPickLists.map(pickList => pickList.pickListNumber).join(', ')} before dispatch (sorted quantities).`
        : '',

      // Items
      items,

      // Totals
      subtotal: Math.round(items.reduce((s, i) => s + (i.quantity * i.rate), 0) * 100) / 100,
      totalDiscount: Math.round(totalDiscount * 100) / 100,
      totalSchemeDiscount: Math.round(totalSchemeDiscount * 100) / 100,
      taxableTotal: Math.round(taxableTotal * 100) / 100,
      totalCgst: Math.round(totalCgst * 100) / 100,
      totalSgst: Math.round(totalSgst * 100) / 100,
      totalIgst: Math.round(totalIgst * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      freightCharges: invoiceCharges.freightCharges,
      loadingCharges: invoiceCharges.loadingCharges,
      installationCharges: invoiceCharges.installationCharges,
      otherCharges: invoiceCharges.otherCharges,
      roundOff: Math.round(roundOff * 100) / 100,
      grandTotal,
      amountInWords: numberToWords(grandTotal),

      // Payment
      paidAmount,
      balanceAmount,
      paymentStatus,
      paymentTerms: paymentTermsText,
      dueDate,

      // Status
      status: 'generated',
      createdBy: req.user._id,
    });

    if (dispatchTrips.length) {
      await DispatchTrip.updateMany(
        { _id: { $in: dispatchTrips.map(trip => trip._id) }, branch: req.branchId, 'orders.salesOrder': so._id },
        { $set: { 'orders.$[order].invoice': invoice._id, 'orders.$[order].invoiceNumber': invoice.invoiceNumber } },
        { arrayFilters: [{ 'order.salesOrder': so._id }] }
      );
    }

    res.status(201).json({ success: true, message: `Invoice ${invoiceNumber} generated.`, data: invoice });
  } catch (e) {
    if (e.code === 11000) {
      const existing = await Invoice.findOne({ branch: req.branchId, salesOrder: req.params.soId, status: { $ne: 'cancelled' } }).lean();
      if (existing) return res.json({ success: true, message: `Invoice ${existing.invoiceNumber} already exists for this order.`, data: existing });
    }
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// GET /api/v1/invoices/:id — get single invoice (full detail for PDF)
router.get('/:id', requirePermission('invoice'), async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('dealer', 'businessName dealerCode gstin address city state mobile')
      .populate('salesOrder', 'orderNumber orderDate')
      .populate('createdBy', 'name')
      .lean();
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    res.json({ success: true, data: invoice });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/v1/invoices/:id/status — mark as sent/cancelled
router.patch('/:id/status', requirePermission('invoice'), async (req, res) => {
  try {
    const { status, cancelReason } = req.body;
    if (!['sent', 'cancelled'].includes(status)) {
      return res.status(422).json({ success: false, message: 'Invoice status must be sent or cancelled.' });
    }
    if (status === 'cancelled') {
      const invoiceToCancel = await Invoice.findOne({ _id: req.params.id, branch: req.branchId }).lean();
      if (!invoiceToCancel) return res.status(404).json({ success: false, message: 'Invoice not found.' });
      if (Number(invoiceToCancel.paidAmount || 0) > 0.01) {
        return res.status(409).json({ success: false, message: 'A paid or partially paid invoice cannot be cancelled. Reverse its payments first.' });
      }
      const allocatedPayment = await Payment.exists({
        branch: req.branchId,
        status: { $in: ['pending', 'confirmed'] },
        againstOrders: { $elemMatch: { order: invoiceToCancel._id, orderModel: 'Invoice' } },
      });
      if (allocatedPayment) {
        return res.status(409).json({ success: false, message: 'Invoice cancellation is blocked while a pending or confirmed payment references it.' });
      }
      const postedReturn = await SalesReturn.exists({ invoice: invoiceToCancel._id, status: { $nin: ['cancelled', 'reversed'] } });
      if (postedReturn) {
        return res.status(409).json({ success: false, message: 'Invoice cancellation is blocked while a non-reversed Sales Return references it.' });
      }
    }

    const allowedSourceStatuses = status === 'sent' ? ['generated'] : ['generated', 'sent'];
    const update = { $set: { status } };
    if (status === 'cancelled') {
      update.$unset = { activeSalesOrderKey: 1 };
      if (cancelReason) update.$set.cancelReason = cancelReason;
    }
    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, branch: req.branchId, status: { $in: allowedSourceStatuses } },
      update,
      { new: true, runValidators: true }
    );
    if (invoice) {
      return res.json({ success: true, message: `Invoice ${status}.`, data: invoice });
    }

    const existing = await Invoice.findOne({ _id: req.params.id, branch: req.branchId });
    if (!existing) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    if (status === 'sent' && existing.status === 'sent') {
      return res.json({ success: true, message: 'Invoice already sent.', data: existing });
    }
    return res.status(409).json({
      success: false,
      message: `Invoice cannot transition from ${existing.status} to ${status}.`,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE — not allowed for generated invoices, only draft
router.delete('/:id', requirePermission('invoice'), async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, branch: req.branchId });
    if (!invoice) return res.status(404).json({ success: false, message: 'Not found.' });
    if (invoice.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only draft invoices can be deleted. Cancel generated invoices instead.' });
    }
    const { safeDelete } = await import('../middleware/safeDelete.js');
    const result = await safeDelete(Invoice, req.params.id, {
      user: req.user,
      module: 'invoice',
      titleField: 'buyerName',
      codeField: 'invoiceNumber',
      scope: { branch: req.branchId },
    });
    res.status(result.status || 200).json(result);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
