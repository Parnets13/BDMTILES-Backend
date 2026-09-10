import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import connectDB from './config/db.js';
import errorHandler from './middleware/errorHandler.js';
import authRoutes from './routes/authRoutes.js';
import shopRoutes from './routes/shop/index.js';
import webManagementRoutes from './routes/webManagementRoutes.js';
import userRoutes from './routes/userRoutes.js';
import categoryRoutes from './routes/categoryRoutes.js';
import productRoutes from './routes/productRoutes.js';
import masterRoutes from './routes/masterRoutes.js';
import salesOrderRoutes from './routes/salesOrderRoutes.js';
import hrmsRoutes from './routes/hrmsRoutes.js';
import purchaseRoutes from './routes/purchaseRoutes.js';
import salesReturnRoutes from './routes/salesReturnRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import dealerPricingRoutes from './routes/dealerPricingRoutes.js';
import supplierInvoiceRoutes from './routes/supplierInvoiceRoutes.js';
import purchaseReturnRoutes from './routes/purchaseReturnRoutes.js';
import quotationRoutes from './routes/quotationRoutes.js';
import ledgerRoutes from './routes/ledgerRoutes.js';
import chequeRoutes from './routes/chequeRoutes.js';
import voucherRoutes from './routes/voucherRoutes.js';
import dispatchRoutes from './routes/dispatchRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import complaintRoutes from './routes/complaintRoutes.js';
import approvalRoutes from './routes/approvalRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import schemeRoutes from './routes/schemeRoutes.js';
import systemRoutes from './routes/systemRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import expenseRoutes from './routes/expenseRoutes.js';
import sampleRoutes from './routes/sampleRoutes.js';
import { autoLogMiddleware } from './middleware/activityLogger.js';
import dailyWageRoutes from './routes/dailyWageRoutes.js';
import purchaseRequisitionRoutes from './routes/purchaseRequisitionRoutes.js';
import supplierQuotationRoutes from './routes/supplierQuotationRoutes.js';
import assetRoutes from './routes/assetRoutes.js';
import discountMappingRoutes from './routes/discountMappingRoutes.js';
import invoiceRoutes from './routes/invoiceRoutes.js';
import stockTransferRoutes from './routes/stockTransferRoutes.js';
import pickListRoutes from './routes/pickListRoutes.js';
import dispatchTripRoutes from './routes/dispatchTripRoutes.js';
import deliveryRoutes from './routes/deliveryRoutes.js';
import bankReconciliationRoutes from './routes/bankReconciliationRoutes.js';
import documentRoutes from './routes/documentRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import accessPolicyRoutes from './routes/accessPolicyRoutes.js';
import incentiveRoutes from './routes/incentiveRoutes.js';
import branchRoutes from './routes/branchRoutes.js';

import dns from 'dns';

dns.setServers(['8.8.8.8', '8.8.4.4']);

const app = express();
const allowedOrigins = String(process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (process.env.TRUST_PROXY) {
  const trustProxy = Number.parseInt(process.env.TRUST_PROXY, 10);
  app.set('trust proxy', Number.isNaN(trustProxy) ? process.env.TRUST_PROXY : trustProxy);
}

connectDB();

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Health check
app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, message: 'BDMTILES API running', version: '1.0.0' });
});

// Auto-log all write operations (POST/PUT/PATCH/DELETE)
app.use('/api/v1', autoLogMiddleware);

// Routes
app.use('/api/v1/shop', shopRoutes); // public customer storefront API
app.use('/api/v1/web-management', webManagementRoutes); // storefront CMS (staff)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/category-setup', categoryRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/masters/branches', branchRoutes);
app.use('/api/v1/masters', masterRoutes);
app.use('/api/v1/sales-orders', salesOrderRoutes);
app.use('/api/v1/hrms', hrmsRoutes);
app.use('/api/v1/purchase', purchaseRoutes);
app.use('/api/v1/sales-returns', salesReturnRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/dealer-pricing', dealerPricingRoutes);
app.use('/api/v1/supplier-invoices', supplierInvoiceRoutes);
app.use('/api/v1/purchase-returns', purchaseReturnRoutes);
app.use('/api/v1/quotations', quotationRoutes);
app.use('/api/v1/ledger', ledgerRoutes);
app.use('/api/v1/cheques', chequeRoutes);
app.use('/api/v1/vouchers', voucherRoutes);
app.use('/api/v1/dispatch', dispatchRoutes);
app.use('/api/v1/leads', leadRoutes);
app.use('/api/v1/complaints', complaintRoutes);
app.use('/api/v1/approvals', approvalRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/schemes', schemeRoutes);
app.use('/api/v1/system', systemRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/expenses', expenseRoutes);
app.use('/api/v1/samples', sampleRoutes);
app.use('/api/v1/daily-wages', dailyWageRoutes);
app.use('/api/v1/purchase-requisitions', purchaseRequisitionRoutes);
app.use('/api/v1/supplier-quotations', supplierQuotationRoutes);
app.use('/api/v1/assets', assetRoutes);
app.use('/api/v1/discount-mappings', discountMappingRoutes);
app.use('/api/v1/invoices', invoiceRoutes);
app.use('/api/v1/stock-transfers', stockTransferRoutes);
app.use('/api/v1/pick-lists', pickListRoutes);
app.use('/api/v1/dispatch-trips', dispatchTripRoutes);
app.use('/api/v1/deliveries', deliveryRoutes);
app.use('/api/v1/bank-reconciliation', bankReconciliationRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/access-policies', accessPolicyRoutes);
app.use('/api/v1/incentives', incentiveRoutes);

// Static uploads (supplier financial evidence is never public)
app.use('/uploads/supplier-credit-notes', (_req, res) => res.status(404).json({ success: false, message: 'Not found.' }));
app.use('/uploads', express.static('uploads'));

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.originalUrl} not found` });
});

// Error handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 BDMTILES Backend | Port ${PORT} | ${process.env.NODE_ENV || 'development'}\n`);
});

export default app;
