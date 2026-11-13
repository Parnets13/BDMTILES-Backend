/**
 * PDF price list / catalogue -> product rows.
 *
 * Plain pdf-parse text glues neighbouring cells together ("SIZEFINISHBOX",
 * "510 X 360 X 815 MM22500"), so this reads text WITH positions from pdf.js and rebuilds
 * lines and cells from x/y coordinates. Three layout strategies run on the result and the
 * one that finds the most products wins:
 *
 *   table      header row + rows below, cells mapped to columns by x (e.g. VARSO MRP list).
 *              A line that only fills the name column is joined to the next row (wrapped names).
 *   cards      every product is a card: name, optional type, a small header (SIZE FINISH ...)
 *              and one value line under it (e.g. JK clearing stock).
 *   catalogue  a grid of cards keyed by "Cat. No. <code>" with a price below it
 *              (e.g. CERA). Name, size and finish are taken from the same column above.
 *
 * Output: string[][] where row 0 holds canonical field keys (name, code, size, mrp, ...).
 * Scanned PDFs (images only) have no text layer and are reported as such.
 */
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const TILE_TYPES = /\b(GVT|PGVT|VITRIFIED|CERAMIC|PORCELAIN|DOUBLE CHARGE|FULL ?BODY|SLAB|GRANITE|MARBLE|TILES?)\b/i;
const FINISH_WORDS = ['HIGH GLOSS', 'GLOSSY', 'GLOSS', 'MATT', 'MATTE', 'SATIN', 'RUSTIC', 'POLISHED', 'LAPATO', 'SUGAR', 'CARVING', 'ROCKER'];
const QTY_LINE = /^\d+\s*-?\s*(box|boxes|pcs|nos)\.?$/i;
const DIMS = /\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)?\s*(mm|cm|ft)?/i;
// One or more prices in a cell: "22500", "` 19,490", "₹ 1,680", "` 7,560 ` 9,450" (one per colour).
const PRICE_CELL = /^(?:(?:[`₹]|rs\.?)?\s*\d{1,3}(?:,\d{2,3})*(?:\.\d+)?\s*)+$|^(?:[`₹]\s*\d+(?:\.\d+)?\s*)+$/i;

// First price in the cell; a multi-colour cell lists the base colour first.
const price = (s) => (String(s ?? '').match(/\d[\d,]*(?:\.\d+)?/)?.[0] || '').replace(/,/g, '');

const COLOUR_WORDS = new Set(['BEIGE', 'COFFEE', 'DARK', 'LIGHT', 'GREY', 'GRAY', 'BLACK', 'WHITE', 'SNOW', 'IVORY', 'MATT', 'MATTE', 'GLOSSY',
  'FRENCH', 'ROSE', 'GOLD', 'SILVER', 'CHROME', 'PLATINUM', 'BRONZE', 'COPPER', 'BROWN', 'BLUE', 'GREEN', 'RED', 'PINK', 'CREAM', 'SILKY',
  'STAR', 'ANTIQUE', 'GUN', 'METAL', 'BRUSHED', 'NICKEL', 'CHAMPAGNE', 'ALMOND', 'PEARL', 'CHARCOAL', 'TITANIUM', 'SAND', '-', '&']);
const isColourOnly = (t) => String(t).toUpperCase().split(/\s+/).filter(Boolean).every((w) => COLOUR_WORDS.has(w));
const PRODUCT_NOUN = /\b(ewcs?|basins?|wash|cisterns?|urinals?|faucets?|mixers?|showers?|taps?|knobs?|couplings?|mirrors?|tanks?|bidets?|sinks?|covers?|plates?|valves?|spouts?|trays?|tiles?|closets?|pans?|wc)\b/i;

// ── 1. Positioned text -> lines of cells ──────────────────────────────────────
async function readPositionedText(filePath) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const pages = [];
  const pagerender = async (page) => {
    const tc = await page.getTextContent({ normalizeWhitespace: true });
    const items = tc.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
    pages.push(items);
    return '';
  };
  const data = await pdfParse(await fs.promises.readFile(filePath), { pagerender });
  return { pages, numPages: data.numpages };
}

