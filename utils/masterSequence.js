import MasterSequence from '../models/MasterSequence.js';
import RecycleBin from '../models/RecycleBin.js';

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const numericSuffix = (value, prefix) => {
  const match = String(value || '').match(new RegExp(`^${escapeRegex(prefix)}(\\d+)$`));
  return match ? Number.parseInt(match[1], 10) : 0;
};

const findInitialValue = async (Model, field, prefix, filter, recycleFilter) => {
  const pattern = new RegExp(`^${escapeRegex(prefix)}\\d+$`);
  const [liveRows, recycledRows] = await Promise.all([
    Model.find({ ...filter, [field]: pattern }).select(field).lean(),
    RecycleBin.find({
      originalModel: Model.modelName,
      [`data.${field}`]: pattern,
      ...recycleFilter,
    }).select(`data.${field}`).lean(),
  ]);
  return Math.max(
    0,
    ...liveRows.map((row) => numericSuffix(row[field], prefix)),
    ...recycledRows.map((row) => numericSuffix(row.data?.[field], prefix))
  );
};

const ensureSequence = async (key, initialValue) => {
  try {
    await MasterSequence.updateOne(
      { key },
      { $setOnInsert: { key, value: initialValue } },
      { upsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
};

export async function generateMasterCode({
  Model,
  field,
  prefix,
  padLength = 5,
  scopeKey = 'global',
  filter = {},
  recycleFilter = {},
}) {
  const key = `${Model.modelName}:${field}:${scopeKey}`;
  let sequence = await MasterSequence.findOne({ key }).select('value').lean();
  if (!sequence) {
    const initialValue = await findInitialValue(Model, field, prefix, filter, recycleFilter);
    await ensureSequence(key, initialValue);
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const counter = await MasterSequence.findOneAndUpdate(
      { key },
      { $inc: { value: 1 } },
      { new: true }
    ).lean();
    const code = `${prefix}${String(counter.value).padStart(padLength, '0')}`;
    const [live, recycled] = await Promise.all([
      Model.exists({ ...filter, [field]: code }),
      RecycleBin.exists({ originalModel: Model.modelName, [`data.${field}`]: code, ...recycleFilter }),
    ]);
    if (!live && !recycled) return code;
  }

  throw new Error(`Unable to allocate a unique ${Model.modelName} code.`);
}

export default generateMasterCode;
