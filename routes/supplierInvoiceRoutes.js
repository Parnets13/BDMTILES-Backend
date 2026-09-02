import { Router } from 'express';
import mongoose from 'mongoose';
import Supplier from '../models/Supplier.js';
import SupplierInvoice from '../models/SupplierInvoice.js';
import SupplierLedger from '../models/SupplierLedger.js';
import GRN from '../models/GRN.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint as fingerprintRequest } from '../utils/idempotency.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const MATCH_TOLERANCE = 0.01;
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const idText = value => String(value?._id || value || '');
const invoiceError = (status, message, code, discrepancies) => {
  const error = Object.assign(new Error(message), { status });
  if (code) error.code = code;
  if (discrepancies) error.discrepancies = discrepancies;
  return error;
};
const nonnegative = (value, field) => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw invoiceError(422, `${field} must be a finite nonnegative number.`);
  return money(parsed);
};
const sendError = (res, error) => res.status(
  error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : error.code === 11000 ? 409 : 500)
).json({
  success: false,
  code: error.code === 11000 ? 'DUPLICATE_SUPPLIER_INVOICE' : error.code,
  message: error.code === 11000 ? 'This supplier invoice or idempotency key already exists.' : error.message,
  ...(error.discrepancies ? { discrepancies: error.discrepancies } : {}),
});

const findPOLine = (po, grnItem) => {
  const exact = grnItem.purchaseOrderItem ? po.items.id(grnItem.purchaseOrderItem) : null;
  if (exact) return exact;
  const matches = po.items.filter(item => idText(item.product) === idText(grnItem.product));
  return matches.length === 1 ? matches[0] : null;
};

function buildInvoiceExpectation(grns, purchaseOrders) {
  const poMap = new Map(purchaseOrders.map(po => [idText(po._id), po]));
  const grossByPO = new Map();
  const lines = [];
  let invoiceAmount = 0;
  let taxAmount = 0;

  for (const grn of grns) {
    const po = poMap.get(idText(grn.purchaseOrder));
    if (!po) throw invoiceError(409, `Purchase order for GRN ${grn.grnNumber} is unavailable.`);
    for (const grnItem of grn.items || []) {
      const quantity = Number(grnItem.acceptedQty || 0);
      if (quantity <= 0) continue;
      const poLine = findPOLine(po, grnItem);
      if (!poLine) throw invoiceError(409, `GRN ${grn.grnNumber} contains an ambiguous purchase order line.`);
      const orderedQuantity = Number(poLine.quantity);
      if (!Number.isFinite(orderedQuantity) || orderedQuantity <= 0) {
        throw invoiceError(409, `Purchase order line for ${poLine.productName || poLine.productCode} has an invalid quantity.`);
      }
      const rate = Number(poLine.rate);
      const gross = money(quantity * rate);
      const fullDiscount = Number(poLine.discount || 0) + Number(poLine.schemeDiscount || 0);
      const discountAmount = money(fullDiscount * quantity / orderedQuantity);
      const taxableAmount = money(gross - discountAmount);
      const gstPercentage = Number(poLine.gstPercentage || 0);
      const lineTax = money(taxableAmount * gstPercentage / 100);
      invoiceAmount = money(invoiceAmount + taxableAmount);
      taxAmount = money(taxAmount + lineTax);
      grossByPO.set(idText(po._id), money((grossByPO.get(idText(po._id)) || 0) + gross));
      lines.push({
        grn: grn._id,
        grnItem: grnItem._id,
        purchaseOrder: po._id,
        purchaseOrderItem: poLine._id,
        product: poLine.product,
        productCode: poLine.productCode || '',
        productName: poLine.productName || '',
        unit: poLine.unit || 'Box',
        invoiceQuantity: quantity,
        rate,
        discountAmount,
        taxableAmount,
        gstPercentage,
        taxAmount: lineTax,
        totalAmount: money(taxableAmount + lineTax),
      });
    }
  }
  if (!lines.length) throw invoiceError(422, 'Linked GRNs have no accepted quantity available for invoicing.');

  let freightAmount = 0;
  let otherCharges = 0;
  for (const [poId, selectedGross] of grossByPO) {
    const po = poMap.get(poId);
    const poGross = Number(po.subtotal || po.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate), 0));
    const ratio = poGross > 0 ? Math.min(1, selectedGross / poGross) : 0;
    freightAmount = money(freightAmount + Number(po.freight || 0) * ratio);
    otherCharges = money(otherCharges + (Number(po.loading || 0) + Number(po.insurance || 0)) * ratio);
  }

  return {
    lines,
    invoiceAmount,
    taxAmount,
    freightAmount,
    otherCharges,
    grandTotal: money(invoiceAmount + taxAmount + freightAmount + otherCharges),
  };
}

