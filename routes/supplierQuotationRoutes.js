import { Router } from 'express';
import mongoose from 'mongoose';
import SupplierQuotation from '../models/SupplierQuotation.js';
import PurchaseRequisition from '../models/PurchaseRequisition.js';
import Product from '../models/Product.js';
import Supplier from '../models/Supplier.js';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { assertWarehousesInBranch, requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { requestFingerprint } from '../utils/idempotency.js';
import { convertRequisitionToPurchaseOrder, purchaseError } from '../services/purchaseOrderService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const errorStatus = error => error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 422 : error.code === 11000 ? 409 : 500);
const sendError = (res, error) => res.status(errorStatus(error)).json({ success: false, message: error.code === 11000 ? 'A supplier quotation already exists for this requisition or document number.' : error.message });

const MINIMUM_COMPLETE_OFFERS = 2;
const assertCompleteComparison = (offers) => {
  if (!Array.isArray(offers) || offers.length < MINIMUM_COMPLETE_OFFERS) {
    throw purchaseError(422, 'At least two distinct complete supplier offers are required for comparison.');
  }
  const supplierIds = offers.map(offer => String(offer.supplier || ''));
  if (supplierIds.some(id => !id) || new Set(supplierIds).size !== offers.length) {
    throw purchaseError(422, 'At least two distinct complete supplier offers are required for comparison.');
  }
};

const normalizeOffers = async ({ offers, requisition, session = null }) => {
  assertCompleteComparison(offers);
  const supplierIds = offers.map(offer => offer.supplier);
  if (supplierIds.some(id => !mongoose.isValidObjectId(id))) throw purchaseError(422, 'One or more supplier identifiers are invalid.');
  if (new Set(supplierIds.map(String)).size !== supplierIds.length) throw purchaseError(422, 'A supplier may appear only once in a comparison event.');
  let supplierQuery = Supplier.find({ _id: { $in: supplierIds }, status: 'active' }).lean();
  if (session) supplierQuery = supplierQuery.session(session);
  const suppliers = await supplierQuery;
  const supplierMap = new Map(suppliers.map(supplier => [String(supplier._id), supplier]));
  if (supplierMap.size !== supplierIds.length) throw purchaseError(404, 'One or more active suppliers were not found.');

  const prProducts = [...new Set(requisition.items.map(item => String(item.product)))];
  let productQuery = Product.find({ _id: { $in: prProducts }, status: { $ne: 'inactive' } }).select('itemName productCode unit gst').lean();
  if (session) productQuery = productQuery.session(session);
  const products = await productQuery;
  const productMap = new Map(products.map(product => [String(product._id), product]));
  if (productMap.size !== prProducts.length) throw purchaseError(404, 'One or more requisition products are unavailable.');
  const ambiguousProducts = new Set(prProducts.filter(id => requisition.items.filter(item => String(item.product) === id).length > 1));

  return offers.map((offer, offerIndex) => {
    const supplier = supplierMap.get(String(offer.supplier));
    if (!Array.isArray(offer.items) || offer.items.length !== requisition.items.length) throw purchaseError(422, `offers[${offerIndex}] must quote every requisition item.`);
    const usedLines = new Set();
    let itemTotal = 0;
    const items = offer.items.map((item, itemIndex) => {
      let prItem = item.requisitionItem
        ? requisition.items.id?.(item.requisitionItem)
        : null;
      if (!prItem && !ambiguousProducts.has(String(item.product))) {
        prItem = requisition.items.find(line => String(line.product) === String(item.product));
      }
      if (!prItem || usedLines.has(String(prItem._id || prItem.product))) throw purchaseError(422, `offers[${offerIndex}].items[${itemIndex}] does not uniquely match a requisition item.`);
      if (String(prItem.product) !== String(item.product)) throw purchaseError(422, `offers[${offerIndex}].items[${itemIndex}] product mismatch.`);
      if (Number(item.quantity) !== Number(prItem.requiredQty)) throw purchaseError(422, `offers[${offerIndex}].items[${itemIndex}] quantity must equal the requisition quantity.`);
      usedLines.add(String(prItem._id || prItem.product));
      const product = productMap.get(String(item.product));
      const quantity = Number(item.quantity);
      const offeredRate = Number(item.offeredRate);
      const discount = Number(item.discount || 0);
      const schemeDiscount = Number(item.schemeDiscount || 0);
      const gstPercentage = Number(item.gstPercentage ?? product.gst ?? 18);
      if (![quantity, offeredRate, discount, schemeDiscount, gstPercentage].every(Number.isFinite) || quantity <= 0 || offeredRate < 0 || discount < 0 || schemeDiscount < 0 || gstPercentage < 0 || gstPercentage > 100) {
        throw purchaseError(422, `offers[${offerIndex}].items[${itemIndex}] contains invalid commercial values.`);
      }
      const base = money(quantity * offeredRate);
      if (discount + schemeDiscount > base) throw purchaseError(422, `offers[${offerIndex}].items[${itemIndex}] discounts exceed base amount.`);
      const taxableAmount = money(base - discount - schemeDiscount);
      const taxAmount = money(taxableAmount * gstPercentage / 100);
      const lineTotal = money(taxableAmount + taxAmount);
      itemTotal = money(itemTotal + lineTotal);
      return {
        requisitionItem: prItem._id,
        product: product._id,
        productCode: product.productCode || '',
        productName: product.itemName,
        quantity,
        unit: product.unit || 'Box',
        offeredRate,
        discount,
        schemeDiscount,
        scheme: String(item.scheme || ''),
        gstPercentage,
        taxableAmount,
        taxAmount,
        lineTotal,
      };
    });
    const freight = Number(offer.freight || 0);
    const loading = Number(offer.loading || 0);
    const insurance = Number(offer.insurance || 0);
    const creditDays = Number(offer.creditDays ?? supplier.creditDays ?? 0);
    if (![freight, loading, insurance, creditDays].every(value => Number.isFinite(value) && value >= 0)) throw purchaseError(422, `offers[${offerIndex}] contains invalid charges or credit days.`);
    const charges = money(freight + loading + insurance);
    const totalLandedAmount = money(itemTotal + charges);
    const normalizedItems = items.map(item => ({ ...item, normalizedLandedAmount: money(item.lineTotal + (itemTotal ? charges * item.lineTotal / itemTotal : charges / items.length)) }));
    return {
      supplier: supplier._id,
      supplierSnapshot: {
        supplierCode: supplier.supplierCode || '', companyName: supplier.companyName,
        contactPerson: supplier.contactPerson || '', mobile: supplier.mobile || '',
        email: supplier.email || '', gstin: supplier.gstin || '',
      },
      supplierRating: Number(supplier.performanceRating || 0),
      items: normalizedItems,
      freight, loading, insurance, creditDays,
      paymentTerms: String(offer.paymentTerms ?? supplier.paymentTerms ?? ''),
      promisedDeliveryDate: offer.promisedDeliveryDate || undefined,
      deliveryTimeline: String(offer.deliveryTimeline || ''),
      totalLandedAmount,
      remarks: String(offer.remarks || ''),
      documents: Array.isArray(offer.documents) ? offer.documents.map(document => ({
        name: String(document.name || ''), type: String(document.type || ''),
        url: String(document.url || ''), reference: String(document.reference || ''),
      })) : [],
    };
  });
};

router.get('/', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { branch: req.branchId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.purchaseRequisition) filter.purchaseRequisition = req.query.purchaseRequisition;
    const [data, total] = await Promise.all([
      SupplierQuotation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('purchaseRequisition', 'prNumber status').populate('selectedSupplier', 'companyName supplierCode').lean(),
      SupplierQuotation.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalItems: total } });
  } catch (error) { return sendError(res, error); }
});

