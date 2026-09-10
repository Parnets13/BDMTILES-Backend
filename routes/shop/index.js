import { Router } from 'express';
import shopAuthRoutes from './shopAuthRoutes.js';
import shopProductRoutes from './shopProductRoutes.js';
import shopOrderRoutes from './shopOrderRoutes.js';
import shopContentRoutes from './shopContentRoutes.js';

/**
 * Public customer storefront API (BDM Tiles website).
 * Mounted at /api/v1/shop. Completely separate from staff/CRM/warehouse routes:
 * - /shop/auth     — phone + OTP customer login (customer JWT)
 * - /shop/products — public catalog (online-visible products only, no auth)
 * - /shop/orders   — customer order placement + tracking (customer JWT)
 * - /shop/content  — home page CMS content (hero/banners/categories/testimonials)
 */
const router = Router();

router.use('/auth', shopAuthRoutes);
router.use('/products', shopProductRoutes);
router.use('/orders', shopOrderRoutes);
router.use('/content', shopContentRoutes);

export default router;
