import { Router } from 'express';
import shopAuthRoutes from './shopAuthRoutes.js';
import shopProductRoutes from './shopProductRoutes.js';
import shopOrderRoutes from './shopOrderRoutes.js';
import shopContentRoutes from './shopContentRoutes.js';
import shopWalletRoutes from './shopWalletRoutes.js';

/**
 * Public customer storefront API (BDM Tiles website).
 * Mounted at /api/v1/shop.
 * - /shop/auth     — phone + OTP customer login
 * - /shop/products — public catalog
 * - /shop/orders   — customer order placement + tracking
 * - /shop/content  — home page CMS content
 * - /shop/wallet   — BDM Cash wallet (balance + transactions)
 */
const router = Router();

router.use('/auth', shopAuthRoutes);
router.use('/products', shopProductRoutes);
router.use('/orders', shopOrderRoutes);
router.use('/content', shopContentRoutes);
router.use('/wallet', shopWalletRoutes);

export default router;
