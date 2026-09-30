import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']);
const BASE = 'http://127.0.0.1:5000/api/v1';
const get = async (p) => (await (await fetch(BASE + p)).json());

function facetGroups(options) {
  if (!options) return [];
  const groups = [];
  const push = (label, key, values) => {
    const clean = (values || []).filter((v) => String(v || '').trim());
    if (clean.length) groups.push({ key, label, values: clean });
  };
  push('By Size', 'tileSize', options.tileSizes);
  push('By Type', 'tileType', options.tileTypes);
  push('By Colour', 'colour', options.colours);
  push('By Finish', 'finish', options.finishes);
  push('By Surface', 'surface', options.surfaces);
  push('By Thickness', 'thickness', options.thicknesses);
  push('By Application', 'applicationArea', options.applicationAreas);
  for (const a of options.attributes || []) push('By ' + a.label, a.key, a.options);
  return groups;
}

const cats = (await get('/shop/content/categories')).data;
const navItems = cats.departments.filter((d) => d.showOnHome);

console.log('=== the nav items (departments flagged showOnHome) ===');
for (const d of navItems) console.log('  · ' + d.name + '   (' + d.categories.length + ' subcategories)');

console.log('\n=== each dropdown: its own subcategories + its own filters ===');
for (const d of navItems) {
  const opts = (await get('/shop/products/filter-options?category=' + d.id)).data;
  const groups = facetGroups(opts);
  console.log('\n  > ' + d.name);
  console.log('      Shop by type : ' + (d.categories.map((c) => c.name).join(', ') || '(none)'));
  if (!groups.length) console.log('      filters      : (none yet)');
  for (const g of groups) {
    console.log('      ' + g.label.padEnd(16) + ': ' + g.values.slice(0, 8).join(', ') + (g.values.length > 8 ? ' ...' : ''));
  }
}

console.log('\n=== the key check ===');
const tiles = navItems.find((d) => d.slug === 'tiles');
const tileGroups = facetGroups((await get('/shop/products/filter-options?category=' + tiles.id)).data);
console.log('  Tiles columns        : ' + (tileGroups.map((g) => g.label).join(', ') || '(none)'));
const stone = navItems.find((d) => d.slug === 'stone-slabs');
if (stone) {
  const stoneGroups = facetGroups((await get('/shop/products/filter-options?category=' + stone.id)).data);
  console.log('  Stone & Slabs columns: ' + (stoneGroups.map((g) => g.label).join(', ') || '(none)'));
  console.log('  Different per department: ' + (tileGroups.map(g => g.key).join() !== stoneGroups.map(g => g.key).join() ? 'YES' : 'NO'));
}