router.get('/:id', requireAnyPermission('po.management', 'po.approve'), async (req, res) => {
  try {
    const quotation = await SupplierQuotation.findOne({ _id: req.params.id, branch: req.branchId })
      .populate('purchaseRequisition', 'prNumber status items').populate('offers.supplier', 'companyName supplierCode performanceRating').lean();
    if (!quotation) throw purchaseError(404, 'Supplier quotation not found.');
    return res.json({ success: true, data: quotation });
  } catch (error) { return sendError(res, error); }
});

router.post('/', requirePermission('po.management'), async (req, res) => {
  try {
    const pr = await PurchaseRequisition.findOne({ _id: req.body.purchaseRequisition, branch: req.branchId, status: 'approved' });
    if (!pr) throw purchaseError(404, 'Approved purchase requisition not found in the active branch.');
    const warehouse = req.body.warehouse || pr.warehouse;
    if (!warehouse) throw purchaseError(422, 'A receiving warehouse is required.');
    await assertWarehousesInBranch([warehouse], req.branchId);
    const offers = await normalizeOffers({ offers: req.body.offers, requisition: pr });
    const quotation = await SupplierQuotation.create({
      quotationNumber: await generateBranchNumber(req.branchId, 'supplierQuotation', new Date()),
      branch: req.branchId,
      purchaseRequisition: pr._id,
      prNumber: pr.prNumber,
      warehouse,
      offers,
      status: 'draft',
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    return res.status(201).json({ success: true, message: 'Supplier quotation comparison created.', data: quotation });
  } catch (error) { return sendError(res, error); }
});

router.put('/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const quotation = await SupplierQuotation.findOne({ _id: req.params.id, branch: req.branchId });
    if (!quotation) throw purchaseError(404, 'Supplier quotation not found.');
    if (quotation.status !== 'draft') throw purchaseError(409, 'Only a draft supplier quotation can be updated.');
    const pr = await PurchaseRequisition.findOne({ _id: quotation.purchaseRequisition, branch: req.branchId, status: 'approved' });
    if (!pr) throw purchaseError(409, 'The linked purchase requisition is no longer approved.');
    const warehouse = req.body.warehouse || quotation.warehouse;
    await assertWarehousesInBranch([warehouse], req.branchId);
    quotation.warehouse = warehouse;
    quotation.offers = await normalizeOffers({ offers: req.body.offers || quotation.offers.map(offer => offer.toObject()), requisition: pr });
    quotation.updatedBy = req.user._id;
    await quotation.save();
    return res.json({ success: true, message: 'Supplier quotation updated.', data: quotation });
  } catch (error) { return sendError(res, error); }
});

