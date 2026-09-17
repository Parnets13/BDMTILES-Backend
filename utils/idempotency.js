import { createHash } from 'crypto';

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
};

export const requestFingerprint = (payload) => createHash('sha256')
  .update(JSON.stringify(canonicalize(payload ?? {})))
  .digest('hex');

export const getIdempotencyContext = (req) => {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!key || key.length > 200) {
    const error = new Error('A valid Idempotency-Key header is required.');
    error.status = 422;
    throw error;
  }
  return {
    sourceKey: `${String(req.branchId)}:${String(req.user?._id || 'anonymous')}:${key}`,
    requestFingerprint: requestFingerprint(req.body),
  };
};

export const assertIdempotentReplay = (record, fingerprint) => {
  if (record?.requestFingerprint && record.requestFingerprint !== fingerprint) {
    const error = new Error('This Idempotency-Key was already used with a different request payload.');
    error.status = 409;
    throw error;
  }
  return record;
};
