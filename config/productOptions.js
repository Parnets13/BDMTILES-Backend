/**
 * Canonical option lists for the Product Master specification dropdowns.
 *
 * These used to live as hardcoded arrays in the web admin's ProductMaster.jsx, which meant
 * adding a finish or a tile size was a code change and a redeploy. They now live here so the
 * server can serve defaults + anything the admin has added (models/ProductOption.js), and the
 * form gets one list per field.
 *
 * The keys are the Product field names, so `GET /products/options` returns a map the form can
 * index directly: `options.tileSize`, `options.finish`, and so on.
 *
 * These are SEEDS, not a closed set. Anything here can be extended from the UI at runtime, and
 * nothing validates a product against this list — an unknown value is still stored, so a product
 * saved before a list changed never becomes unsaveable.
 */
export const PRODUCT_OPTION_DEFAULTS = {
  tileSize: [
    // Mosaic / small
    '50x50', '75x75', '100x100', '100x200', '100x300', '150x150', '150x300',
    // Standard small
    '200x200', '200x300', '200x400', '200x600',
    '250x375', '250x500',
    '300x300', '300x450', '300x600', '300x900',
    '400x400', '400x600', '400x800',
    // Mid-size
    '600x600', '600x900', '600x1200',
    '800x800', '800x1200', '800x1600',
    // Large format
    '1000x1000',
    '1200x1200', '1200x1800', '1200x2400',
    '1600x1600', '1600x3200',
    '800x2400',
  ],
  tileType: [
    'Ceramic', 'Vitrified', 'GVT', 'PGVT', 'Double Charge', 'Full Body',
    'Porcelain', 'Slab', 'Natural Stone', 'Granite', 'Marble',
  ],
  finish: [
    'Glossy', 'Matt', 'Sugar', 'Carving', 'Satin', 'Rustic',
    'Polished', 'Lapato', 'High Gloss', 'Anti-Skid', 'Rocker', 'Book Match',
  ],
  surface: ['Smooth', 'Rough', 'Textured', 'Structured', 'Matt', 'Polished'],
  colour: [
    'White', 'Ivory', 'Beige', 'Grey', 'Charcoal', 'Black',
    'Brown', 'Blue', 'Green', 'Pink', 'Yellow', 'Multi Colour',
  ],
  thickness: ['6mm', '7mm', '8mm', '9mm', '10mm', '12mm', '15mm', '20mm'],
  grade: ['A', 'B', 'C'],
  application: [
    'Floor', 'Wall', 'Bathroom', 'Kitchen', 'Parking', 'Elevation',
    'Outdoor', 'Swimming Pool', 'Commercial', 'Industrial',
  ],
  antiSkid: ['R9', 'R10', 'R11', 'R12', 'R13'],
  origin: ['India', 'Spain', 'Italy', 'China', 'Vietnam', 'Indonesia', 'Turkey'],
};

/** Every field the admin is allowed to extend. Anything else is rejected by the API. */
export const PRODUCT_OPTION_FIELDS = Object.keys(PRODUCT_OPTION_DEFAULTS);

export const MAX_OPTION_LENGTH = 60;

/**
 * Per-field format rules for values the admin adds.
 *
 * `normalise` returns the canonical form, or null when the value cannot be salvaged; `hint` is
 * the sentence shown in the form and returned by the API on rejection.
 *
 * Only fields where a free-text value would actually BREAK something get a rule:
 *
 *   tileSize   the important one. `sqftPerTile()` parses "WxH" to work out SqFt/Box, so a size
 *              stored as "1010" produces no calculation at all and the admin has no idea why.
 *   thickness  a measurement, and the UI shows it beside a unit.
 *   antiSkid   a rating code that is compared and filtered on.
 *   grade      a short code that is sorted and grouped on.
 *
 * finish / surface / colour / tileType / application / origin are descriptive NAMES, not
 * measurements — they get trimmed and have their inner whitespace collapsed, and nothing more.
 * Imposing a pattern on a name only invents rejections.
 */
