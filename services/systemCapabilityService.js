import fs from 'fs';
import mongoose from 'mongoose';
import Dealer from '../models/Dealer.js';
import Notification from '../models/Notification.js';
import RecycleBin from '../models/RecycleBin.js';
import SalesOrder from '../models/SalesOrder.js';
import { hrGeneratedDocumentDirectory, candidateResumeDirectory } from '../middleware/upload.js';

/**
 * Truthful reporting of what this deployment can and cannot actually do.
 *
 * This module exists because the requirement document lists eighteen external
 * integrations, and none of them are implemented. An admin screen that offered
 * credential fields for WhatsApp or Tally would imply those pipelines work, and
 * an owner would then rely on messages that are never sent. So instead of a
 * configuration UI for absent code, this reports readiness — and wherever it can,
 * it derives the answer from live evidence (environment variables actually set,
 * rows that have actually synced) rather than from a claim in a config file.
 *
 * WHEN AN INTEGRATION IS BUILT: set `implemented: true` on its entry and give it
 * a `probe`. Leaving a stale `false` here is the only way this file can lie.
 */

const ENV_PRESENT = (...keys) => keys.every((key) => Boolean(process.env[key]));

const smtpConfigured = () => ENV_PRESENT('SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS');

// Mirrors the channel handling in services/notificationService.js. Only 'web' has
// a provider; every other channel is recorded as skipped. Kept as a single source
// of truth so the UI cannot drift from the dispatcher's real behaviour.
export const NOTIFICATION_CHANNELS = [
  {
    channel: 'web',
    label: 'In-App Inbox',
    provider: 'inbox',
    available: true,
    note: 'Delivered to the notification inbox inside this application.',
  },
  {
    channel: 'email',
    label: 'Email',
    provider: 'nodemailer (SMTP)',
    available: false,
    note: 'SMTP is used for password-reset mail only. The notification dispatcher has no email provider wired in, so notification emails are recorded as skipped.',
  },
  {
    channel: 'whatsapp',
    label: 'WhatsApp',
    provider: null,
    available: false,
    note: 'No WhatsApp Business API client exists in this build. Selecting this channel records the attempt as skipped.',
  },
  {
    channel: 'sms',
    label: 'SMS',
    provider: null,
    available: false,
    note: 'No SMS gateway client exists in this build. Selecting this channel records the attempt as skipped.',
  },
  {
    channel: 'push',
    label: 'Mobile Push',
    provider: null,
    available: false,
    note: 'User.fcmToken is captured but nothing sends to it — there is no Firebase/FCM client in this build.',
  },
];

export function channelCapabilities() {
  const channels = NOTIFICATION_CHANNELS.map((entry) => ({
    ...entry,
    // Email is the one case where credentials can exist while the pipeline does
    // not, so the two facts are reported separately instead of being conflated.
    envConfigured: entry.channel === 'email' ? smtpConfigured() : entry.available,
  }));
  return {
    channels,
    deliverableChannels: channels.filter((c) => c.available).map((c) => c.channel),
    skippedChannels: channels.filter((c) => !c.available).map((c) => c.channel),
    summary: 'Only the in-app inbox has a delivery provider. Other channels can be selected and are stored on the notification, but every attempt is recorded as skipped rather than sent.',
  };
}

/**
 * The eighteen integrations named in the requirement document, each with its real
 * status. `evidence` is filled in at request time where a live check is possible.
 */
