import { Router } from 'express';
import Customer from '../../models/Customer.js';
import { generateCustomerToken } from '../../utils/customerJwt.js';
import { issueOtp, verifyOtp, isValidPhone, normalizePhone } from '../../utils/customerOtp.js';
import { protectCustomer } from '../../middleware/customerAuth.js';

const router = Router();

const publicCustomer = (customer) => ({
  id: customer._id,
  name: customer.name,
  phone: customer.contactNumber,
  whatsappNumber: customer.whatsappNumber || '',
  email: customer.email || '',
  city: customer.city || '',
  state: customer.state || '',
  pinCode: customer.pinCode || '',
  billingAddress: customer.billingAddress || '',
  deliveryAddress: customer.deliveryAddress || '',
});

// POST /api/v1/shop/auth/request-otp  { phone }
router.post('/request-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!isValidPhone(phone)) {
      return res.status(422).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
    }
    const { devOtp } = await issueOtp(phone);
    return res.json({
      success: true,
      message: 'OTP sent.',
      // devOtp is only present when a fixed/dev OTP is configured.
      data: devOtp ? { devOtp } : {},
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/shop/auth/verify-otp  { phone, otp, name? }
router.post('/verify-otp', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const otp = String(req.body?.otp || '').trim();
    if (!isValidPhone(phone)) {
      return res.status(422).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
    }
    const result = verifyOtp(phone, otp);
    if (!result.ok) return res.status(401).json({ success: false, message: result.reason });

    // Find-or-create the customer by phone. contactNumber is not unique in the
    // schema, so we take the most recent active match if several exist.
    let customer = await Customer.findOne({ contactNumber: phone, status: 'active' })
      .sort({ updatedAt: -1 });
    if (!customer) {
      customer = await Customer.create({
        name: String(req.body?.name || '').trim() || `Customer ${phone.slice(-4)}`,
        contactNumber: phone,
        customerType: 'retail',
        source: 'online',
        status: 'active',
      });
    } else if (req.body?.name && !customer.name?.trim()) {
      customer.name = String(req.body.name).trim();
      await customer.save();
    }

    const token = generateCustomerToken(customer._id, phone);
    return res.json({
      success: true,
      message: 'Logged in.',
      token,
      data: { customer: publicCustomer(customer) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/v1/shop/auth/me
router.get('/me', protectCustomer, (req, res) => {
  res.json({ success: true, data: { customer: publicCustomer(req.customer) } });
});

// PUT /api/v1/shop/auth/profile  — update name/email/address for the logged-in customer
router.put('/profile', protectCustomer, async (req, res) => {
  try {
    const editable = ['name', 'email', 'whatsappNumber', 'city', 'state', 'pinCode', 'billingAddress', 'deliveryAddress'];
    const update = {};
    for (const key of editable) {
      if (req.body?.[key] !== undefined) update[key] = String(req.body[key]).trim();
    }
    const customer = await Customer.findByIdAndUpdate(req.customer._id, { $set: update }, { new: true, runValidators: true });
    if (!customer) return res.status(404).json({ success: false, message: 'Account not found.' });
    return res.json({ success: true, message: 'Profile updated.', data: { customer: publicCustomer(customer) } });
  } catch (error) {
    return res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

// POST /api/v1/shop/auth/logout — stateless (client drops token)
router.post('/logout', (_req, res) => res.json({ success: true, message: 'Logged out.' }));

export default router;