router.delete('/:id', requirePermission('po.management'), async (req, res) => {
  try {
    const deleted = await SupplierQuotation.findOneAndDelete({ _id: req.params.id, branch: req.branchId, status: 'draft' });
    if (!deleted) throw purchaseError(409, 'Only an existing draft supplier quotation can be deleted.');
    return res.json({ success: true, message: 'Supplier quotation deleted.' });
  } catch (error) { return sendError(res, error); }
});

router.patch('/:id/submit', requirePermission('po.management'), async (req, res) => {
  try {
    const current = await SupplierQuotation.findOne({ _id: req.params.id, branch: req.branchId, status: 'draft' });
    if (!current) throw purchaseError(409, 'Only a draft supplier quotation can be submitted.');
    const pr = await PurchaseRequisition.findOne({ _id: current.purchaseRequisition, branch: req.branchId, status: 'approved' });
    if (!pr) throw purchaseError(409, 'The linked purchase requisition must remain approved before submission.');
    await normalizeOffers({ offers: current.offers.map(offer => offer.toObject()), requisition: pr });
    const quotation = await SupplierQuotation.findOneAndUpdate(
      { _id: current._id, branch: req.branchId, status: 'draft' },
      { $set: { status: 'submitted', submittedAt: new Date(), submittedBy: req.user._id, updatedBy: req.user._id } },
      { new: true, runValidators: true }
    );
    if (!quotation) throw purchaseError(409, 'Supplier quotation changed while it was being submitted.');
    return res.json({ success: true, message: 'Supplier quotation submitted.', data: quotation });
  } catch (error) { return sendError(res, error); }
});

router.post('/:id/compare', requirePermission('po.management'), async (req, res) => {
  try {
    const quotation = await SupplierQuotation.findOne({ _id: req.params.id, branch: req.branchId, status: { $in: ['submitted', 'compared'] } });
    if (!quotation) throw purchaseError(409, 'Only a submitted supplier quotation can be compared.');
    const pr = await PurchaseRequisition.findOne({ _id: quotation.purchaseRequisition, branch: req.branchId, status: 'approved' });
    if (!pr) throw purchaseError(409, 'The linked purchase requisition must remain approved before comparison.');
    await normalizeOffers({ offers: quotation.offers.map(offer => offer.toObject()), requisition: pr });
    const ranked = quotation.offers.map(offer => {
      const totalQty = offer.items.reduce((sum, item) => sum + Number(item.quantity), 0);
      return {
        offer: offer._id,
        supplier: offer.supplier,
        supplierName: offer.supplierSnapshot.companyName,
        totalLandedAmount: offer.totalLandedAmount,
        normalizedUnitCost: money(totalQty ? offer.totalLandedAmount / totalQty : offer.totalLandedAmount),
        supplierRating: offer.supplierRating,
        creditDays: offer.creditDays,
        promisedDeliveryDate: offer.promisedDeliveryDate,
      };
    }).sort((a, b) => a.totalLandedAmount - b.totalLandedAmount || b.supplierRating - a.supplierRating || b.creditDays - a.creditDays)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    const rankMap = new Map(ranked.map(entry => [String(entry.offer), entry.rank]));
    quotation.offers.forEach(offer => { offer.rank = rankMap.get(String(offer._id)); });
    quotation.comparison = ranked;
    quotation.status = 'compared';
    quotation.updatedBy = req.user._id;
    await quotation.save();
    return res.json({ success: true, message: 'Supplier offers compared.', data: { quotation, comparison: ranked } });
  } catch (error) { return sendError(res, error); }
});

