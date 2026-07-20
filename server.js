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
