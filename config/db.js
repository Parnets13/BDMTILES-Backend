import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import SalesOrder from '../models/SalesOrder.js';

const migrateAttendanceIndexes = async () => {
  const collection = Attendance.collection;
  try {
    await Attendance.createCollection();
  } catch (error) {
    if (error.codeName !== 'NamespaceExists' && error.code !== 48) throw error;
  }

  const indexes = await collection.indexes();
  const legacyIndex = indexes.find(index =>
    index.name === 'employee_1_date_1' &&
    index.unique &&
    index.key?.employee === 1 &&
    index.key?.date === 1 &&
    Object.keys(index.key).length === 2
  );
  if (legacyIndex) {
    await collection.dropIndex(legacyIndex.name);
    console.log('🧹 Removed legacy global attendance uniqueness index');
  }

  await collection.createIndex(
    {branch: 1, employee: 1, date: 1},
    {unique: true, name: 'branch_1_employee_1_date_1'},
  );
};

/**
 * Retires the legacy unique `{ branch, sourceQuotation }` index on salesorders.
 *
 * That index encoded "one quotation becomes exactly one Sales Order". Partial and
 * available-stock conversions deliberately break the assumption — a single
 * quotation can now produce several orders — so the schema declares
 * `{ branch, sourceQuotation, createdAt }` instead.
 *
 * Mongoose never drops an index it no longer declares, so any database created
 * under the old rule keeps enforcing the old rule. The symptom is a second
 * conversion failing with `E11000 ... index: branch_1_sourceQuotation_1`, which
 * reads like an application bug rather than a stale constraint. Build the
 * replacement first, verify it is non-unique, then retire the legacy index —
 * the same order `scripts/migrateQuotationConversions.js` uses, so a boot and an
 * explicit migration converge on the same state.
 */
const migrateSalesOrderQuotationIndexes = async () => {
  const collection = SalesOrder.collection;
  try {
    await SalesOrder.createCollection();
  } catch (error) {
    if (error.codeName !== 'NamespaceExists' && error.code !== 48) throw error;
  }

  await collection.createIndex(
    {branch: 1, sourceQuotation: 1, createdAt: 1},
    {
      name: 'branch_1_sourceQuotation_1_createdAt_1',
      partialFilterExpression: {sourceQuotation: {$type: 'objectId'}},
    },
  );

  const indexes = await collection.indexes();
  const replacement = indexes.find(index => index.name === 'branch_1_sourceQuotation_1_createdAt_1');
  if (!replacement || replacement.unique) {
    throw new Error('Sales Order quotation-history index could not be verified as non-unique.');
  }

  const legacyIndex = indexes.find(index =>
    index.name === 'branch_1_sourceQuotation_1' &&
    index.unique &&
    index.key?.branch === 1 &&
    index.key?.sourceQuotation === 1 &&
    Object.keys(index.key).length === 2
  );
  if (legacyIndex) {
    await collection.dropIndex(legacyIndex.name);
    console.log('🧹 Removed legacy unique salesorders branch/sourceQuotation index');
  }
};

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

/** `mongodb+srv://` cannot resolve without an SRV lookup; a plain URI never needs one. */
const isSrvUri = (uri) => /^mongodb\+srv:\/\//i.test(uri);

/**
 * Some networks refuse SRV queries — an office or VPN resolver that only answers A records, for
 * instance. The failure surfaces as `querySrv ECONNREFUSED`, which reads like the database is
 * down when the real problem is the resolver, and it is a confusing hour to lose.
 *
 * So probe the SRV record BEFORE connecting and, if the local resolver refuses, switch to public
 * resolvers for this process. Doing it as a pre-flight check rather than a retry avoids a second
 * `mongoose.connect()` — mongoose caches the connection promise, so re-connecting after a
 * failure is unreliable.
 *
 * Render and Atlas resolve SRV correctly, so this never fires in production. It only rescues a
 * local or locked-down network, and nothing changes globally unless the probe actually fails.
 *
 * Exported because every script in scripts/ connects directly rather than through connectDB,
 * and they all hit the same wall.
 */
export const ensureSrvResolvable = async (uri) => {
  if (!isSrvUri(uri)) return;

  const host = String(uri).match(/@([^/?:,]+)/)?.[1];
  if (!host) return;

  const dns = await import('dns');
  try {
    await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
  } catch {
    console.warn(`⚠️  This network refused the SRV lookup for ${host} — falling back to public DNS.`);
    dns.setServers(['1.1.1.1', '8.8.8.8']);
    console.warn('   (Set your network DNS to 1.1.1.1 to avoid this.)');
  }
};

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required.');
  }

  await ensureSrvResolvable(uri);

  // MongoDB connection options to handle SSL/TLS certificate issues.
  //
  // TLS is enabled for every non-loopback host, because Atlas and most managed
  // providers require it — that was the original reason this was hardcoded. It is
  // NOT enabled for a loopback host unless the URI asks for it, because a local
  // mongod speaks plaintext and would reject the handshake.
  const options = { tlsAllowInvalidCertificates: true };

  if (!isLoopbackUri(uri) || uriRequestsTls(uri)) {
    options.tls = true;
  }

  // Development/testing: certificate validation disabled to handle Windows SSL issues
  // In production, ensure proper CA certificates are installed or IP is whitelisted

  const conn = await mongoose.connect(uri, options);
  await migrateAttendanceIndexes();
  await migrateSalesOrderQuotationIndexes();
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