function toLines(pages) {
  const lines = [];
  pages.forEach((items, pageIndex) => {
    const rows = [];
    for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5);
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    for (const r of rows.sort((a, b) => b.y - a.y)) {
      const cells = [];
      for (const it of r.items.sort((a, b) => a.x - b.x)) {
        const last = cells[cells.length - 1];
        const gap = last ? it.x - last.end : Infinity;
        // Glyph-by-glyph text (CERA) has ~0 gaps; real column breaks are much wider.
        if (last && gap < 6) {
          last.text += (gap > 1.5 && !last.text.endsWith(' ') && !it.s.startsWith(' ') ? ' ' : '') + it.s;
          last.end = it.x + it.w;
        } else {
          cells.push({ text: it.s, x: it.x, end: it.x + it.w });
        }
      }
      const clean = cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text);
      if (clean.length) lines.push({ page: pageIndex, y: r.y, cells: clean, text: clean.map((c) => c.text).join(' ') });
    }
  });
  return lines;
}

// A line that appears once per page on at least half of the pages is a page header/footer.
function boilerplateSet(lines, numPages) {
  if (numPages < 2) return new Set();
  const perPage = new Map();
  for (const l of lines) {
    const k = l.text.toLowerCase();
    if (!perPage.has(k)) perPage.set(k, new Map());
    const m = perPage.get(k);
    m.set(l.page, (m.get(l.page) || 0) + 1);
  }
  const out = new Set();
  for (const [k, m] of perPage) {
    const oncePerPage = [...m.values()].every((n) => n === 1);
    if (oncePerPage && m.size >= Math.max(2, numPages * 0.5)) out.add(k);
  }
  return out;
}

const nearestColumn = (cols, x, maxDist) => {
  let best = null; let bestD = Infinity;
  for (const c of cols) { const d = Math.abs(c.x - x); if (d < bestD) { bestD = d; best = c; } }
  return bestD <= maxDist ? best : null;
};

const finishFromName = (name) => {
  const up = ` ${String(name).toUpperCase()} `;
  return FINISH_WORDS.find((w) => up.includes(` ${w} `)) || '';
};

// ── 2a. Table strategy ────────────────────────────────────────────────────────
function tableStrategy(lines, mapHeader, boiler) {
  let cols = null;
  let pendingName = '';
  const rows = [];
  for (const l of lines) {
    if (boiler.has(l.text.toLowerCase())) continue;
    const keys = l.cells.map((c) => mapHeader(c.text));
    if (keys.includes('name') && keys.filter(Boolean).length >= 2) {
      cols = l.cells.map((c, i) => ({ key: keys[i], x: c.x })).filter((c) => c.key);
      pendingName = '';
      continue;
    }
    if (!cols) continue;
    const obj = {};
    for (const c of l.cells) {
      const col = nearestColumn(cols, c.x, 160);
      if (!col) continue;
      obj[col.key] = obj[col.key] ? `${obj[col.key]} ${c.text}` : c.text;
    }
    const others = Object.keys(obj).filter((k) => k !== 'name');
    if (!others.length) {                       // name-only line: a wrapped name, wait for the data line
      if (obj.name) pendingName = pendingName ? `${pendingName} ${obj.name}` : obj.name;
      continue;
    }
    obj.name = [pendingName, obj.name].filter(Boolean).join(' ').trim();
    pendingName = '';
    if (!obj.name) continue;
    if (!obj.finish) { const f = finishFromName(obj.name); if (f) obj.finish = f; }
    rows.push(obj);
  }
  return rows;
}

