import mongoose from 'mongoose';
import tls from 'node:tls';

// Some Windows networks terminate TLS with a root certificate trusted by the
// OS but not present in Node's bundled CA set. Merge the system trust store
// before the MongoDB driver creates any TLS sockets. This preserves certificate
// verification; it never enables tlsAllowInvalidCertificates.
const configureSystemCATrust = () => {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
  const defaults = tls.getCACertificates('default');
  const system = tls.getCACertificates('system');
  if (system.length) tls.setDefaultCACertificates([...new Set([...defaults, ...system])]);
};

configureSystemCATrust();

const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  const conn = await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  console.log(`   Database: ${conn.connection.name}`);
  return conn;
};

// Runtime connection events are observational. The startup bootstrap decides
// whether an initial connection failure is fatal.
mongoose.connection.on('disconnected', () => {
  console.log('⚠️  MongoDB disconnected');
});

mongoose.connection.on('error', (error) => {
  console.error('❌ MongoDB error:', error.message);
});

export default connectDB;