async function loadInvoiceSources({ branchId, supplierId, linkedGRNs, session, excludeInvoiceId = null }) {
  if (!mongoose.isValidObjectId(supplierId)) throw invoiceError(422, 'A valid supplier is required.');
  if (!Array.isArray(linkedGRNs) || !linkedGRNs.length) throw invoiceError(422, 'At least one posted GRN is required.');
  const ids = linkedGRNs.map(String);
  if (ids.some(id => !mongoose.isValidObjectId(id)) || new Set(ids).size !== ids.length) {
    throw invoiceError(422, 'Linked GRNs must be unique valid identifiers.');
  }

  let grnQuery = GRN.find({
    _id: { $in: ids },
    branch: branchId,
    supplier: supplierId,
    status: { $in: ['approved', 'posted'] },
  });
  if (session) grnQuery = grnQuery.session(session);
  const grns = await grnQuery;
  if (grns.length !== ids.length) {
    throw invoiceError(422, 'Every linked GRN must be posted and belong to the selected supplier and active branch.');
  }

  const reuseFilter = {
    branch: branchId,
    status: { $ne: 'cancelled' },
    linkedGRNs: { $in: ids },
  };
  if (excludeInvoiceId) reuseFilter._id = { $ne: excludeInvoiceId };
  let reuseQuery = SupplierInvoice.findOne(reuseFilter).select('invoiceRefNumber invoiceNumber').lean();
  if (session) reuseQuery = reuseQuery.session(session);
  const reused = await reuseQuery;
  if (reused) throw invoiceError(409, `A linked GRN is already used by supplier invoice ${reused.invoiceRefNumber || reused.invoiceNumber}.`);

  const poIds = [...new Set(grns.map(grn => idText(grn.purchaseOrder)))];
  let poQuery = PurchaseOrder.find({ _id: { $in: poIds }, branch: branchId });
  if (session) poQuery = poQuery.session(session);
  const purchaseOrders = await poQuery;
  if (purchaseOrders.length !== poIds.length) throw invoiceError(409, 'One or more source purchase orders are unavailable.');
  return { grns, purchaseOrders, expected: buildInvoiceExpectation(grns, purchaseOrders) };
}

const expectedReport = expected => ({
  status: 'pending',
  tolerance: MATCH_TOLERANCE,
  expectedInvoiceAmount: expected.invoiceAmount,
  expectedTaxAmount: expected.taxAmount,
  expectedFreightAmount: expected.freightAmount,
  expectedOtherCharges: expected.otherCharges,
  expectedGrandTotal: expected.grandTotal,
  discrepancies: [],
});

router.get('/', requirePermission('invoice'), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { branch: req.branchId };
    if (req.query.search) {
      const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ invoiceRefNumber: regex }, { invoiceNumber: regex }, { supplierName: regex }];
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.supplier) filter.supplier = req.query.supplier;
    const [data, total] = await Promise.all([
      SupplierInvoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('supplier', 'companyName supplierCode').lean(),
      SupplierInvoice.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total } });
  } catch (error) { return sendError(res, error); }
});

