/**
 * Product import from Excel / CSV / PDF, in two steps:
 *
 *   1. parseImportFile()  file  -> rows[] keyed by canonical field names. Nothing is saved.
 *                          The browser shows these rows in an editable preview.
 *   2. importProductRows() rows[] (as edited by the user) -> products. This is the
 *                          authoritative validation; the browser's checks are only a convenience.
 *
 * Any new input format only has to produce the same rows[] shape.
 */
import fs from 'fs';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Brand from '../models/Brand.js';
import Category from '../models/Category.js';
import RecycleBin from '../models/RecycleBin.js';
import { normalizeProductUomConfig } from './stockUomService.js';
import { normalizeAndValidateAttributes } from './attributeService.js';
import { pdfToRows } from './productPdfParser.js';

export const MAX_IMPORT_ROWS = 5000;
const INSERT_BATCH_SIZE = 100;

// ── Canonical fields ──────────────────────────────────────────────────────────
// key: what the preview edits and the save endpoint receives.
// type: how the save step coerces and validates the value.
export const IMPORT_FIELDS = [
  { key: 'name', label: 'Product Name', type: 'text', required: true },
  { key: 'code', label: 'Product Code', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'subcategory', label: 'Subcategory', type: 'text' },
  { key: 'brand', label: 'Brand', type: 'text' },
  { key: 'size', label: 'Size', type: 'text' },
  { key: 'thickness', label: 'Thickness', type: 'text' },
  { key: 'surface', label: 'Surface', type: 'text' },
  { key: 'finish', label: 'Finish', type: 'text' },
  { key: 'application', label: 'Application', type: 'text' },
  { key: 'tile_type', label: 'Tile Type', type: 'text' },
  { key: 'colour', label: 'Colour', type: 'text' },
  { key: 'design', label: 'Design', type: 'text' },
  { key: 'collection', label: 'Collection', type: 'text' },
  { key: 'unit', label: 'Unit', type: 'text' },
  { key: 'pcs_per_box', label: 'Pcs / Box', type: 'number' },
  { key: 'sqft_per_box', label: 'Sqft / Box', type: 'number' },
  { key: 'weight_per_box', label: 'Weight / Box', type: 'number' },
  { key: 'purchase_rate', label: 'Purchase Rate', type: 'number' },
  { key: 'dealer_rate', label: 'Dealer Rate (DP)', type: 'number' },
  { key: 'retail_rate', label: 'Retail Rate', type: 'number' },
  { key: 'mrp', label: 'MRP', type: 'number' },
  { key: 'gst', label: 'GST %', type: 'number' },
  { key: 'hsn_code', label: 'HSN Code', type: 'text' },
  { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'min_stock_level', label: 'Min Stock', type: 'number' },
  { key: 'reorder_level', label: 'Reorder Level', type: 'number' },
  { key: 'status', label: 'Status', type: 'text' },
];
const FIELD_KEYS = new Set(IMPORT_FIELDS.map((f) => f.key));

// ── Header aliases ────────────────────────────────────────────────────────────
// Headers are normalised (lowercase, every non-alphanumeric removed) BEFORE lookup, so
// "Product Name", "PRODUCT_NAME" and "product-name" all hit `productname`.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
const ALIASES = {
  name: ['productname', 'itemname', 'name', 'item', 'product', 'particulars', 'articlename', 'vcname', 'modelname', 'designname'],
  code: ['bdmcode', 'productcode', 'code', 'itemcode', 'sku', 'articlecode'],
  category: ['category', 'productcategory', 'itemgroup', 'group'],
  subcategory: ['subcategory', 'subgroup'],
  brand: ['brand', 'productbrand', 'company', 'make'],
  size: ['size', 'tilesize', 'dimension', 'dimensions'],
  thickness: ['thickness'],
  surface: ['surface'],
  finish: ['finish'],
  application: ['uses', 'use', 'application', 'applicationarea', 'usage'],
  tile_type: ['tiletype', 'type', 'material'],
  colour: ['colour', 'color'],
  design: ['design'],
  collection: ['collection', 'series'],
  unit: ['unit', 'uom'],
  pcs_per_box: ['pkg', 'pcsperbox', 'pcsbox', 'piecesperbox', 'pcs', 'packing'],
  sqft_per_box: ['coverage', 'sqftperbox', 'sqftbox'],
  weight_per_box: ['weightperbox', 'weight'],
  purchase_rate: ['purchaserate', 'purchaseprice', 'cost', 'landingcost'],
  dealer_rate: ['dpbox', 'dp', 'dealerrate', 'dealerprice'],
  retail_rate: ['retailrate', 'retailprice', 'sellingprice', 'rate', 'price'],
  mrp: ['mrpbox', 'mrp'],
  gst: ['gst', 'gst%', 'gstpercent', 'gstrate', 'tax'],
  hsn_code: ['hsn', 'hsncode', 'hsnsac'],
  barcode: ['barcode', 'ean'],
  description: ['description', 'remarks', 'remark'],
  min_stock_level: ['minstocklevel', 'minstock', 'stockalert'],
  reorder_level: ['reorderlevel', 'reorder'],
  status: ['status'],
};
// Known columns deliberately ignored: per-sqft prices are derived, location/godown are rack data.
const IGNORED = new Set(['location', 'godown', 'dpsqft', 'mrpsqft', 'srno', 'sno', 'slno']);
const HEADER_LOOKUP = new Map();
for (const [key, list] of Object.entries(ALIASES)) for (const a of list) if (!HEADER_LOOKUP.has(a)) HEADER_LOOKUP.set(a, key);

