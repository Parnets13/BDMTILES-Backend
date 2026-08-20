import RecycleBin from '../models/RecycleBin.js';

/**
 * Generate a unique code that doesn't conflict with existing records OR recycle bin entries.
 * 
 * @param {Model} Model - Mongoose model
 * @param {string} field - The unique code field name (e.g. 'productCode', 'orderNumber')
 * @param {string} prefix - Code prefix (e.g. 'BDM', 'SO-', 'QT-', 'INV-')
 * @param {number} padLength - Zero-padding length (default 5)
 * @returns {string} Unique code
 */
export async function generateUniqueCode(Model, field, prefix, padLength = 5) {
  const modelName = Model.modelName;
  let codeNum = await Model.countDocuments() + 1;
  let code = `${prefix}${String(codeNum).padStart(padLength, '0')}`;

  // Check both collection and recycle bin
  for (let attempt = 0; attempt < 100; attempt++) {
    const existsInCollection = await Model.findOne({ [field]: code }).lean();
    const existsInBin = await RecycleBin.findOne({ [`data.${field}`]: code, originalModel: modelName }).lean();
    
    if (!existsInCollection && !existsInBin) return code;
    
    codeNum++;
    code = `${prefix}${String(codeNum).padStart(padLength, '0')}`;
  }

  // Fallback: timestamp-based
  return `${prefix}${Date.now().toString(36).toUpperCase()}`;
}

export default generateUniqueCode;