const INTEGRATION_CATALOGUE = [
  {
    key: 'tally',
    name: 'Tally',
    category: 'Accounting',
    implemented: false,
    detail: 'Sync fields (tallySyncStatus, tallyGUID, tallyVoucherNumber) exist on 17 models and are initialised, but no exporter, voucher push or reconciliation code exists. The tally.sync and tally.reconciliation permissions are granted to roles but gate no route.',
  },
  {
    key: 'whatsapp',
    name: 'WhatsApp Business API',
    category: 'Messaging',
    implemented: false,
    detail: 'Notification templates can be authored with channel "whatsapp", but there is no API client, so nothing is ever sent.',
  },
  {
    key: 'sms',
    name: 'SMS Gateway',
    category: 'Messaging',
    implemented: false,
    detail: 'Storefront OTP uses an in-memory development stub that does not survive a restart and does not send messages.',
  },
  {
    key: 'email',
    name: 'Email (SMTP)',
    category: 'Messaging',
    implemented: true,
    partial: true,
    detail: 'Working for password-reset mail only, and silently no-ops when SMTP credentials are absent. Not connected to the notification dispatcher.',
    probe: () => ({
      configured: smtpConfigured(),
      note: smtpConfigured()
        ? 'SMTP credentials are present, so password-reset mail can be sent.'
        : 'SMTP credentials are not set, so password-reset mail is skipped silently.',
    }),
  },
  {
    key: 'payment_gateway',
    name: 'Payment Gateway',
    category: 'Finance',
    implemented: false,
    detail: 'No gateway client exists. Storefront wallet top-up is recorded on trust with no payment capture.',
  },
  { key: 'google_maps', name: 'Google Maps', category: 'Logistics', implemented: false, detail: 'GPS coordinates are captured and stored for attendance and visits, but no Maps API is called — no geocoding, distance matrix or route optimisation.' },
  { key: 'google_business', name: 'Google Business Profile', category: 'Lead Sources', implemented: false, detail: 'No API client. Leads from this source can only be entered manually.' },
  { key: 'meta_leads', name: 'Facebook / Instagram Leads', category: 'Lead Sources', implemented: false, detail: 'Customer type enum accepts facebook and instagram, so the source can be recorded, but there is no webhook or API ingestion.' },
  { key: 'google_ads', name: 'Google Ads Leads', category: 'Lead Sources', implemented: false, detail: 'google_ads is an accepted customer type for manual entry only. No lead-form ingestion exists.' },
  { key: 'barcode_printer', name: 'Barcode Printers', category: 'Warehouse Hardware', implemented: false, detail: 'No label rendering or printer protocol code.' },
  { key: 'zebra_printer', name: 'Zebra Label Printer', category: 'Warehouse Hardware', implemented: false, detail: 'No ZPL generation exists.' },
  { key: 'barcode_scanner', name: 'Barcode Scanners', category: 'Warehouse Hardware', implemented: false, detail: 'Picking and dispatch permissions are labelled as barcode-verified, but verification is manual entry — there is no scan handling.' },
  { key: 'biometric', name: 'Biometric Attendance', category: 'HR Hardware', implemented: false, detail: 'Attendance accepts source "Biometric" and employees can be set to attendanceType "Biometric", but no device integration writes those rows.' },
  { key: 'einvoice', name: 'E-Invoice (IRP)', category: 'Statutory', implemented: false, detail: 'No IRN generation or IRP client. Invoices are produced locally only.' },
  { key: 'eway_bill', name: 'E-Way Bill', category: 'Statutory', implemented: false, detail: 'No e-way bill generation or API client.' },
  { key: 'logistics', name: 'Logistics Providers', category: 'Logistics', implemented: false, detail: 'Dispatch and delivery are tracked in-house. No third-party courier or transporter API.' },
  { key: 'cloud_storage', name: 'Cloud Storage', category: 'Infrastructure', implemented: false, detail: 'All uploads are written to local disk under uploads/ and private-uploads/. No S3 or equivalent client, so files are lost with the server volume.' },
  { key: 'push', name: 'Push Notifications (FCM)', category: 'Messaging', implemented: false, detail: 'Device tokens are collected but no Firebase Admin SDK or send call exists.' },
];

export async function integrationReadiness() {
  // Live evidence for Tally: if nothing has ever reached 'synced', the absence of
  // a sync pipeline is demonstrable rather than merely asserted.
  const [syncedOrders, dealersFlaggedForTally] = await Promise.all([
    SalesOrder.countDocuments({ tallySyncStatus: 'synced' }),
    Dealer.countDocuments({ tallySyncStatus: { $in: ['synced', 'tally_created'] } }),
  ]);

  const integrations = INTEGRATION_CATALOGUE.map((entry) => {
    const probe = entry.probe ? entry.probe() : null;
    let evidence = '';
    if (entry.key === 'tally') {
      evidence = `${syncedOrders} sales order(s) and ${dealersFlaggedForTally} dealer(s) have ever reached a synced state.`;
    } else if (probe?.note) {
      evidence = probe.note;
    }
    return {
      key: entry.key,
      name: entry.name,
      category: entry.category,
      status: entry.implemented ? (entry.partial ? 'partial' : 'available') : 'not_implemented',
      detail: entry.detail,
      evidence,
      envConfigured: probe ? probe.configured : null,
    };
  });

  const counts = integrations.reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});

  return {
    integrations,
    counts: {
      total: integrations.length,
      available: counts.available || 0,
      partial: counts.partial || 0,
      notImplemented: counts.not_implemented || 0,
    },
    summary: 'This is a readiness report, not a configuration screen. Credentials are not collected for integrations that have no client code, because storing keys that nothing reads would imply a working pipeline and create an unnecessary secret to protect.',
  };
}

