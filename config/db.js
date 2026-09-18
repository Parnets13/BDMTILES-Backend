import mongoose from 'mongoose';

const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  // MongoDB connection options to handle SSL/TLS certificate issues
  const options = {
    // Use system CA certificates (helps with corporate proxies and custom CAs)
    tls: true,
    tlsAllowInvalidCertificates: false, // Keep certificate validation enabled for security
  };

  // For development/testing only: disable certificate validation if needed
  // Uncomment the line below ONLY if you're in a development environment with certificate issues
  // options.tlsAllowInvalidCertificates = true;

  const conn = await mongoose.connect(process.env.MONGODB_URI, options);
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
