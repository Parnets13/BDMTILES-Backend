import { Router } from 'express';
import mongoose from 'mongoose';
import Lead from '../../models/Lead.js';
import Product from '../../models/Product.js';
import { appendLeadActivity } from '../../services/leadActivityService.js';
import { generateUniqueCode } from '../../utils/codeGenerator.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';

/**
 * Public storefront enquiries are saved as CRM leads, so the sales team can
 * follow them through the existing lead pipeline. This endpoint does not read
 * or modify stock.
 */
const router = Router();
const PROJECT_TYPES = new Set(['residential', 'commercial', 'hospitality', 'industrial', 'renovation', 'other']);

const numericValue = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

// POST /api/v1/shop/enquiry
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.customerName || '').trim();
    const phone = String(body.customerPhone || '').replace(/\D/g, '');
    const email = String(body.customerEmail || '').trim().toLowerCase();
    const quantity = numericValue(body.quantity) ?? 1;
    const productId = String(body.productId || '').trim();

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

    const productName = String(body.productName || product?.itemName || '').trim();
    if (!productName) {
      return res.status(422).json({ success: false, message: 'Product name is required.' });
    }

    // Match catalog pricing and coverage so the CRM estimate stays accurate
    // even if a client omits or sends stale estimated values.
    const unitPrice = product
      ? (Number(product.mrp) > 0 ? Number(product.mrp) : Number(product.retailRate) || 0)
      : null;
    const submittedValue = numericValue(body.estimatedValue);
    const submittedArea = numericValue(body.estimatedArea);
    const estimatedValue = unitPrice !== null ? unitPrice * quantity : (submittedValue ?? 0);
    const estimatedArea = product && Number(product.sqftPerBox) > 0
      ? Number(product.sqftPerBox) * quantity
      : (submittedArea ?? 0);
    const projectType = PROJECT_TYPES.has(body.projectType) ? body.projectType : 'residential';
    const branch = await getOnlineBranchId();
    const leadNumber = await generateUniqueCode(Lead, 'leadNumber', 'LD-', 5);
    const enquiryDetails = [
      `Website ${String(body.enquiryType || 'enquiry').trim()}`,
      `Product: ${productName}`,
      `Quantity: ${quantity}`,
      body.variantLabel ? `Variant: ${String(body.variantLabel).trim()}` : '',
      body.preferredDeliveryDays ? `Preferred delivery: ${Number(body.preferredDeliveryDays)} days` : '',
      String(body.message || '').trim(),
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
      priority: 'medium',
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
      message: 'Thanks — we have your enquiry and will get back to you shortly.',
      data: {
        success: true,
        leadId: String(lead._id),
        leadNumber: lead.leadNumber,
        estimatedArea,
        estimatedValue,
        projectType,
      },
    });
  } catch (error) {
    console.error('[shopEnquiry] Failed to save enquiry:', error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to save enquiry.' });
  }
});

// No GET route: the public endpoint must not expose the CRM lead list.

export default router;
