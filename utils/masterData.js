import mongoose from 'mongoose';

export const pick = (source, fields) => Object.fromEntries(
  fields.filter((field) => Object.prototype.hasOwnProperty.call(source || {}, field))
    .map((field) => [field, source[field]])
);

export const httpError = (status, message, code) => {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
};

export const assertObjectId = (value, label = 'ID') => {
  if (!mongoose.isValidObjectId(value)) throw httpError(422, `${label} is invalid.`);
  return value;
};

export const assertActiveReference = async (
  Model,
  value,
  label,
  { optional = true, statusField = 'status', activeValue = 'active', select = '_id status' } = {}
) => {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw httpError(422, `${label} is required.`);
  }
  assertObjectId(value, label);
  const record = await Model.findById(value).select(select).lean();
  if (!record) throw httpError(422, `${label} does not exist.`);
  if (statusField && record[statusField] !== activeValue) {
    throw httpError(422, `${label} must be active.`);
  }
  return record;
};

export const routeError = (res, error, fallback = 'Request failed.') => {
  if (error?.code === 11000) {
    return res.status(409).json({ success: false, message: 'A record with the same unique value already exists.' });
  }
  if (error?.name === 'ValidationError') {
    const details = Object.values(error.errors || {}).map((item) => item.message);
    return res.status(422).json({ success: false, message: details.join(' ') || error.message });
  }
  if (error?.name === 'CastError') {
    return res.status(422).json({ success: false, message: `${error.path || 'Value'} is invalid.` });
  }
  return res.status(error?.status || 500).json({ success: false, message: error?.message || fallback });
};

export const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const normalizedCode = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');