export const headerToFieldKey = (header) => {
  const h = norm(header);
  if (!h || IGNORED.has(h)) return '';
  return HEADER_LOOKUP.get(h) || '';
};

// ── Cell / value helpers ──────────────────────────────────────────────────────
// ExcelJS returns objects for formula, rich-text and hyperlink cells; String() on them
// gives "[object Object]", so unwrap them first.
const cellToString = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellToString(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('').trim();
    if (v.text !== undefined) return cellToString(v.text);
    if (v.error) return '';
    return '';
  }
  return String(v).trim();
};

const firstInt = (v) => String(v ?? '').match(/\d+/)?.[0] ?? '';
// "600x1200x9MM" -> "600x1200" (third part is a thickness), "1200 X 1800" -> "1200x1800",
// "2X4" (feet, trade shorthand) -> "600x1200", "510 X 360 X 815 MM" (a 3-D item) kept whole.
const cleanSize = (v) => {
  const raw = String(v ?? '').trim();
  const parts = raw.toLowerCase().replace(/\s+/g, '').replace(/mm$|mm(?=x)/g, '').split(/[x*×]/).filter(Boolean);
  if (parts.length < 2 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return raw;
  const n = parts.map(Number);
  if (n.length === 2 && n.every((x) => Number.isInteger(x) && x >= 1 && x <= 8)) return n.map((x) => x * 300).join('x');
  if (n.length >= 3 && n[2] > 30) return parts.slice(0, 3).join('x');
  return parts.slice(0, 2).join('x');
};

// ── File -> matrix ────────────────────────────────────────────────────────────
// Each entry keeps its real sheet row number so error messages point at the right line
// even when blank rows were skipped.
const readXlsx = async (filePath) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no worksheets.');
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellToString(row.getCell(c).value));
    out.push({ rowNumber, cells });
  });
  return out;
};

const readCsv = async (filePath) => {
  let text = await fs.promises.readFile(filePath, 'utf-8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.find((l) => l.trim()) || '';
  const counts = { '\t': (first.match(/\t/g) || []).length, ';': (first.match(/;/g) || []).length, ',': (first.match(/,/g) || []).length };
  const SEP = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const parseLine = (line) => {
    const fields = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === SEP) { fields.push(cur.trim()); cur = ''; } else cur += ch;
    }
    fields.push(cur.trim());
    return fields;
  };
  return lines.map((l, i) => ({ rowNumber: i + 1, cells: parseLine(l) })).filter((r) => r.cells.some(Boolean));
};

const PDF_LAYOUT_LABEL = { table: 'a price table', cards: 'one product card per item', catalogue: 'a catalogue with Cat. No. codes' };

// PDFs have no sheet rows, so "_row" is the product's position in the PDF (1 = first product).
const readPdf = async (filePath) => {
  const { rows, layout } = await pdfToRows(filePath, { headerToFieldKey });
  const matrix = rows.map((cells, i) => ({ rowNumber: i, cells }));
  matrix.layout = layout;
  return matrix;
};

/**
 * Parses an uploaded import file. Returns
 *   { rows: [{ _row, name, code, ... }], matchedFields: [...], ignoredHeaders: [...], warning }
 */
