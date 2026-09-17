/**
 * Customer login OTP store.
 *
 * In development (or when CUSTOMER_OTP_FIXED is set) a fixed OTP is accepted so
 * the storefront login flow can be demoed without an SMS provider. In
 * production, set CUSTOMER_OTP_FIXED='' and wire `sendOtp` to a real SMS gateway.
 *
 * Storage is in-memory (Map). Fine for a single instance; swap for Redis if the
 * backend is horizontally scaled.
 */
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const store = new Map(); // phone -> { otp, expiresAt, attempts }

const fixedOtp = () => {
  // Defaults to '1234' unless explicitly overridden. Set to '' to force random.
  const value = process.env.CUSTOMER_OTP_FIXED;
  return value === undefined ? '1234' : value;
};

const randomOtp = () => String(Math.floor(1000 + Math.random() * 9000));

export const normalizePhone = (phone) => String(phone || '').replace(/[^\d]/g, '').slice(-10);

export const isValidPhone = (phone) => /^\d{10}$/.test(normalizePhone(phone));

export async function issueOtp(phone) {
  const key = normalizePhone(phone);
  const otp = fixedOtp() || randomOtp();
  store.set(key, { otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  // TODO: integrate real SMS provider here in production.
  // await sendSms(key, `Your BDM Tiles login OTP is ${otp}`);

  // Only expose the OTP in the response when a fixed/dev OTP is configured.
  return { devOtp: fixedOtp() ? otp : undefined };
}

export function verifyOtp(phone, otp) {
  const key = normalizePhone(phone);
  const record = store.get(key);
  if (!record) return { ok: false, reason: 'Please request an OTP first.' };
  if (Date.now() > record.expiresAt) {
    store.delete(key);
    return { ok: false, reason: 'OTP expired. Please request a new one.' };
  }
  record.attempts += 1;
  if (record.attempts > 5) {
    store.delete(key);
    return { ok: false, reason: 'Too many attempts. Please request a new OTP.' };
  }
  if (String(otp).trim() !== record.otp) return { ok: false, reason: 'Incorrect OTP.' };
  store.delete(key);
  return { ok: true };
}
