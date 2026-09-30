import { Router } from 'express';
import mongoose from 'mongoose';
import Lead from '../../models/Lead.js';
import Product from '../../models/Product.js';
import { appendLeadActivity } from '../../services/leadActivityService.js';
import { generateUniqueCode } from '../../utils/codeGenerator.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';

const router = Router();
const PROJECT_TYPES = new Set(['residential', 'commercial', 'hospitality', 'industrial', 'renovation', 'other']);

const numericValue = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

// POST /api/v1/shop/enquiry — create a CRM lead from a storefront enquiry.
router.post('/', async (req, res) => {
  try {
    const name = String(req.body.customerName || '').trim();
    const phone = String(req.body.customerPhone || '').replace(/\D/g, '');
    const email = String(req.body.customerEmail || '').trim().toLowerCase();
    const quantity = numericValue(req.body.quantity) ?? 1;
    const productId = String(req.body.productId || '').trim();

    if (!name || !/^\d{10}$/.test(phone)) {
      return res.status(422).json({ success: false, message: 'A customer name and valid 10-digit phone number are required.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(422).json({ success: false, message: 'A valid email address is required.' });
    }
    if (quantity <= 0) {
      return res.status(422).json({ success: false, message: 'Quantity must be greater than zero.' });
    }

    let product = null;
    if (productId) {
      if (!mongoose.isValidObjectId(productId)) {
        return res.status(422).json({ success: false, message: 'Invalid product identifier.' });
      }
      product = await Product.findOne({ _id: productId, status: 'active', onlineVisible: true })
        .select('itemName productCode mrp retailRate sqftPerBox')
        .lean();
      if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    const productName = String(req.body.productName || product?.itemName || '').trim();
    if (!productName) {
      return res.status(422).json({ success: false, message: 'Product name is required.' });
    }

    // Use the same customer-facing price as the product catalog. This prevents
    // the CRM estimate from becoming zero when a client omits or mislabels it.
    const unitPrice = product
      ? (Number(product.mrp) > 0 ? Number(product.mrp) : Number(product.retailRate) || 0)
      : null;
    const submittedValue = numericValue(req.body.estimatedValue);
    const submittedArea = numericValue(req.body.estimatedArea);
    const estimatedValue = unitPrice !== null
      ? unitPrice * quantity
      : (submittedValue ?? 0);
    const estimatedArea = product && Number(product.sqftPerBox) > 0
      ? Number(product.sqftPerBox) * quantity
      : (submittedArea ?? 0);
    const projectType = PROJECT_TYPES.has(req.body.projectType) ? req.body.projectType : 'residential';
    const branch = await getOnlineBranchId();
    const leadNumber = await generateUniqueCode(Lead, 'leadNumber', 'LD-', 5);
    const enquiryDetails = [
      `Enquiry type: ${String(req.body.enquiryType || 'send_enquiry')}`,
      `Quantity: ${quantity}`,
      req.body.variantLabel ? `Variant: ${String(req.body.variantLabel).trim()}` : '',
      req.body.preferredDeliveryDays ? `Preferred delivery: ${Number(req.body.preferredDeliveryDays)} days` : '',
      String(req.body.message || '').trim(),
    ].filter(Boolean).join('\n');

    const lead = await Lead.create({
      leadNumber,
      branch,
      name,
      phone,
      ...(email ? { email } : {}),
      customerType: 'online_enquiry',
      leadSource: 'website',
      leadChannel: 'online',
      leadType: 'product_enquiry',
      interestedProducts: [product?.productCode, productName].filter(Boolean),
      estimatedArea,
      estimatedValue,
      projectType,
      remarks: enquiryDetails,
      status: 'new',
    });

    await appendLeadActivity({
      branch,
      lead,
      type: 'created',
      summary: `Lead ${lead.leadNumber} created from a website enquiry`,
      data: { source: 'website', quantity, estimatedArea, estimatedValue, projectType },
    });

    return res.status(201).json({
      success: true,
      enquiryId: String(lead._id),
      message: 'Enquiry received.',
      data: { success: true, leadId: String(lead._id), leadNumber: lead.leadNumber, estimatedArea, estimatedValue, projectType },
    });
  } catch (error) {
    console.error('[shopEnquiry] Failed to save enquiry:', error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to save enquiry.' });
  }
});

export default router;
