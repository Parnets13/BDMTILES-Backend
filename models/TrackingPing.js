import mongoose from 'mongoose';

/**
 * One field-tracking record: either a position fix, or a status change.
 *
 * There is no separate "live position" collection. The live view reads the newest
 * row per executive, which keeps a single write path — the alternative is two
 * collections that can disagree about where someone is, and they will.
 *
 * `lat`/`lng` are optional because not every row is a fix. `gps_off` and `offline`
 * are recorded deliberately and carry no coordinates; that is exactly the information
 * an admin needs when a dot stops moving.
 */
const trackingPingSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    executive: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    executiveName: { type: String, trim: true, default: '' },

    at: { type: Date, default: Date.now },
    // Business-time day key ('YYYY-MM-DD'). Stored rather than derived so a trail
    // query is a straight index hit instead of a range scan per request.
    day: { type: String, required: true },

    // active    — checked in, fix is current
    // gps_off   — checked in, but the device has location switched off
    // offline   — checked out, or the app has stopped reporting
    status: { type: String, enum: ['active', 'gps_off', 'offline'], default: 'active' },

    lat: Number,
    lng: Number,
    accuracy: Number,
    speed: Number,
    // Reverse-geocoded when a provider is configured; blank otherwise. An address is
    // a nicety on top of a coordinate, never a substitute for one.
    address: { type: String, trim: true, default: '' },

    // Reported by the device. Evidence that a fix came from a mock provider, never
    // proof of intent — the UI must not present it as an accusation.
    mocked: { type: Boolean, default: false },
    battery: Number,
    charging: Boolean,

    // duty  — between check-in and check-out
    // visit — currently checked in at a dealer
    context: { type: String, enum: ['duty', 'visit'], default: 'duty' },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },

    // Set on write so MongoDB's TTL monitor can prune without a cron job.
    expiresAt: Date,
  },
  { timestamps: true },
);

trackingPingSchema.index({ executive: 1, at: -1 });
trackingPingSchema.index({ branch: 1, day: 1, at: -1 });
// The live view wants the newest row per executive across a whole branch.
trackingPingSchema.index({ branch: 1, at: -1 });
trackingPingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('TrackingPing', trackingPingSchema);