router.patch('/:id/select-final-supplier', requirePermission('po.approve'), async (req, res) => {
  try {
    const quotation = await SupplierQuotation.findOne({ _id: req.params.id, branch: req.branchId, status: 'compared' });
    if (!quotation) throw purchaseError(409, 'Compare submitted offers before selecting a supplier.');
    const offer = quotation.offers.id(req.body.offerId);
    if (!offer) throw purchaseError(422, 'Selected offer does not belong to this comparison.');
    quotation.selectedOffer = offer._id;
    quotation.selectedSupplier = offer.supplier;
    quotation.selectedAt = new Date();
    quotation.selectedBy = req.user._id;
    quotation.selectionRemarks = String(req.body.remarks || '');
    quotation.status = 'selected';
    quotation.updatedBy = req.user._id;
    await quotation.save();
    return res.json({ success: true, message: 'Final supplier selected.', data: quotation });
  } catch (error) { return sendError(res, error); }
});

router.post('/:id/convert-to-po', requirePermission('po.management'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const quotation = await SupplierQuotation.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!quotation) throw purchaseError(404, 'Supplier quotation not found.');
      if (quotation.linkedPO || quotation.status === 'po_created') {
        const po = await mongoose.model('PurchaseOrder').findOne({ _id: quotation.linkedPO, branch: req.branchId }).session(session);
        if (!po) throw purchaseError(409, 'Supplier quotation is already converted.');
        result = { po, quotation, replayed: true };
        return;
      }
      if (quotation.status !== 'selected') throw purchaseError(409, 'Select a final supplier before PO conversion.');
      const offer = quotation.offers.id(quotation.selectedOffer);
      if (!offer || String(offer.supplier) !== String(quotation.selectedSupplier)) throw purchaseError(409, 'Selected supplier offer is invalid.');
      const payload = {
        supplier: offer.supplier,
        receivingWarehouse: quotation.warehouse,
        items: offer.items.map(item => ({
          requisitionItem: item.requisitionItem, product: item.product, quantity: item.quantity,
          unit: item.unit, rate: item.offeredRate, discount: item.discount,
          schemeDiscount: item.schemeDiscount, scheme: item.scheme, gstPercentage: item.gstPercentage,
        })),
        freight: offer.freight, loading: offer.loading, insurance: offer.insurance,
        creditDays: offer.creditDays, paymentTerms: offer.paymentTerms,
        expectedDeliveryDate: offer.promisedDeliveryDate,
        remarks: [offer.remarks, quotation.selectionRemarks].filter(Boolean).join(' | '),
      };
      const fingerprint = requestFingerprint(payload);
      const conversion = await convertRequisitionToPurchaseOrder({
        branchId: req.branchId, requisitionId: quotation.purchaseRequisition, input: payload,
        actorId: req.user._id, sourceKey: `supplier-quotation:${quotation._id}`,
        requestFingerprint: fingerprint, sourceSupplierQuotation: quotation._id,
        sourceSupplierOffer: offer._id, session,
      });
      const updated = await SupplierQuotation.findOneAndUpdate(
        { _id: quotation._id, branch: req.branchId, status: 'selected', linkedPO: { $exists: false } },
        { $set: { status: 'po_created', linkedPO: conversion.po._id, updatedBy: req.user._id } },
        { new: true, session }
      );
      if (!updated) throw purchaseError(409, 'Supplier quotation was converted concurrently.');
      result = { ...conversion, quotation: updated };
    });
    return res.status(result.replayed ? 200 : 201).json({ success: true, message: result.replayed ? 'Purchase order already created.' : 'Selected supplier offer converted to purchase order.', data: result });
  } catch (error) { return sendError(res, error); }
  finally { await session.endSession(); }
});

export default router;
