import mongoose from 'mongoose';

/**
 * Whether the connection string points at this machine.
 *
 * A local mongod serves plaintext. Forcing TLS at it fails the handshake with
 * `read ECONNRESET`, which is a confusing error that looks like the database is
 * down when it is in fact refusing the protocol. `.env.example` documents
 * `mongodb://localhost:27017/bdmtiles` as the local setup, so this case has to
 * work out of the box.
 */
const isLoopbackUri = (uri) => /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\]|::1)(:|\/|$)/i.test(uri);

/** An explicit `?tls=true` in the URI is always honoured, whatever the host. */
const uriRequestsTls = (uri) => /[?&]tls=(true|1)/i.test(uri);

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required.');
  }

  // MongoDB connection options to handle SSL/TLS certificate issues.
  //
  // TLS is enabled for every non-loopback host, because Atlas and most managed
  // providers require it — that was the original reason this was hardcoded. It is
  // NOT enabled for a loopback host unless the URI asks for it, because a local
  // mongod speaks plaintext and would reject the handshake.
  const options = { tlsAllowInvalidCertificates: false };

  if (!isLoopbackUri(uri) || uriRequestsTls(uri)) {
    options.tls = true;
  }

  // For development/testing only: disable certificate validation if needed
  // Uncomment the line below ONLY if you're in a development environment with certificate issues
  // options.tlsAllowInvalidCertificates = true;

  const conn = await mongoose.connect(uri, options);
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