// ── 2b. Card strategy (header + one value line per product) ───────────────────
function cardStrategy(lines, mapHeader, boiler) {
  const rows = [];
  let blockStart = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i];
    const keys = l.cells.map((c) => mapHeader(c.text));
    if (keys.includes('name') || keys.filter(Boolean).length < 2) continue;
    const valuesLine = lines[i + 1];
    if (valuesLine.page !== l.page) continue;
    const cols = l.cells.map((c, idx) => ({ key: keys[idx], x: c.x }));
    const obj = {};
    for (const c of valuesLine.cells) {
      const col = nearestColumn(cols, c.x, 60);
      if (col?.key) obj[col.key] = c.text;
    }
    // Values that wrap ("MATT" / "CARVING" / "PRO") continue on the lines below, aligned under
    // their column. Every cell of such a line sits under a header column; a name line does not.
    let j = i + 2;
    while (j < lines.length && lines[j].page === l.page) {
      const next = lines[j];
      const hits = next.cells.map((c) => nearestColumn(cols, c.x, 40));
      if (!hits.every(Boolean)) break;
      next.cells.forEach((c, idx) => {
        const key = hits[idx].key;
        if (key && !QTY_LINE.test(c.text)) obj[key] = obj[key] ? `${obj[key]} ${c.text}` : c.text;
      });
      j++;
    }
    const block = lines.slice(blockStart, i)
      .filter((b) => !boiler.has(b.text.toLowerCase()) && !QTY_LINE.test(b.text) && !b.cells.map((c) => mapHeader(c.text)).filter(Boolean).length);
    blockStart = j;
    if (!block.length || !Object.keys(obj).length) continue;
    obj.name = block[0].text;
    const extra = block.slice(1).map((b) => b.text);
    const type = extra.find((t) => TILE_TYPES.test(t));
    if (type) obj.tile_type = type;
    const rest = extra.filter((t) => t !== type);
    if (rest.length) obj.description = rest.join(', ');
    rows.push(obj);
  }
  return rows;
}

// ── 2c. Catalogue strategy ("Cat. No. <code>" + price below) ──────────────────
function catalogueStrategy(lines) {
  const cells = [];
  for (const l of lines) for (const c of l.cells) cells.push({ ...c, page: l.page, y: l.y });
  const CAT = /^#?\s*cat\.?\s*no\.?\s*[.:]?\s*([A-Z0-9][A-Z0-9 \-/]{3,})$/i;
  // Upper-case product name; \p{Lu} so accented names like "CAFÉ - WHITE" qualify.
  const isName = (t) => /^[\p{Lu}0-9][\p{Lu}0-9 &\-./()'+]*$/u.test(t) && (t.match(/\p{Lu}/gu) || []).length >= 3 && !DIMS.test(t) && !/^CAT\b/i.test(t);
  const rows = [];
  for (const cat of cells) {
    const m = cat.text.match(CAT);
    if (!m) continue;
    const code = m[1].replace(/\s+/g, '');
    const samePage = cells.filter((c) => c.page === cat.page);
    // Price: on the code's own line to its right, otherwise the nearest price cell just below,
    // in both cases within the code's column (a neighbouring card starts ~130 units away).
    const inColumn = (c) => c.x >= cat.x - 10 && c.x <= cat.x + 140 && PRICE_CELL.test(c.text);
    const priceCell = samePage
      .filter((c) => Math.abs(c.y - cat.y) <= 2.5 && c.x > cat.x && inColumn(c))
      .sort((a, b) => a.x - b.x)[0]
      || samePage
        .filter((c) => c.y < cat.y - 2.5 && cat.y - c.y <= 25 && inColumn(c))
        .sort((a, b) => (cat.y - a.y) - (cat.y - b.y) || a.x - b.x)[0];
    if (!priceCell) continue;
    // Variant label ("S Trap 220 mm"): left of the price on its line, or, when the price shares
    // the code's line, the line directly below the code.
    const isVariant = (c) => Math.abs(c.x - cat.x) <= 12 && !PRICE_CELL.test(c.text) && !CAT.test(c.text) && !isName(c.text);
    const variant = Math.abs(priceCell.y - cat.y) <= 2.5
      ? samePage.filter((c) => c.y < cat.y && cat.y - c.y <= 12 && isVariant(c)).sort((a, b) => b.y - a.y)[0]
      : samePage.find((c) => Math.abs(c.y - priceCell.y) <= 2.5 && isVariant(c));
    const above = samePage
      .filter((c) => c.y > cat.y && c.y - cat.y <= 100 && Math.abs(c.x - cat.x) <= 12)
      .sort((a, b) => a.y - b.y);                  // nearest first
    const nameCell = above.find((c) => isName(c.text));
    if (!nameCell) continue;
    const dimsCell = above.find((c) => c.y < nameCell.y + 0.1 && DIMS.test(c.text.replace(/\s+/g, '')));

    // Card text between the name and the code, top to bottom: product type, finish, extras.
    const between = above
      .filter((c) => c.y < nameCell.y && c !== dimsCell && !CAT.test(c.text) && !PRICE_CELL.test(c.text) && !isName(c.text))
      .sort((a, b) => b.y - a.y)
      .map((c) => c.text);
    let finish = '';
    const details = [];
    for (let k = 0; k < between.length; k++) {
      const t = between[k];
      if (/^finish\b/i.test(t)) {
        finish = t.replace(/^finish\s*[-:]?\s*/i, '');
        // "Finish:" alone, or "Finish: Matte outside &" — the rest is on the next line.
        if ((!finish || /[&,]$/.test(finish)) && between[k + 1]) finish = `${finish} ${between[++k]}`.trim();
      } else {
        details.push(t);
      }
    }

    let baseName = nameCell.text;
    const row = { code, mrp: price(priceCell.text) };
    if (isColourOnly(baseName)) {
      // Sections like "CARLTON WALL HUNG EWCs" print only the colour on each card; the product
      // type is the descriptive line below it ("Rimless wall hung EWC").
      row.colour = baseName;
      const noun = details.findIndex((t) => PRODUCT_NOUN.test(t));
      if (noun >= 0) {
        const phrase = noun > 0 && !/^(with|pp|duroplast)\b/i.test(details[noun - 1]) ? `${details[noun - 1]} ${details[noun]}` : details[noun];
        baseName = `${phrase} - ${nameCell.text}`;
      }
    }
    row.name = variant ? `${baseName} (${variant.text})` : baseName;
    if (dimsCell) row.size = dimsCell.text.replace(/\s+/g, '');
    if (finish) row.finish = finish;
    if (details.length) row.description = details.join(', ');
    rows.push(row);
  }
  // A code can be picked up twice when two layouts overlap; keep the first.
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.code) ? false : seen.add(r.code)));
}

