import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import connectDB from './config/db.js';
import errorHandler from './middleware/errorHandler.js';
import authRoutes from './routes/authRoutes.js';
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
import dailyWageRoutes from './routes/dailyWageRoutes.js';
import expenseRoutes from './routes/expenseRoutes.js';
import purchaseRequisitionRoutes from './routes/purchaseRequisitionRoutes.js';
import assetRoutes from './routes/assetRoutes.js';

dotenv.config();

const app = express();

connectDB();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Health check
app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, message: 'BDMTILES API running', version: '1.0.0' });
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/category-setup', categoryRoutes);
app.use('/api/v1/products', productRoutes);
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
app.use('/api/v1/daily-wages', dailyWageRoutes);
app.use('/api/v1/expenses', expenseRoutes);
app.use('/api/v1/purchase-requisitions', purchaseRequisitionRoutes);
app.use('/api/v1/assets', assetRoutes);

// Static uploads
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