export const PRODUCT_OPTION_RULES = {
  tileSize: {
    hint: 'Tile size must be width x height in mm — for example 600x600 or 10x10.',
    normalise(value) {
      // Accepts 600x600, 600 x 600, 600X600 and 600×600, and stores the first form.
      const match = /^(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)$/.exec(value);
      if (!match) return null;
      if (Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
      return `${match[1]}x${match[2]}`;
    },
  },
  thickness: {
    hint: 'Thickness must be a measurement in mm — for example 10mm.',
    normalise(value) {
      const match = /^(\d+(?:\.\d+)?)\s*(mm|cm)?$/i.exec(value);
      if (!match) return null;
      const mm = String(match[2] || '').toLowerCase() === 'cm'
        ? Number(match[1]) * 10
        : Number(match[1]);
      if (!(mm > 0)) return null;
      return `${Number.isInteger(mm) ? mm : Number(mm.toFixed(1))}mm`;
    },
  },
  antiSkid: {
    hint: 'Anti-skid rating must be R followed by a number — for example R10.',
    normalise(value) {
      const match = /^r\s*(\d{1,2})$/i.exec(value);
      return match ? `R${match[1]}` : null;
    },
  },
  grade: {
    hint: 'Grade must be a short code of up to 3 letters or digits — for example A or AA1.',
    normalise(value) {
      const upper = value.toUpperCase();
      return /^[A-Z0-9]{1,3}$/.test(upper) ? upper : null;
    },
  },
};

/**
 * Clean up a value before it is stored.
 *
 * Returns `{ ok: true, value }` with the canonical form, or `{ ok: false, message }` carrying
 * the field's hint. Every field is trimmed with inner whitespace collapsed, so "Satin   Matt"
 * and "Satin Matt" are not two different options.
 */
export const normaliseOptionValue = (field, rawValue) => {
  const collapsed = String(rawValue || '').trim().replace(/\s+/g, ' ');
  if (!collapsed) return { ok: false, message: 'Enter a value to add.' };

  const rule = PRODUCT_OPTION_RULES[field];
  if (!rule) return { ok: true, value: collapsed };

  const normalised = rule.normalise(collapsed);
  if (!normalised) return { ok: false, message: rule.hint };
  return { ok: true, value: normalised };
};

/** Case-insensitive membership, so "White" and "white" are the same option. */
export const optionExists = (list, value) => (
  (list || []).some((existing) => String(existing).toLowerCase() === String(value).toLowerCase())
);

/**
 * Tile sizes read as a scale, so they are ordered by width then height.
 *
 * Without this a size the admin adds lands at the very bottom — after 1600x3200 — which looks
 * like a mistake rather than a 10x10. Ordering also fixes the one seeded entry that was out of
 * place (800x2400 sat last despite being smaller than 1600x1600).
 *
 * The other lists keep their curated order, because their sequence carries meaning (finish runs
 * from plain to decorative, and re-sorting those alphabetically would scramble it).
 */
const tileSizeOrder = (value) => {
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(String(value));
  return match ? [Number(match[1]), Number(match[2])] : [Infinity, Infinity];
};

/** Defaults for one field, with the branch's custom values merged in. */
export const mergedOptions = (field, customValues = []) => {
  const merged = [...(PRODUCT_OPTION_DEFAULTS[field] || [])];
  for (const value of customValues) {
    if (!optionExists(merged, value)) merged.push(String(value));
  }
  if (field === 'tileSize') {
    merged.sort((a, b) => {
      const [aw, ah] = tileSizeOrder(a);
      const [bw, bh] = tileSizeOrder(b);
      return aw - bw || ah - bh || String(a).localeCompare(String(b));
    });
  }
  return merged;
};

/**
 * Which Product field each dropdown writes to.
 *
 * Needed to answer "is this option still in use?" before deleting one — the option list and the
 * product field are not always named the same (`application` is stored in `applicationArea`).
 */
export const PRODUCT_OPTION_PRODUCT_FIELD = {
  tileSize: 'tileSize',
  tileType: 'tileType',
  finish: 'finish',
  surface: 'surface',
  colour: 'colour',
  thickness: 'thickness',
  grade: 'grade',
  application: 'applicationArea',
  antiSkid: 'antiSkidRating',
  origin: 'countryOfOrigin',
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A Mongo filter matching the products that use this option value.
 *
 * Most fields hold one plain value, but `application` is stored as a comma-joined string
 * ("Floor, Wall, Bathroom"), so an exact match would miss it. There it is matched as a whole
 * comma-separated token — a plain substring match would let deleting "Wall" be blocked by a
 * product that only says "Wall Cladding".
 */
export const productUsageFilter = (field, value) => {
  const path = PRODUCT_OPTION_PRODUCT_FIELD[field];
  if (!path) return null;
  if (field === 'application') {
    return { [path]: new RegExp(`(^|,\\s*)${escapeRegex(value)}(\\s*,|$)`, 'i') };
  }
  return { [path]: new RegExp(`^\\s*${escapeRegex(value)}\\s*$`, 'i') };
};
