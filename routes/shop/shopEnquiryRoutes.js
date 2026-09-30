import { Router } from 'express';
import mongoose from 'mongoose';
import Lead from '../../models/Lead.js';
import { getOnlineBranchId } from '../../utils/onlineBranch.js';

/**
 * Public storefront enquiries.
 *
 * The website's "Stock Not Available" / "Request Quotation" forms POST here. They used to POST
 * to `/api/enquiry`, which existed nowhere — the form failed with a 404 and the customer saw
 * "Request failed" with no way forward.
 *
 * The enquiry becomes a LEAD rather than a private record of its own, so it lands in the
 * pipeline the sales team already works from. A form that writes somewhere nobody looks is
 * worse than no form at all.
 *
 * No auth: this is the public website. The payload is therefore validated and nothing from the
 * request is trusted beyond the fields below.
 */
const router = Router();

const digitsOf = (value) => String(value || '').replace(/\D/g, '');

router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.customerName || '').trim();
    const phone = String(req.body?.customerPhone || '').trim();
    const email = String(req.body?.customerEmail || '').trim();
    const message = String(req.body?.message || '').trim();
    const productName = String(req.body?.productName || '').trim();
    const enquiryType = String(req.body?.enquiryType || 'enquiry').trim();
    const quantity = Number(req.body?.quantity) || 0;

    if (!name) {
      return res.status(422).json({ success: false, message: 'Please enter your name.' });
    }
    const digits = digitsOf(phone);
    if (digits.length < 10) {
      return res.status(422).json({ success: false, message: 'Please enter a valid phone number.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(422).json({ success: false, message: 'Please check the email address.' });
    }

    const branchId = await getOnlineBranchId();
    const { generateUniqueCode } = await import('../../utils/codeGenerator.js');
    const leadNumber = await generateUniqueCode(Lead, 'leadNumber', 'LD-', 5);

    // Everything the customer told us, in one readable block — so whoever picks this up does
    // not have to reconstruct the request from separate columns.
    const remarks = [
      `Website ${enquiryType}`,
      productName ? `Product: ${productName}` : '',
      quantity ? `Quantity: ${quantity}` : '',
      message,
    ].filter(Boolean).join('\n');

    const lead = await Lead.create({
      leadNumber,
      branch: branchId,
      name,
      phone: digits.length === 10 ? digits : phone,
      email: email || undefined,
      customerType: 'online_enquiry',
      leadChannel: 'online',
      leadSource: 'website',
      interestedProducts: productName ? [productName] : [],
      remarks,
      status: 'new',
      priority: 'medium',
    });

    return res.status(201).json({
      success: true,
      enquiryId: String(lead._id),
      message: 'Thanks — we have your enquiry and will get back to you shortly.',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET / — deliberately absent. A public endpoint must not expose the lead list.

export default router;
