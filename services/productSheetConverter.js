// Converts the "BDM code" price-list sheet layout into the canonical bulk-import columns.
//
// Source columns:
//   LOCATION, BDMCODE, SIZE, THICKNESS, GODOWN, PRODUCT NAME, PKG, SURFACE, USES,
//   BRAND, COVERAGE, DP/BOX, DP/SQFT, MRP/BOX, MRP/SQFT
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export const isBdmSheet = (headerCells) => {
  const set = new Set(headerCells.map(norm));
  return set.has('productname') && set.has('bdmcode');
};

const firstNumber = (v) => {
  const m = String(v ?? '').match(/\d+(\.\d+)?/);
  return m ? m[0] : '';
};

// "600x1200x9MM" -> "600x1200"; "1200 X 1800" -> "1200x1800"
const cleanSize = (v) => {
  const parts = String(v ?? '').toLowerCase().replace(/\s+/g, '').replace(/mm/g, '').split('x').filter(Boolean);
  return parts.slice(0, 2).join('x');
};

const OUT_HEADERS = [
  'Item_Name', 'Product_Code', 'Brand', 'Tile_Size', 'Thickness', 'Surface', 'Finish',
  'Application_Area', 'Pieces_Per_Box', 'Sqft_Per_Box', 'Dealer_Rate', 'MRP', 'Unit', 'Description',
];

/** rows: string[][] where rows[headerIdx] is the BDM header. Returns canonical rows incl. header. */
export function convertBdmRows(rows, headerIdx) {
  const idx = {};
  rows[headerIdx].forEach((h, i) => { idx[norm(h)] = i; });
  const get = (row, key) => String(row[idx[key]] ?? '').trim();

  const out = [OUT_HEADERS];
  for (const row of rows.slice(headerIdx + 1)) {
    if (row.every((c) => !String(c || '').trim())) continue;
    const surface = get(row, 'surface');
    const location = get(row, 'location');
    const godown = get(row, 'godown');
    out.push([
      get(row, 'productname'),
      get(row, 'bdmcode'),
      get(row, 'brand'),
      cleanSize(get(row, 'size')),
      get(row, 'thickness'),
      surface,
      surface.includes('-') ? surface.split('-').slice(1).join('-').trim() : surface,
      get(row, 'uses'),
      firstNumber(get(row, 'pkg')),
      get(row, 'coverage'),
      get(row, 'dpbox'),
      get(row, 'mrpbox'),
      'Box',
      [location && `Location: ${location}`, godown && `Godown: ${godown}`].filter(Boolean).join(', '),
    ]);
  }
  return out;
}
