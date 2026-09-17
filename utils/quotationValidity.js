const DAY_MS = 24 * 60 * 60 * 1000;

export function parseValidityDate(value, field = 'validUntil') {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${field} is invalid.`);
    error.status = 422;
    throw error;
  }
  // Calendar-date inputs mean valid through that entire UTC business date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) date.setUTCHours(23, 59, 59, 999);
  return date;
}

export function effectiveValidUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Legacy browser date inputs were stored at UTC midnight. Treat them as
  // inclusive calendar dates so they do not expire at the start of the day.
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0
      && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

export function quotationValidity(quotation, now = new Date()) {
  const expiresAt = effectiveValidUntil(quotation?.validUntil);
  const terminal = ['converted', 'cancelled'].includes(quotation?.status)
    || quotation?.conversionState === 'full';
  const isExpired = Boolean(expiresAt && expiresAt.getTime() < now.getTime() && !terminal);
  const expiresInDays = expiresAt
    ? Math.round((
      Date.UTC(expiresAt.getUTCFullYear(), expiresAt.getUTCMonth(), expiresAt.getUTCDate())
      - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ) / DAY_MS)
    : null;
  return {
    expiresAt,
    isExpired,
    expiresInDays,
    effectiveStatus: isExpired ? 'expired' : quotation?.status,
  };
}

export function withQuotationValidity(quotation, now = new Date()) {
  const source = quotation?.toObject ? quotation.toObject() : quotation;
  const validity = quotationValidity(source, now);
  return {
    ...source,
    validUntil: validity.expiresAt || source?.validUntil || null,
    isExpired: validity.isExpired,
    expiresInDays: validity.expiresInDays,
    effectiveStatus: validity.effectiveStatus,
  };
}