export async function parseImportFile(filePath, ext) {
  let matrix;
  try {
    if (ext === '.xlsx') matrix = await readXlsx(filePath);
    else if (ext === '.csv') matrix = await readCsv(filePath);
    else if (ext === '.pdf') matrix = await readPdf(filePath);
    else throw Object.assign(new Error(`Unsupported file type "${ext}".`), { status: 400 });
  } catch (e) {
    throw Object.assign(new Error(e.status ? e.message : `Could not read the file: ${e.message}`), { status: 400 });
  }
  if (!matrix.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });

  // Header = first row (within the first 20) that maps a product-name column plus at least
  // one other known column. Tolerates a title or logo row above the real header.
  let headerAt = -1;
  let colKeys = [];
  for (let i = 0; i < Math.min(matrix.length, 20); i++) {
    const keys = matrix[i].cells.map(headerToFieldKey);
    if (keys.includes('name') && keys.filter(Boolean).length >= 2) { headerAt = i; colKeys = keys; break; }
  }
  if (headerAt < 0) {
    throw Object.assign(new Error('Could not find the header row. The sheet needs a "Product Name" (or "Item Name") column next to other columns such as Code, Size, Brand or MRP.'), { status: 400 });
  }

  // If a header appears twice (e.g. two "Description" columns), keep the first.
  const seen = new Set();
  colKeys = colKeys.map((k) => { if (!k || seen.has(k)) return ''; seen.add(k); return k; });
  const headerCells = matrix[headerAt].cells;
  const ignoredHeaders = headerCells.filter((h, i) => String(h).trim() && !colKeys[i]).map((h) => String(h).trim());

  const rows = [];
  for (const { rowNumber, cells } of matrix.slice(headerAt + 1)) {
    if (!cells.some((c) => String(c).trim())) continue;
    // Repeated header on the next page of a PDF / printed sheet.
    if (cells.map(headerToFieldKey).filter(Boolean).length >= 3 && cells.map(headerToFieldKey).includes('name')) continue;
    const row = { _row: rowNumber };
    colKeys.forEach((key, i) => { if (key) row[key] = String(cells[i] ?? '').trim(); });
    if (row.pcs_per_box !== undefined) row.pcs_per_box = firstInt(row.pcs_per_box);
    if (row.size) row.size = cleanSize(row.size);
    // "FULLBODY-PUNCH" -> finish "PUNCH" when the sheet has Surface but no Finish column.
    if (row.surface && !row.finish) row.finish = row.surface.includes('-') ? row.surface.split('-').slice(1).join('-').trim() : row.surface;
    rows.push(row);
  }
  if (!rows.length) throw Object.assign(new Error('No data rows found below the header.'), { status: 400 });
  if (rows.length > MAX_IMPORT_ROWS) {
    throw Object.assign(new Error(`The file has ${rows.length} rows. Import at most ${MAX_IMPORT_ROWS} at a time.`), { status: 400 });
  }

  const matchedFields = [...new Set(colKeys.filter(Boolean))];
  if (matchedFields.includes('surface') && !matchedFields.includes('finish')) matchedFields.push('finish');
  const warning = ext === '.pdf'
    ? `Read as ${PDF_LAYOUT_LABEL[matrix.layout] || 'a PDF'}. PDFs carry no columns, so check names, sizes and prices in the preview before saving. Brand is not in most supplier PDFs: add the Brand column and fill it if needed.`
    : '';
  return { rows, matchedFields, ignoredHeaders, warning };
}

// ── Save ──────────────────────────────────────────────────────────────────────
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const nextCodeFactory = async () => {
  // Codes in live products AND the recycle bin, so a restored product can never collide.
  const [live, binned] = await Promise.all([
    Product.distinct('productCode'),
    RecycleBin.distinct('data.productCode', { originalModel: 'Product' }),
  ]);
  const used = new Set([...live, ...binned].filter(Boolean).map((c) => String(c).trim().toUpperCase()));
  let n = (await Product.countDocuments()) + 1;
  const next = () => {
    let code;
    do { code = `BDM${String(n++).padStart(6, '0')}`; } while (used.has(code));
    used.add(code);
    return code;
  };
  return { used, next };
};

/**
 * rows: [{ _row, name, code, ... }] as edited in the preview.
 * options: { userId, defaultCategory (ObjectId string), createBrands (bool) }
 * Returns { total, imported, errors: [{ row, field, message }], importedItems }.
 * Rows are independent: one bad row never blocks the rest (no transaction, by design).
 */
