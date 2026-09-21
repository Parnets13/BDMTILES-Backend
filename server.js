import 'dotenv/config';
import mongoose from 'mongoose';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import connectDB from './config/db.js';
import errorHandler from './middleware/errorHandler.js';
import authRoutes from './routes/authRoutes.js';
import dealerAuthRoutes from './routes/dealerAuthRoutes.js';
import dealerAppRoutes from './routes/dealerAppRoutes.js';
import dealerDownloadRoutes from './routes/dealerDownloadRoutes.js';
import shopRoutes from './routes/shop/index.js';
import webManagementRoutes from './routes/webManagementRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
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
import stockRoutes from './routes/stockRoutes.js';
import stockAdjustmentRoutes from './routes/stockAdjustmentRoutes.js';
import physicalStockAuditRoutes from './routes/physicalStockAuditRoutes.js';
import pickListRoutes from './routes/pickListRoutes.js';
import dispatchTripRoutes from './routes/dispatchTripRoutes.js';
import deliveryRoutes from './routes/deliveryRoutes.js';
import dispatchReturnRoutes from './routes/dispatchReturnRoutes.js';
import bankReconciliationRoutes from './routes/bankReconciliationRoutes.js';
import documentRoutes from './routes/documentRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import accessPolicyRoutes from './routes/accessPolicyRoutes.js';
import incentiveRoutes from './routes/incentiveRoutes.js';
import targetRoutes from './routes/targetRoutes.js';
import supportChatRoutes from './routes/supportChatRoutes.js';
import branchRoutes from './routes/branchRoutes.js';
import salesExecutiveRoutes from './routes/salesExecutiveRoutes.js';
import dealerOrderRequestRoutes from './routes/dealerOrderRequestRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import { startReservationExpiryScheduler } from './services/reservationExpiryScheduler.js';

const app = express();
const allowedOrigins = String(process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (process.env.TRUST_PROXY) {
  const trustProxy = Number.parseInt(process.env.TRUST_PROXY, 10);
  app.set('trust proxy', Number.isNaN(trustProxy) ? process.env.TRUST_PROXY : trustProxy);
}

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    // React Native doesn't send Origin header, so allow requests without origin
    if (!origin) {
      console.log('[CORS] Request without origin header (likely React Native) - ALLOWED');
      return callback(null, true);
    }
    
    const cleanOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(cleanOrigin)) {
      console.log('[CORS] Origin allowed:', cleanOrigin);
      return callback(null, true);
    }
    
    console.log('[CORS] Origin blocked:', cleanOrigin);
    console.log('[CORS] Allowed origins:', allowedOrigins);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Liveness plus database readiness. Returning 503 prevents callers from
// treating an HTTP listener with an unavailable database as healthy.
app.get('/api/v1/health', (req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({
    success: databaseReady,
    message: databaseReady ? 'BDMTILES API running' : 'BDMTILES API waiting for MongoDB',
    version: '1.0.0',
    database: databaseReady ? 'connected' : 'unavailable',
  });
});

// Auto-log all write operations (POST/PUT/PATCH/DELETE)
app.use('/api/v1', autoLogMiddleware);

// Routes
app.use('/api/v1/shop', shopRoutes); // public customer storefront API
app.use('/api/v1/web-management', webManagementRoutes); // storefront CMS (staff)
app.use('/api/v1/wallets', walletRoutes); // customer BDM Cash wallet management
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/dealer-app/auth', dealerAuthRoutes);
app.use('/api/v1/dealer-app', dealerAppRoutes);
// Token-authorised PDF downloads (opened by the device viewer, not the app itself).
app.use('/api/v1/dealer-downloads', dealerDownloadRoutes);
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
app.use('/api/v1/dealer-order-requests', dealerOrderRequestRoutes);
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
app.use('/api/v1/stock', stockRoutes);
app.use('/api/v1/stock-adjustments', stockAdjustmentRoutes);
app.use('/api/v1/physical-stock-audits', physicalStockAuditRoutes);
app.use('/api/v1/stock-transfers', stockTransferRoutes);
app.use('/api/v1/pick-lists', pickListRoutes);
app.use('/api/v1/dispatch-trips', dispatchTripRoutes);
app.use('/api/v1/deliveries', deliveryRoutes);
app.use('/api/v1/dispatch-returns', dispatchReturnRoutes);
app.use('/api/v1/bank-reconciliation', bankReconciliationRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/access-policies', accessPolicyRoutes);
app.use('/api/v1/incentives', incentiveRoutes);
app.use('/api/v1/targets', targetRoutes); // SE target authoring (facade over target incentive rules)
app.use('/api/v1/support-chat', supportChatRoutes); // admin view of the dealer<->executive thread
app.use('/api/v1/sales-executive', salesExecutiveRoutes);
app.use('/api/v1/attendance', attendanceRoutes);

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
const HOST = process.env.HOST || '0.0.0.0';

let httpServer;
let reservationExpiryScheduler;
let shuttingDown = false;

const start = async () => {
  await connectDB();
  reservationExpiryScheduler = startReservationExpiryScheduler();
  httpServer = app.listen(PORT, HOST, () => {
    console.log(`\n🚀 BDMTILES Backend | http://${HOST}:${PORT} | ${process.env.NODE_ENV || 'development'}\n`);
  });
  return httpServer;
};

const shutdown = async signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received; stopping scheduled work and HTTP listener`);
  await reservationExpiryScheduler?.stop();
  if (httpServer?.listening) await new Promise(resolve => httpServer.close(resolve));
  await mongoose.disconnect();
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).catch(error => {
      console.error(`[server] graceful shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  });
}

start().catch(async (error) => {
  const topologyErrors = error?.reason?.servers
    ? [...error.reason.servers.values()].map(description => description.error?.message).filter(Boolean)
    : [];
  const details = [...new Set(topologyErrors)];
  console.error(`❌ Backend startup failed: ${error.message}`);
  if (details.length) console.error(`   Connection detail: ${details.join(' | ')}`);
  try { await mongoose.disconnect(); }
  catch (disconnectError) { console.error(`   Startup cleanup failed: ${disconnectError.message}`); }
  process.exitCode = 1;
});

export { shutdown, start };
export default app;
