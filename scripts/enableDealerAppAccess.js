import 'dotenv/config';
import mongoose from 'mongoose';
import Dealer, { normalizeDealerMobile } from '../models/Dealer.js';

// Usage:
//   node --use-system-ca scripts/enableDealerAppAccess.js            → list dealers + app status
//   node --use-system-ca scripts/enableDealerAppAccess.js --all      → enable app access for every active dealer
//   node --use-system-ca scripts/enableDealerAppAccess.js <mobile>   → enable app access for one dealer by mobile
const arg = process.argv[2];

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}`);

  // Re-sync every dealer's login key from its CURRENT mobile. Web edits via
  // findByIdAndUpdate bypass the pre-save hook, so a changed number can leave a
  // stale mobileNormalized behind. We clear all keys first, then reassign from
  // the live mobile, so a corrected number takes effect and true duplicates surface.
  await Dealer.updateMany({}, { $set: { mobileNormalized: '' } });
  const all = await Dealer.find({}).select('mobile businessName').sort({ createdAt: 1 });
  const seen = new Map();
  const conflicts = [];
  let backfilled = 0;
  for (const d of all) {
    const normalized = normalizeDealerMobile(d.mobile);
    if (!normalized) continue;
    if (seen.has(normalized)) {
      conflicts.push(`${d.businessName} (mobile ${d.mobile}) — same as ${seen.get(normalized)}`);
      continue;
    }
    seen.set(normalized, d.businessName);
    d.mobileNormalized = normalized;
    await d.save({ validateBeforeSave: false });
    backfilled += 1;
  }
  console.log(`Re-synced mobileNormalized for ${backfilled} dealer(s).`);
  if (conflicts.length) {
    console.log(`\n⚠️  ${conflicts.length} dealer(s) still share a mobile and cannot log in until given a unique number:`);
    conflicts.forEach((c) => console.log(`   - ${c}`));
  }

  if (arg === '--all') {
    const res = await Dealer.updateMany({ status: 'active' }, { $set: { appAccess: true } });
    console.log(`Enabled app access for ${res.modifiedCount} active dealer(s).`);
  } else if (arg && arg !== '--list') {
    const normalized = normalizeDealerMobile(arg);
    const res = await Dealer.updateOne({ mobileNormalized: normalized }, { $set: { appAccess: true } });
    console.log(res.matchedCount ? `Enabled app access for mobile ${normalized}.` : `No dealer found for mobile ${normalized}.`);
  }

  const dealers = await Dealer.find({}).select('businessName mobile mobileNormalized appAccess status').sort({ businessName: 1 }).lean();
  console.log(`\nDealers (${dealers.length}):`);
  for (const d of dealers) {
    console.log(`  ${d.appAccess ? '[APP ON ]' : '[app off]'} ${d.businessName} | mobile=${d.mobile} | login=${d.mobileNormalized || '(none)'} | status=${d.status}`);
  }
  await mongoose.disconnect();
}

run().catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; });