const directorySize = (directory) => {
  try {
    if (!fs.existsSync(directory)) return { exists: false, files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files += 1;
      try { bytes += fs.statSync(`${directory}/${entry.name}`).size; } catch { /* ignore unreadable entries */ }
    }
    return { exists: true, files, bytes };
  } catch {
    return { exists: false, files: 0, bytes: 0, error: 'Directory could not be read.' };
  }
};

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/**
 * Runtime facts an owner or support engineer actually needs, and which are
 * otherwise only visible by reading server logs.
 */
export async function systemDiagnostics({ branchId }) {
  const connection = mongoose.connection;
  const now = new Date();
  const RECYCLE_RETENTION_DAYS = 30;
  // A record expires at deletedAt + 30 days, so "expiring within 7 days" means it
  // was deleted 23 or more days ago.
  const expiringCutoff = new Date(now.getTime() - (RECYCLE_RETENTION_DAYS - 7) * 86400000);

  let transactionsAvailable = null;
  let replicaSet = null;
  try {
    // Several employee lifecycle operations require transactions, which need a
    // replica set. Knowing this before an exit fails is worth the one command.
    const info = await connection.db.admin().command({ hello: 1 });
    replicaSet = info.setName || null;
    transactionsAvailable = Boolean(info.setName || info.msg === 'isdbgrid');
  } catch (error) {
    transactionsAvailable = null;
  }

  const [recycleTotal, recycleExpiringSoon, oldestRecycle, notificationsSkipped, dealerAppStats] = await Promise.all([
    RecycleBin.countDocuments({ branch: branchId }),
    // The bin has a 30-day TTL, after which Mongo hard-deletes the row and the
    // record is gone for good. Nothing currently warns anyone about that.
    RecycleBin.countDocuments({ branch: branchId, deletedAt: { $lte: expiringCutoff } }),
    RecycleBin.findOne({ branch: branchId }).sort({ deletedAt: 1 }).select('deletedAt recordTitle originalModel').lean(),
    Notification.countDocuments({ branch: branchId, 'channelAttempts.status': 'skipped' }),
    Dealer.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          appEnabled: { $sum: { $cond: ['$appAccess', 1, 0] } },
          pinSet: { $sum: { $cond: [{ $ifNull: ['$pinHash', false] }, 1, 0] } },
          everLoggedIn: { $sum: { $cond: [{ $ifNull: ['$appLastLoginAt', false] }, 1, 0] } },
        },
      },
    ]),
  ]);

  return {
    runtime: {
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      serverTime: now,
      timezoneOffsetMinutes: -now.getTimezoneOffset(),
    },
    database: {
      state: MONGO_STATES[connection.readyState] || 'unknown',
      name: connection.name || '',
      host: connection.host || '',
      replicaSet,
      transactionsAvailable,
      transactionsNote: transactionsAvailable === false
        ? 'This deployment is not a replica set, so employee lifecycle changes that require transactions will fail with a 503 rather than saving partially.'
        : transactionsAvailable === null
          ? 'Replica-set status could not be read; the account may lack permission to run the hello command.'
          : 'Transactions are supported, so employee lifecycle changes are atomic.',
    },
    storage: {
      note: 'Uploads are stored on the server disk. There is no cloud-storage client, so these files are only as durable as the server volume.',
      hrDocuments: directorySize(hrGeneratedDocumentDirectory),
      candidateResumes: directorySize(candidateResumeDirectory),
    },
    backup: {
      // Stated plainly rather than offered as a feature. A backup button that
      // produced something non-restorable would be worse than none at all.
      applicationLevelBackup: false,
      note: 'This application has no backup or restore feature. Database backups are the responsibility of the database deployment (for MongoDB Atlas, continuous cloud backup is configured in the Atlas console). The Recycle Bin is not a backup: it holds individual deleted records for 30 days only.',
      recycleBin: {
        retentionDays: RECYCLE_RETENTION_DAYS,
        totalRecords: recycleTotal,
        expiringWithin7Days: recycleExpiringSoon,
        oldestRecord: oldestRecycle
          ? { deletedAt: oldestRecycle.deletedAt, title: oldestRecycle.recordTitle, model: oldestRecycle.originalModel }
          : null,
      },
    },
    notifications: {
      skippedDeliveries: notificationsSkipped,
      ...channelCapabilities(),
    },
    dealerApp: dealerAppStats[0]
      ? {
        totalDealers: dealerAppStats[0].total,
        appEnabled: dealerAppStats[0].appEnabled,
        pinSet: dealerAppStats[0].pinSet,
        everLoggedIn: dealerAppStats[0].everLoggedIn,
      }
      : { totalDealers: 0, appEnabled: 0, pinSet: 0, everLoggedIn: 0 },
  };
}
