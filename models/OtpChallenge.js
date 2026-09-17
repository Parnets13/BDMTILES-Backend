import mongoose from 'mongoose';

// A short-lived phone login challenge for the Sales Executive app. The code is
// never stored in plaintext; only its salted hash is persisted. Documents expire
// automatically via a TTL index so stale challenges cannot be replayed.
const otpChallengeSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, trim: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    codeHash: { type: String, required: true },
    purpose: { type: String, enum: ['se_login', 'dealer_login'], default: 'se_login' },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 5, min: 1 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    ip: { type: String, default: '', maxlength: 100 },
    userAgent: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true }
);

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpChallengeSchema.index({ phone: 1, consumedAt: 1, createdAt: -1 });

export default mongoose.model('OtpChallenge', otpChallengeSchema);