router.get('/stats', requirePermission('invoice'), async (req, res) => {
  try {
    const scope = { branch: req.branchId };
    const [total, draft, pendingVerification, verified, partial, paid, totalValue, outstanding] = await Promise.all([
      SupplierInvoice.countDocuments(scope),
      SupplierInvoice.countDocuments({ ...scope, status: 'draft' }),
      SupplierInvoice.countDocuments({ ...scope, status: 'pending_verification' }),
      SupplierInvoice.countDocuments({ ...scope, status: 'verified' }),
      SupplierInvoice.countDocuments({ ...scope, status: 'partial' }),
      SupplierInvoice.countDocuments({ ...scope, status: 'paid' }),
      SupplierInvoice.aggregate([{ $match: { ...scope, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
      SupplierInvoice.aggregate([{ $match: { ...scope, status: { $in: ['verified', 'partial'] } } }, { $group: { _id: null, total: { $sum: '$balanceAmount' } } }]),
    ]);
    return res.json({
      success: true,
      data: {
        total, draft, pendingVerification, verified, partial, paid,
        totalValue: totalValue[0]?.total || 0,
        outstanding: outstanding[0]?.total || 0,
      },
    });
  } catch (error) { return sendError(res, error); }
});

router.get('/available-grns', requirePermission('invoice'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.query.supplier)) throw invoiceError(422, 'A valid supplier is required.');
    const usedGRNs = await SupplierInvoice.distinct('linkedGRNs', { branch: req.branchId, status: { $ne: 'cancelled' } });
    const grns = await GRN.find({
      branch: req.branchId,
      supplier: req.query.supplier,
      status: { $in: ['approved', 'posted'] },
      _id: { $nin: usedGRNs },
    }).sort({ grnDate: 1 });
    const poIds = [...new Set(grns.map(grn => idText(grn.purchaseOrder)))];
    const purchaseOrders = await PurchaseOrder.find({ _id: { $in: poIds }, branch: req.branchId });
    const poMap = new Map(purchaseOrders.map(po => [idText(po._id), po]));
    const data = grns.map(grn => {
      const po = poMap.get(idText(grn.purchaseOrder));
      if (!po) return null;
      const expected = buildInvoiceExpectation([grn], [po]);
      return {
        _id: grn._id,
        grnNumber: grn.grnNumber,
        grnDate: grn.grnDate,
        poNumber: grn.poNumber,
        ...expected,
        lines: expected.lines,
      };
    }).filter(Boolean);
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
});

router.get('/:id', requirePermission('invoice'), async (req, res) => {
  try {
    const invoice = await SupplierInvoice.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('supplier', 'companyName supplierCode mobile')
      .populate('linkedGRNs', 'grnNumber grnDate poNumber status')
      .populate('items.product', 'productCode itemName tileSize images')
      .lean();
    if (!invoice) throw invoiceError(404, 'Supplier invoice not found.');
    return res.json({ success: true, data: invoice });
  } catch (error) { return sendError(res, error); }
});

router.post('/', requirePermission('invoice'), async (req, res) => {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!key || key.length > 200) return sendError(res, invoiceError(422, 'A valid Idempotency-Key header is required.'));
  const sourceKey = `${idText(req.branchId)}:supplier-invoice:${key}`;
  const requestFingerprint = fingerprintRequest(req.body);
  const session = await mongoose.startSession();
  try {
    let result;
    let replayed = false;
    await session.withTransaction(async () => {
      const existing = await SupplierInvoice.findOne({ branch: req.branchId, sourceKey }).session(session);
      if (existing) {
        if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
          throw invoiceError(409, 'This Idempotency-Key was already used with a different payload.');
        }
        result = existing;
        replayed = true;
        return;
      }

      const invoiceNumber = String(req.body.invoiceNumber || '').trim();
      if (!invoiceNumber) throw invoiceError(422, 'Supplier invoice number is required.');
      const supplier = await Supplier.findOne({ _id: req.body.supplier, status: 'active' }).session(session).lean();
      if (!supplier) throw invoiceError(404, 'Active supplier not found.');
      const duplicate = await SupplierInvoice.findOne({
        branch: req.branchId,
        supplier: supplier._id,
        invoiceNumber,
        status: { $ne: 'cancelled' },
      }).session(session).lean();
      if (duplicate) throw invoiceError(409, 'This supplier invoice number already exists for the supplier.');

      const { expected } = await loadInvoiceSources({
        branchId: req.branchId,
        supplierId: supplier._id,
        linkedGRNs: req.body.linkedGRNs,
        session,
      });
      const invoiceAmount = nonnegative(req.body.invoiceAmount, 'invoiceAmount');
      const taxAmount = nonnegative(req.body.taxAmount, 'taxAmount');
      const freightAmount = nonnegative(req.body.freightAmount, 'freightAmount');
      const otherCharges = nonnegative(req.body.otherCharges, 'otherCharges');
      const grandTotal = money(invoiceAmount + taxAmount + freightAmount + otherCharges);
      if (grandTotal <= 0) throw invoiceError(422, 'Supplier invoice grand total must be greater than zero.');
      const invoiceDate = req.body.invoiceDate || new Date();
      const invoiceRefNumber = await generateBranchNumber(req.branchId, 'supplierInvoice', invoiceDate, { session });
      [result] = await SupplierInvoice.create([{
        invoiceRefNumber,
        branch: req.branchId,
        sourceKey,
        requestFingerprint,
        invoiceNumber,
        invoiceDate,
        supplier: supplier._id,
        supplierName: supplier.companyName,
        linkedGRNs: req.body.linkedGRNs,
        items: expected.lines,
        invoiceAmount,
        taxAmount,
        freightAmount,
        otherCharges,
        grandTotal,
        paidAmount: 0,
        balanceAmount: grandTotal,
        paymentTerms: String(req.body.paymentTerms ?? supplier.paymentTerms ?? ''),
        dueDate: req.body.dueDate || undefined,
        status: 'pending_verification',
        matchReport: expectedReport(expected),
        remarks: String(req.body.remarks || ''),
        tallySyncStatus: 'not_synced',
        createdBy: req.user._id,
      }], { session });
    });
    return res.status(replayed ? 200 : 201).json({
      success: true,
      message: replayed ? 'Supplier invoice already created.' : 'Supplier invoice created and queued for three-way verification.',
      data: result,
    });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

router.patch('/:id/verify', requirePermission('invoice'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result;
    let replayed = false;
    let mismatch = false;
    await session.withTransaction(async () => {
      const invoice = await SupplierInvoice.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!invoice) throw invoiceError(404, 'Supplier invoice not found.');
      if (['verified', 'partial', 'paid'].includes(invoice.status)) {
        result = invoice;
        replayed = true;
        return;
      }
      if (invoice.status !== 'pending_verification') {
        throw invoiceError(409, `Only pending verification invoices can be verified. Current status: ${invoice.status}.`);
      }

      const { grns, expected } = await loadInvoiceSources({
        branchId: req.branchId,
        supplierId: invoice.supplier,
        linkedGRNs: invoice.linkedGRNs,
        session,
        excludeInvoiceId: invoice._id,
      });
      const fields = [
        ['invoiceAmount', expected.invoiceAmount, Number(invoice.invoiceAmount)],
        ['taxAmount', expected.taxAmount, Number(invoice.taxAmount)],
        ['freightAmount', expected.freightAmount, Number(invoice.freightAmount)],
        ['otherCharges', expected.otherCharges, Number(invoice.otherCharges)],
        ['grandTotal', expected.grandTotal, Number(invoice.grandTotal)],
      ];
      const discrepancies = fields.filter(([, expectedValue, actualValue]) => Math.abs(expectedValue - actualValue) > MATCH_TOLERANCE)
        .map(([field, expectedValue, actualValue]) => ({
          field,
          expected: expectedValue,
          actual: actualValue,
          difference: money(actualValue - expectedValue),
          message: `${field} differs from PO/GRN expectation by more than ₹${MATCH_TOLERANCE.toFixed(2)}.`,
        }));

      const legacyKeys = grns.map(grn => `grn:${grn._id}:approved`);
      const legacyEntries = await SupplierLedger.find({
        branch: req.branchId,
        supplier: invoice.supplier,
        postingKey: { $in: legacyKeys },
      }).session(session).lean();
      const legacyGRNAccrual = money(legacyEntries.reduce((sum, entry) => sum + Number(entry.credit || 0) - Number(entry.debit || 0), 0));
      if (legacyGRNAccrual > Number(invoice.grandTotal) + MATCH_TOLERANCE) {
        discrepancies.push({
          field: 'legacyGRNAccrual',
          expected: invoice.grandTotal,
          actual: legacyGRNAccrual,
          difference: money(legacyGRNAccrual - Number(invoice.grandTotal)),
          message: 'Existing GRN accrual exceeds this supplier invoice total.',
        });
      }

      invoice.matchReport = {
        ...expectedReport(expected),
        status: discrepancies.length ? 'mismatch' : 'matched',
        legacyGRNAccrual,
        discrepancies,
        matchedAt: new Date(),
        matchedBy: req.user._id,
      };
      invoice.items = expected.lines;
      if (discrepancies.length) {
        await invoice.save({ session });
        result = invoice;
        mismatch = true;
        return;
      }

      const payableDelta = money(Number(invoice.grandTotal) - legacyGRNAccrual);
      if (payableDelta > MATCH_TOLERANCE) {
        await postSubledgerEntry({
          session,
          branch: req.branchId,
          partyType: 'supplier',
          partyId: invoice.supplier,
          amount: payableDelta,
          side: 'credit',
          postingKey: `supplier-invoice:${invoice._id}:verified`,
          entryType: 'purchase',
          entryDate: invoice.invoiceDate,
          description: `Verified supplier invoice ${invoice.invoiceNumber}`,
          referenceNumber: invoice.invoiceRefNumber,
          referenceModel: 'SupplierInvoice',
          referenceId: invoice._id,
          createdBy: req.user._id,
        });
      }
      invoice.status = 'verified';
      invoice.paidAmount = 0;
      invoice.balanceAmount = invoice.grandTotal;
      invoice.verifiedBy = req.user._id;
      invoice.verifiedAt = new Date();
      await invoice.save({ session });
      await GRN.updateMany(
        { _id: { $in: invoice.linkedGRNs }, branch: req.branchId },
        { $set: { payableRecognition: 'invoice' } },
        { session }
      );
      result = invoice;
    });

    if (mismatch) {
      return res.status(409).json({
        success: false,
        code: 'THREE_WAY_MATCH_FAILED',
        message: 'Supplier invoice does not match its purchase orders and posted GRNs.',
        discrepancies: result.matchReport.discrepancies,
        data: result,
      });
    }
    return res.json({
      success: true,
      message: replayed ? 'Supplier invoice is already verified.' : 'Supplier invoice verified and supplier payable recognized.',
      data: result,
    });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

export default router;