// ── 3. Entry point ────────────────────────────────────────────────────────────
const usefulCount = (rows) => rows.filter((r) => r.name && Object.keys(r).some((k) => k !== 'name' && k !== 'description' && r[k])).length;

/**
 * @param {string} filePath
 * @param {{ headerToFieldKey: (h: string) => string }} opts  header alias mapper from the import service
 * @returns {Promise<{ rows: string[][], layout: string }>}
 */
export async function pdfToRows(filePath, { headerToFieldKey }) {
  const { pages, numPages } = await readPositionedText(filePath);
  const totalChars = pages.reduce((n, items) => n + items.reduce((m, it) => m + it.s.trim().length, 0), 0);
  if (totalChars < 20) {
    throw new Error('This PDF has no readable text, it is made of scanned images. Ask the supplier for the Excel price list, or type the items into the Excel template.');
  }

  const lines = toLines(pages);
  const boiler = boilerplateSet(lines, numPages);
  const candidates = [
    { layout: 'table', rows: tableStrategy(lines, headerToFieldKey, boiler) },
    { layout: 'cards', rows: cardStrategy(lines, headerToFieldKey, boiler) },
    { layout: 'catalogue', rows: catalogueStrategy(lines) },
  ].sort((a, b) => usefulCount(b.rows) - usefulCount(a.rows));
  const best = candidates[0];
  if (!usefulCount(best.rows)) {
    throw new Error('No product table was recognised in this PDF. It needs either a header row (Product Name, Size, MRP...), a SIZE / FINISH block per product, or "Cat. No." codes with prices.');
  }

  const keys = [...new Set(best.rows.flatMap((r) => Object.keys(r)))];
  const ordered = ['name', ...keys.filter((k) => k !== 'name')];
  return { layout: best.layout, rows: [ordered, ...best.rows.map((r) => ordered.map((k) => r[k] ?? ''))] };
}