export async function importProductRows(rows, { userId, defaultCategory, createBrands = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('No rows to import.'), { status: 400 });
  if (rows.length > MAX_IMPORT_ROWS) throw Object.assign(new Error(`Import at most ${MAX_IMPORT_ROWS} rows at a time.`), { status: 400 });

  const errors = [];
  const importedItems = [];
  // ref is an opaque client key echoed back so the preview can tell which rows saved.
  let currentRef;
  const pushError = (row, field, message) => errors.push({ row, field, message, ref: currentRef });

  const allCategories = await Category.find({}).select('_id name level status').lean();
  const categoriesByName = new Map();
  for (const c of allCategories) {
    const k = c.name.trim().toLowerCase();
    if (!categoriesByName.has(k)) categoriesByName.set(k, []);
    categoriesByName.get(k).push(c);
  }
  const fallbackCategory = defaultCategory && mongoose.isValidObjectId(defaultCategory)
    ? allCategories.find((c) => String(c._id) === String(defaultCategory))
    : null;
  if (defaultCategory && !fallbackCategory) throw Object.assign(new Error('The selected category no longer exists.'), { status: 400 });

  const brandCache = new Map((await Brand.find({}).select('_id name').lean()).map((b) => [b.name.trim().toLowerCase(), b._id]));
  const { used: usedCodes, next: nextCode } = await nextCodeFactory();
  const attributeCache = new Map();
  const pending = []; // validated rows waiting for the batched insert

  const resolveCategory = (name, field, rowNo) => {
    const list = categoriesByName.get(name.toLowerCase()) || [];
    if (!list.length) { pushError(rowNo, field, `${field === 'category' ? 'Category' : 'Subcategory'} "${name}" not found. Create it in Category Setup first, or clear the cell to use the selected default.`); return null; }
    if (list.length > 1) { pushError(rowNo, field, `"${name}" matches ${list.length} categories in different departments. Clear the cell and pick the category in the default selector.`); return null; }
    return list[0]._id;
  };

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const rowNo = Number(raw._row) || i + 2;
    currentRef = typeof raw._ref === 'string' ? raw._ref.slice(0, 40) : undefined;

    // 1. Keep only known keys, trimmed strings.
    const r = {};
    for (const [k, v] of Object.entries(raw)) if (FIELD_KEYS.has(k)) r[k] = v == null ? '' : String(v).trim();

    // 2. Name.
    if (!r.name) { pushError(rowNo, 'name', 'Product name is required.'); continue; }

    // 3. Numbers: strict. Text in a number column is reported, not silently zeroed.
    const nums = {};
    let numberError = false;
    for (const f of IMPORT_FIELDS) {
      if (f.type !== 'number' || !r[f.key]) continue;
      const n = Number(String(r[f.key]).replace(/,/g, ''));
      if (!Number.isFinite(n) || n < 0) { pushError(rowNo, f.key, `${f.label} "${r[f.key]}" is not a valid non-negative number.`); numberError = true; break; }
      nums[f.key] = n;
    }
    if (numberError) continue;
    if (nums.gst !== undefined && nums.gst > 28) { pushError(rowNo, 'gst', `GST ${nums.gst}% is above 28%.`); continue; }

    // 4. Status.
    const status = (r.status || 'active').toLowerCase();
    if (!['active', 'inactive', 'draft'].includes(status)) { pushError(rowNo, 'status', `Status "${r.status}" must be active, inactive or draft.`); continue; }

    // 5. Category (required): the row's own value, otherwise the selected default.
    let categoryId = null;
    if (r.category) categoryId = resolveCategory(r.category, 'category', rowNo);
    else if (fallbackCategory) categoryId = fallbackCategory._id;
    else { pushError(rowNo, 'category', 'Category is required. Fill the Category cell or select a default category.'); continue; }
    if (!categoryId) continue;

    let subcategoryId;
    if (r.subcategory) { subcategoryId = resolveCategory(r.subcategory, 'subcategory', rowNo); if (!subcategoryId) continue; }

    // 6. Code: given codes must be unique across the DB, the recycle bin and earlier rows.
    let productCode = r.code;
    if (productCode) {
      if (usedCodes.has(productCode.toUpperCase())) { pushError(rowNo, 'code', `Product code "${productCode}" already exists (in products, the recycle bin, or an earlier row).`); continue; }
      usedCodes.add(productCode.toUpperCase());
    } else {
      productCode = nextCode();
    }

    // 7. Brand: find or (optionally) create, cached per upload. Brands are a flat list, so
    //    creating one from text cannot disturb the category tree.
    let brandId;
    if (r.brand) {
      const key = r.brand.toLowerCase();
      brandId = brandCache.get(key);
      if (!brandId) {
        const existing = await Brand.findOne({ name: new RegExp(`^${escapeRegex(r.brand)}$`, 'i') }).select('_id').lean();
        if (existing) brandId = existing._id;
        else if (createBrands) brandId = (await Brand.create({ name: r.brand, createdBy: userId }))._id;
        else { pushError(rowNo, 'brand', `Brand "${r.brand}" not found.`); continue; }
        brandCache.set(key, brandId);
      }
    }

    const productData = {
      itemName: r.name,
      productCode,
      category: categoryId,
      subcategory: subcategoryId,
      brand: brandId,
      tileSize: r.size || '',
      thickness: r.thickness || '',
      surface: r.surface || '',
      finish: r.finish || '',
      applicationArea: r.application || '',
      tileType: r.tile_type || '',
      colour: r.colour || '',
      design: r.design || '',
      collection: r.collection || '',
      unit: r.unit || 'Box',
      piecesPerBox: nums.pcs_per_box ?? 0,
      sqftPerBox: nums.sqft_per_box ?? 0,
      weightPerBox: nums.weight_per_box ?? 0,
      purchaseRate: nums.purchase_rate ?? 0,
      dealerRate: nums.dealer_rate ?? 0,
      retailRate: nums.retail_rate ?? 0,
      mrp: nums.mrp ?? 0,
      gst: nums.gst ?? 18,
      hsnCode: r.hsn_code || '',
      barcode: r.barcode || undefined,
      description: r.description || '',
      minStockLevel: nums.min_stock_level ?? 0,
      reorderLevel: nums.reorder_level ?? 0,
      status,
      createdBy: userId,
    };
    Object.assign(productData, normalizeProductUomConfig(productData, productData.unit));
    // Imports never carry attribute values, so the result depends only on the category.
    // Cached per category: it walks the category tree, which is costly to repeat per row.
    const catKey = String(productData.category);
    if (!attributeCache.has(catKey)) {
      let attrs;
      try { ({ attributes: attrs } = await normalizeAndValidateAttributes(productData.category, {}, { partial: true })); } catch { attrs = undefined; }
      attributeCache.set(catKey, attrs);
    }
    const cachedAttrs = attributeCache.get(catKey);
    if (cachedAttrs !== undefined) productData.attributes = cachedAttrs instanceof Map ? new Map(cachedAttrs) : { ...cachedAttrs };

    // insertMany skips the pre('save') hook, so set what it would have derived.
    productData.maxPurchaseRate = 0;

    // Schema validation per row now, so a bad row is reported against its own line.
    const doc = new Product(productData);
    const invalid = doc.validateSync();
    if (invalid) { pushError(rowNo, 'product', `Failed to save: ${invalid.message}`); continue; }
    pending.push({ doc, rowNo, ref: currentRef, productCode });
  }

  // Insert in batches: one round trip per batch instead of one per row.
  const recordInserted = (p) => importedItems.push({ row: p.rowNo, ref: p.ref, _id: p.doc._id, productCode: p.doc.productCode, itemName: p.doc.itemName });
  const recordFailed = (p, err) => {
    currentRef = p.ref;
    if (err?.code === 11000) pushError(p.rowNo, 'code', `Product code "${p.productCode}" already exists (database constraint).`);
    else pushError(p.rowNo, 'product', `Failed to save: ${err?.message || 'unknown error'}`);
  };
  for (let i = 0; i < pending.length; i += INSERT_BATCH_SIZE) {
    const batch = pending.slice(i, i + INSERT_BATCH_SIZE);
    try {
      await Product.insertMany(batch.map((p) => p.doc), { ordered: true });
      batch.forEach(recordInserted);
    } catch {
      // Something in the batch hit a DB constraint. ordered:true stops at the first failure,
      // so find which docs actually landed, then retry the rest one by one for exact reasons.
      const landed = new Set((await Product.find({ _id: { $in: batch.map((p) => p.doc._id) } }).select('_id').lean()).map((d) => String(d._id)));
      for (const p of batch) {
        if (landed.has(String(p.doc._id))) { recordInserted(p); continue; }
        try { await Product.create(p.doc.toObject()); recordInserted(p); } catch (err) { recordFailed(p, err); }
      }
    }
  }

  // Report rows in sheet order regardless of which phase found the problem.
  errors.sort((a, b) => a.row - b.row);
  importedItems.sort((a, b) => a.row - b.row);
  return { total: rows.length, imported: importedItems.length, errors, importedItems };
}
