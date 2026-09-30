/**
 * The vertical taxonomy — 19 departments, their categories, subcategories and attributes.
 *
 * This is the seed for the multi-vertical catalogue. Until it runs, the system only knows
 * about tiles; after it, every department the client actually sells has a place to file a
 * product, and each declares the attributes its products carry.
 *
 * Structure:
 *   department (level 1)  -> `attributes` are inherited by every category beneath it
 *     category (level 2)  -> its own `attributes` add to the inherited set
 *       subcategory (level 3) -> names only; they inherit everything above
 *
 * Editing rules:
 *  - `key` is the machine name stored on Product.attributes. Never rename one that products
 *    already use — their values would become unreachable. `label` is safe to reword.
 *  - `filterable: true` puts the attribute in the storefront filter rail. Keep the option
 *    lists bounded; a free-text field cannot be offered as a filter.
 *  - A `select` needs at least one option, or the form field is unfillable.
 *  - Only declare an attribute where it genuinely differs per product. Anything constant
 *    across a whole department belongs in the template, not here.
 */

// ── Reusable attribute builders ───────────────────────────────────────────────
// Several of these repeat across departments. Defining them once keeps the option lists
// consistent, so "Glossy" is spelled the same way in Tiles and in Laminates.

const finish = (options = ['Glossy', 'Matt', 'Satin', 'Textured', 'Rustic']) =>
  ({ key: 'finish', label: 'Finish', type: 'select', options, filterable: true });

const thickness = (options, unit = 'mm') =>
  ({ key: 'thickness', label: 'Thickness', type: 'select', options, unit, filterable: true });

const colour = (options) =>
  ({ key: 'colour', label: 'Colour', type: 'select', options, filterable: true });

const material = (options) =>
  ({ key: 'material', label: 'Material', type: 'select', options, filterable: true });

const packSize = (options, unit = '') =>
  ({ key: 'packSize', label: 'Pack Size', type: 'select', options, unit, filterable: true });

const size = (options, unit = 'mm') =>
  ({ key: 'size', label: 'Size', type: 'select', options, unit, filterable: true });

const brandGrade = (options) =>
  ({ key: 'grade', label: 'Grade', type: 'select', options, filterable: true });

const warranty = () =>
  ({ key: 'warranty', label: 'Warranty', type: 'text', help: 'e.g. 1 year, 5 years' });

export const VERTICAL_TAXONOMY = [
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Building Materials',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'building-materials',
    showOnHome: true,
    badge: 'Bulk Prices',
    attributes: [],
    categories: [
      {
        name: 'Cement',
        attributes: [
          brandGrade(['OPC 43', 'OPC 53', 'PPC', 'PSC', 'White Cement', 'Rapid Hardening']),
          packSize(['50 kg Bag', '25 kg Bag', '1 kg Pouch', '5 kg Pouch']),
          { key: 'settingTime', label: 'Setting Time', type: 'select', options: ['30 minutes', '45 minutes', '60 minutes'] },
        ],
        subcategories: [],
      },
      {
        name: 'Sand & Aggregates',
        attributes: [
          { key: 'aggregateType', label: 'Type', type: 'select', options: ['River Sand', 'M-Sand', 'P-Sand', '20mm Aggregate', '10mm Aggregate', 'Grit'], filterable: true },
          { key: 'unitOfSale', label: 'Sold By', type: 'select', options: ['CFT', 'Tonne', 'Bag', 'Tractor Trolley'], filterable: true },
        ],
        subcategories: [],
      },
      {
        name: 'Blocks & Bricks',
        attributes: [
          { key: 'blockType', label: 'Type', type: 'select', options: ['AAC Block', 'Fly Ash Brick', 'Red Clay Brick', 'Concrete Block', 'Solid Block'], filterable: true },
          size(['600x200x100 mm', '600x200x150 mm', '600x200x200 mm', '230x110x75 mm'], 'mm'),
        ],
        subcategories: [],
      },
      {
        name: 'TMT Steel Bars',
        attributes: [
          { key: 'barDiameter', label: 'Diameter', type: 'select', options: ['6 mm', '8 mm', '10 mm', '12 mm', '16 mm', '20 mm', '25 mm'], filterable: true },
          brandGrade(['Fe 500', 'Fe 500D', 'Fe 550', 'Fe 550D']),
        ],
        subcategories: [],
      },
      {
        name: 'Readymix Concrete',
        attributes: [
          brandGrade(['M10', 'M15', 'M20', 'M25', 'M30', 'M35', 'M40']),
          { key: 'deliveryMode', label: 'Delivery', type: 'select', options: ['Transit Mixer', 'Site Mix'], filterable: true },
        ],
        subcategories: [],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Tiles',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'tiles',
    showOnHome: true,
    badge: 'Bulk Prices',
    // Tiles deliberately declares NO attributes.
    //
    // Its fields are the dedicated Tile Specifications block on the product form —
    // size, finish, surface, pcs/box and the auto-calculated sqft/box — which writes to
    // real product columns the storefront and the order flow read. Declaring them here
    // as attributes too made every one of them render TWICE on the form, and made the
    // website filter rail offer tile facets for cement and sanitaryware.
    attributes: [],
    categories: [
      { name: 'Floor Tiles', attributes: [], subcategories: ['Vitrified', 'Double Charge', 'GVT', 'PGVT', 'Full Body Vitrified', 'Ceramic', 'Porcelain'] },
      { name: 'Wall Tiles', attributes: [], subcategories: ['Ceramic', 'Glazed', 'Digital', 'Highlighter', 'Border & Mosaic'] },
      { name: 'Outdoor & Parking Tiles', attributes: [], subcategories: ['Parking', 'Anti-Skid', 'Rustic', '20mm Outdoor'] },
      { name: 'Elevation Tiles', attributes: [], subcategories: ['Stone Look', 'Brick Look', '3D', 'Wood Look'] },
      { name: 'Mosaic & Designer Tiles', attributes: [], subcategories: ['Glass Mosaic', 'Ceramic Mosaic', 'Hexagon', 'Subway'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Stone & Slabs',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'stone-slabs',
    showOnHome: true,
    attributes: [
      { key: 'slabLength', label: 'Slab Length', type: 'number', unit: 'ft' },
      { key: 'slabWidth', label: 'Slab Width', type: 'number', unit: 'ft' },
      thickness(['16 mm', '18 mm', '20 mm', '30 mm', '40 mm']),
      finish(['Polished', 'Honed', 'Flamed', 'Bush Hammered', 'Leather', 'Lapotra', 'Raw']),
      { key: 'origin', label: 'Origin', type: 'text', help: 'e.g. Rajasthan, Karnataka, Imported (Italy)' },
      { key: 'veining', label: 'Veining', type: 'select', options: ['Uniform', 'Light Veins', 'Heavy Veins', 'Bookmatch Available'] },
      { key: 'lotNumber', label: 'Lot Number', type: 'text', help: 'Slabs must come from one lot for matching veining' },
      { key: 'slabsPerLot', label: 'Slabs per Lot', type: 'number' },
      // Calculated: slabLength x slabWidth. See utils/productCalculations.js.
      // The KEY is deliberately the same across every vertical — `areaPerUnit` means "area of
      // one selling unit" — so the pricing and order code can read one field instead of
      // learning a new name per category. Only the LABEL differs.
      { key: 'areaPerUnit', label: 'Sq.Ft per slab', type: 'number', unit: 'sqft', calculated: true },
    ],
    categories: [
      {
        name: 'Granite',
        attributes: [{ key: 'graniteVariety', label: 'Variety', type: 'text', help: 'e.g. Black Galaxy, Tan Brown, Steel Grey' }],
        subcategories: ['Black Galaxy', 'Tan Brown', 'Steel Grey', 'Absolute Black', 'Rosy Pink', 'Ivory Fantasy', 'Chima Pink', 'Black Forest'],
      },
      {
        name: 'Marble',
        attributes: [{ key: 'marbleVariety', label: 'Variety', type: 'text', help: 'e.g. Makrana, Statuario, Katni' }],
        subcategories: ['Makrana White', 'Statuario', 'Katni', 'Green Marble', 'Onyx', 'Botticino', 'Rainforest'],
      },
      { name: 'Quartz', attributes: [], subcategories: ['Engineered Quartz', 'Quartz Slab'] },
      { name: 'Sandstone', attributes: [], subcategories: ['Red Sandstone', 'Yellow Sandstone', 'Grey Sandstone'] },
      { name: 'Limestone', attributes: [], subcategories: ['Kota Stone', 'Tandur', 'Cuddapah'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Sanitaryware',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'sanitaryware',
    showOnHome: true,
    attributes: [
      material(['Ceramic', 'Vitreous China', 'Fine Fire Clay', 'Stainless Steel', 'Acrylic']),
      finish(['White', 'Ivory', 'Glossy White', 'Matt White', 'Coloured']),
      { key: 'mountType', label: 'Mount Type', type: 'select', options: ['Wall Hung', 'Floor Mounted', 'Table Top', 'Counter Top', 'One Piece', 'Corner'], filterable: true },
      { key: 'trapType', label: 'Trap Type', type: 'select', options: ['P-Trap', 'S-Trap', 'Universal'] },
      { key: 'size', label: 'Size', type: 'text', help: 'e.g. 560 x 380 x 400 mm' },
      warranty(),
    ],
    categories: [
      { name: 'Water Closets', attributes: [{ key: 'flushType', label: 'Flush Type', type: 'select', options: ['Siphonic', 'Wash Down', 'Dual Flush'], filterable: true }], subcategories: ['Wall Hung', 'Floor Mounted', 'One Piece', 'Squatting Pan', 'Western'] },
      { name: 'Wash Basins', attributes: [], subcategories: ['Wall Hung', 'Table Top', 'Counter Top', 'Pedestal', 'Corner'] },
      { name: 'Cisterns & Seats', attributes: [], subcategories: ['Concealed Cistern', 'Exposed Cistern', 'Seat Cover', 'Flush Valve'] },
      { name: 'Urinals & Bidets', attributes: [], subcategories: ['Wall Mounted Urinal', 'Floor Urinal', 'Bidet', 'Gents Urinal Partition'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Bath Fittings',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'bath-fittings',
    showOnHome: false,
    attributes: [
      material(['Brass', 'Chrome Plated Brass', 'Stainless Steel 304', 'ABS', 'Zinc']),
      finish(['Chrome', 'Matte Black', 'Rose Gold', 'Antique Brass', 'Gold', 'SS Finish', 'PVD']),
      { key: 'mountType', label: 'Mount Type', type: 'select', options: ['Wall Mounted', 'Ceiling Mounted', 'Deck Mounted', 'Hand Held', 'Concealed'], filterable: true },
      warranty(),
    ],
    categories: [
      { name: 'Shower Heads & Panels', attributes: [{ key: 'sprayPatterns', label: 'Spray Patterns', type: 'select', options: ['Single', '2-Function', '3-Function', 'Multi-Function'] }], subcategories: ['Rain Shower', 'Hand Shower', 'Shower Panel', 'Overhead Shower'] },
      { name: 'Taps & Diverters', attributes: [], subcategories: ['Single Lever', 'Bib Cock', 'Pillar Cock', 'Diverter', 'Angle Valve'] },
      { name: 'Health Faucets', attributes: [], subcategories: ['Health Faucet Set', 'Shattaf', 'Jet Spray'] },
      { name: 'Bath Accessories', attributes: [], subcategories: ['Towel Rod', 'Soap Dish', 'Tumbler Holder', 'Towel Ring', 'Robe Hook', 'Shelf'] },
      { name: 'Mirrors & Cabinets', attributes: [], subcategories: ['LED Mirror', 'Mirror Cabinet', 'Plain Mirror', 'Magnifying Mirror'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Plumbing',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'plumbing',
    showOnHome: false,
    attributes: [
      material(['CPVC', 'UPVC', 'PVC', 'GI', 'PPR', 'HDPE', 'Brass', 'Stainless Steel']),
      { key: 'diameter', label: 'Diameter', type: 'select', options: ['15 mm (1/2")', '20 mm (3/4")', '25 mm (1")', '32 mm (1.25")', '40 mm (1.5")', '50 mm (2")', '63 mm', '75 mm', '90 mm', '110 mm', '160 mm'], filterable: true },
      { key: 'pressureRating', label: 'Pressure Rating', type: 'select', options: ['PN6', 'PN10', 'PN12.5', 'PN16', 'SDR 11', 'SDR 13.5'] },
      { key: 'length', label: 'Length per Piece', type: 'select', options: ['3 m', '5 m', '6 m', 'Roll of 50 m', 'Roll of 100 m'], filterable: true },
      brandGrade(['Schedule 40', 'Schedule 80', 'Heavy Duty', 'Standard']),
    ],
    categories: [
      { name: 'Pipes', attributes: [], subcategories: ['CPVC Pipe', 'UPVC Pipe', 'PVC Pipe', 'GI Pipe', 'PPR Pipe', 'HDPE Pipe'] },
      { name: 'Pipe Fittings', attributes: [], subcategories: ['Elbow', 'Tee', 'Coupler', 'Reducer', 'Union', 'Bend', 'Socket', 'End Cap'] },
      { name: 'Valves & Taps', attributes: [], subcategories: ['Gate Valve', 'Ball Valve', 'Check Valve', 'Butterfly Valve', 'Float Valve', 'Bib Cock'] },
      { name: 'Water Tanks', attributes: [{ key: 'capacity', label: 'Capacity', type: 'select', options: ['200 L', '500 L', '750 L', '1000 L', '1500 L', '2000 L', '5000 L'], filterable: true }], subcategories: ['Overhead Tank', 'Underground Tank', 'Loft Tank', 'Slim Tank'] },
      { name: 'Drainage & Sewage', attributes: [], subcategories: ['SWR Pipe', 'Nahani Trap', 'Floor Trap', 'Manhole Cover', 'Inspection Chamber'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Construction Chemicals',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'construction-chemicals',
    showOnHome: false,
    attributes: [
      { key: 'chemType', label: 'Type', type: 'select', options: ['Waterproofing', 'Adhesive', 'Grout', 'Admixture', 'Sealant', 'Epoxy', 'Bonding Agent', 'Release Agent'], filterable: true },
      packSize(['1 kg', '5 kg', '10 kg', '20 kg', '40 kg', '1 L', '5 L', '10 L', '20 L']),
      { key: 'coverage', label: 'Coverage', type: 'text', help: 'e.g. 40 sq.ft / kg per coat' },
      { key: 'potLife', label: 'Pot Life', type: 'text', help: 'e.g. 30 minutes at 30°C' },
      { key: 'dryingTime', label: 'Drying Time', type: 'text' },
      { key: 'surfacePrep', label: 'Surface Preparation', type: 'text' },
    ],
    categories: [
      { name: 'Waterproofing', attributes: [{ key: 'applicationType', label: 'Application', type: 'select', options: ['Terrace', 'Bathroom', 'Basement', 'Water Tank', 'External Wall', 'Swimming Pool'], filterable: true }], subcategories: ['Terrace Coat', 'Bathroom Coat', 'Basement Coat', 'Waterproof Admixture', 'Crystalline Waterproofing'] },
      { name: 'Tile Adhesives & Grouts', attributes: [brandGrade(['Type 1', 'Type 2', 'Type 3', 'Type 4', 'C1', 'C2', 'C2TE'])], subcategories: ['Tile Adhesive', 'Tile Grout', 'Epoxy Grout', 'Epoxy Adhesive', 'Tile Cleaner'] },
      { name: 'Concrete Admixtures', attributes: [], subcategories: ['Plasticiser', 'Superplasticiser', 'Accelerator', 'Retarder', 'Air Entraining'] },
      { name: 'Sealants & Epoxy', attributes: [], subcategories: ['Silicone Sealant', 'PU Sealant', 'Epoxy Resin', 'Epoxy Hardener', 'Crack Filler'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Electricals',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'electricals',
    showOnHome: true,
    attributes: [
      material(['Copper', 'Aluminium', 'PVC', 'Brass', 'Steel', 'Polycarbonate']),
      { key: 'voltage', label: 'Voltage', type: 'select', options: ['110 V', '240 V', '415 V', '1.1 kV', '11 kV'], filterable: true },
      { key: 'currentRating', label: 'Current Rating', type: 'select', options: ['6 A', '10 A', '16 A', '20 A', '25 A', '32 A', '40 A', '63 A'], filterable: true },
      warranty(),
    ],
    categories: [
      { name: 'Wires & Cables', attributes: [{ key: 'wireSize', label: 'Cross Section', type: 'select', options: ['0.75 sq.mm', '1.0 sq.mm', '1.5 sq.mm', '2.5 sq.mm', '4 sq.mm', '6 sq.mm', '10 sq.mm'], filterable: true }, { key: 'coilLength', label: 'Coil Length', type: 'select', options: ['90 m', '180 m', '500 m'], unit: 'm', filterable: true }], subcategories: ['FR Wire', 'FRLS Wire', 'Multi-Strand Wire', 'Flexible Cable', 'Armoured Cable', 'Coaxial Cable', 'CAT6 Cable'] },
      { name: 'Switches & Sockets', attributes: [{ key: 'moduleSize', label: 'Module Size', type: 'select', options: ['2 Module', '3 Module', '4 Module', '6 Module', '8 Module', '12 Module'], filterable: true }], subcategories: ['Modular Switch', 'Socket 6A', 'Socket 16A', 'Plate & Frame', 'Dimmer', 'Bell Push', 'USB Socket'] },
      { name: 'MCBs & Distribution', attributes: [{ key: 'poles', label: 'Poles', type: 'select', options: ['SP', 'DP', 'TP', 'FP', 'TPN'], filterable: true }, { key: 'breakingCapacity', label: 'Breaking Capacity', type: 'select', options: ['6 kA', '10 kA', '16 kA', '25 kA'] }], subcategories: ['MCB', 'RCCB', 'MCCB', 'Distribution Board', 'Isolator', 'Changeover Switch'] },
      { name: 'Conduits & GI Boxes', attributes: [{ key: 'conduitDiameter', label: 'Diameter', type: 'select', options: ['20 mm', '25 mm', '32 mm', '40 mm', '50 mm'], filterable: true }], subcategories: ['PVC Conduit', 'Flexible Conduit', 'GI Box', 'Conduit Bend', 'Junction Box'] },
      { name: 'Fans & Ventilation', attributes: [{ key: 'sweepSize', label: 'Sweep Size', type: 'select', options: ['600 mm', '900 mm', '1200 mm', '1400 mm'], filterable: true }], subcategories: ['Ceiling Fan', 'Table Fan', 'Wall Fan', 'Exhaust Fan', 'Tower Fan', 'Bldc Fan'] },
      { name: 'Power Backup', attributes: [{ key: 'capacityKva', label: 'Capacity', type: 'text', help: 'e.g. 5 kVA, 100 Ah' }], subcategories: ['Inverter', 'Battery', 'UPS', 'Stabiliser', 'Generator', 'Solar Panel'] },
      { name: 'CCTV & Security', attributes: [{ key: 'resolution', label: 'Resolution', type: 'select', options: ['2 MP', '3 MP', '4 MP', '5 MP', '8 MP (4K)'], filterable: true }], subcategories: ['Dome Camera', 'Bullet Camera', 'PTZ Camera', 'DVR / NVR', 'Video Door Phone', 'Cable & Connector'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Lighting',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'lighting',
    showOnHome: false,
    attributes: [
      { key: 'wattage', label: 'Wattage', type: 'select', options: ['3 W', '5 W', '7 W', '9 W', '12 W', '15 W', '18 W', '24 W', '36 W', '50 W', '100 W'], filterable: true },
      { key: 'colourTemperature', label: 'Colour Temperature', type: 'select', options: ['2700K Warm White', '3000K Warm', '4000K Neutral', '6500K Cool Daylight', 'RGB'], filterable: true },
      { key: 'lumens', label: 'Lumens', type: 'number', unit: 'lm' },
      { key: 'ipRating', label: 'IP Rating', type: 'select', options: ['IP20', 'IP44', 'IP54', 'IP65', 'IP66', 'IP67'], filterable: true },
      { key: 'bodyMaterial', label: 'Body Material', type: 'select', options: ['Aluminium', 'Polycarbonate', 'ABS Plastic', 'Steel', 'Glass', 'Brass'], filterable: true },
      { key: 'beamAngle', label: 'Beam Angle', type: 'select', options: ['15°', '24°', '36°', '60°', '120°', '180°'] },
      warranty(),
    ],
    categories: [
      { name: 'LED Panels & Downlights', attributes: [{ key: 'shape', label: 'Shape', type: 'select', options: ['Round', 'Square', 'Rectangular', 'Linear'], filterable: true }], subcategories: ['Round Panel', 'Square Panel', 'Concealed Light', 'COB Light', 'Spot Light', 'Linear Light'] },
      { name: 'Bulbs & Lamps', attributes: [{ key: 'baseType', label: 'Base Type', type: 'select', options: ['B22', 'E27', 'GU10', 'G9', 'T5', 'T8'], filterable: true }], subcategories: ['LED Bulb', 'Tube Light', 'CFL', 'Halogen', 'Filament Bulb'] },
      { name: 'Decorative Lighting', attributes: [], subcategories: ['Chandelier', 'Pendant Light', 'Wall Sconce', 'Table Lamp', 'Floor Lamp'] },
      { name: 'Outdoor & Flood Lights', attributes: [], subcategories: ['Flood Light', 'Street Light', 'Garden Light', 'Bollard Light', 'Solar Light'] },
      { name: 'Profile & Strip Lights', attributes: [], subcategories: ['LED Strip', 'Aluminium Profile', 'Cove Light', 'Neon Flex'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Paints & Coatings',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'paints-coatings',
    showOnHome: true,
    badge: 'Bulk Prices',
    attributes: [
      finish(['Matt', 'Glossy', 'Satin', 'Sheen', 'Silk', 'Velvet Matt', 'Eggshell']),
      packSize(['1 L', '4 L', '10 L', '20 L', '1 kg', '5 kg', '20 kg']),
      { key: 'baseType', label: 'Base Type', type: 'select', options: ['Water Based', 'Oil Based', 'Solvent Based', 'Enamel'], filterable: true },
      { key: 'coverage', label: 'Coverage', type: 'text', help: 'e.g. 120 sq.ft / litre per coat' },
      { key: 'coats', label: 'Recommended Coats', type: 'select', options: ['1', '2', '3'], filterable: true },
      { key: 'dryingTime', label: 'Drying Time', type: 'text', help: 'e.g. 30 minutes surface dry' },
      { key: 'baseShade', label: 'Shade', type: 'text', help: 'e.g. White, Ivory, Off White' },
    ],
    categories: [
      { name: 'Interior Emulsion', attributes: [{ key: 'washability', label: 'Washability', type: 'select', options: ['Regular', 'Washable', 'Highly Washable', 'Premium'] }], subcategories: ['Regular Emulsion', 'Premium Emulsion', 'Luxury Emulsion', 'Anti-Bacterial'] },
      { name: 'Exterior Emulsion', attributes: [{ key: 'weatherproofYears', label: 'Weather Protection', type: 'select', options: ['3 years', '5 years', '7 years', '10 years', '15 years'], filterable: true }], subcategories: ['Regular Exterior', 'Premium Exterior', 'Elastomeric', 'Dirt Resistant'] },
      { name: 'Enamel', attributes: [], subcategories: ['Gloss Enamel', 'Matt Enamel', 'Satin Enamel', 'Metal Paint'] },
      { name: 'Primers & Undercoats', attributes: [], subcategories: ['Wall Primer', 'Metal Primer', 'Wood Primer', 'Putty', 'Sealer'] },
      { name: 'Wood Finishes', attributes: [], subcategories: ['PU Polish', 'Melamine', 'Wood Stain', 'Lacquer', 'Clear Coat'] },
      { name: 'Textures & Designer', attributes: [], subcategories: ['Texture Finish', 'Metallic Finish', 'Stencil', 'Wall Stencil', 'Concrete Finish'] },
      { name: 'Waterproof Coatings', attributes: [], subcategories: ['Terrace Coat', 'Bathroom Coat', 'Damp Proof', 'Crack Filler'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Plywood & Boards',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'plywood-boards',
    showOnHome: false,
    attributes: [
      thickness(['4 mm', '6 mm', '9 mm', '12 mm', '16 mm', '18 mm', '19 mm', '25 mm']),
      brandGrade(['MR Grade', 'BWR Grade', 'BWP / Marine', 'Commercial', 'Fire Retardant', 'Calibrated']),
      { key: 'sheetSize', label: 'Sheet Size', type: 'select', options: ['8 x 4 ft', '7 x 4 ft', '8 x 3 ft', '6 x 4 ft', '6 x 3 ft'], filterable: true },
      { key: 'coreMaterial', label: 'Core Material', type: 'select', options: ['Hardwood', 'Gurjan', 'Poplar', 'Pine', 'Eucalyptus', 'Rubberwood'], filterable: true },
      { key: 'faceVeneer', label: 'Face Veneer', type: 'text', help: 'e.g. Okoume, Gurjan, Recon' },
      // Calculated from the sheet size. See utils/productCalculations.js.
      { key: 'areaPerUnit', label: 'Sq.Ft per sheet', type: 'number', unit: 'sqft', calculated: true },
      { key: 'warranty', label: 'Warranty', type: 'text' },
    ],
    categories: [
      { name: 'Plywood', attributes: [], subcategories: ['MR Plywood', 'BWR Plywood', 'BWP Marine Plywood', 'Calibrated Plywood', 'Flexible Plywood', 'Shuttering Plywood'] },
      { name: 'MDF & HDF', attributes: [], subcategories: ['Plain MDF', 'Pre-laminated MDF', 'HDF', 'Action Tesa', 'Exterior MDF'] },
      { name: 'HDHMR & Particle Board', attributes: [], subcategories: ['HDHMR', 'Particle Board', 'Pre-laminated Particle Board', 'Chipboard'] },
      { name: 'Block Board & Flush Doors', attributes: [], subcategories: ['Block Board', 'Flush Door', 'Solid Core Door', 'Pine Block Board'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Laminates & Veneers',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'laminates-veneers',
    showOnHome: false,
    attributes: [
      thickness(['0.6 mm', '0.8 mm', '1 mm', '1.2 mm', '2 mm', '6 mm', '12 mm']),
      finish(['Glossy', 'Matt', 'Suede', 'Textured', 'Woodgrain', 'Marble', 'Metallic', 'Embossed']),
      { key: 'sheetSize', label: 'Sheet Size', type: 'select', options: ['8 x 4 ft', '8 x 3 ft', '10 x 4 ft', '6 x 4 ft'], filterable: true },
      colour(['White', 'Beige', 'Brown', 'Walnut', 'Teak', 'Grey', 'Black', 'Red', 'Blue', 'Green', 'Multi']),
      { key: 'designSeries', label: 'Design Series', type: 'text', help: 'e.g. Wood, Marble, Solid, Abstract' },
      // Calculated from the sheet size. See utils/productCalculations.js.
      { key: 'areaPerUnit', label: 'Sq.Ft per sheet', type: 'number', unit: 'sqft', calculated: true },
    ],
    categories: [
      { name: 'Decorative Laminates', attributes: [brandGrade(['Standard', 'Premium', 'Luxury', 'Anti-Fingerprint', 'Anti-Bacterial'])], subcategories: ['Woodgrain', 'Marble Look', 'Solid Colour', 'Abstract', 'Metallic', 'Textured'] },
      { name: 'Compact & Exterior Laminates', attributes: [], subcategories: ['Compact Laminate', 'Exterior Grade', 'Phenolic Board'] },
      { name: 'Veneers', attributes: [], subcategories: ['Natural Veneer', 'Recon Veneer', 'Dyed Veneer', 'Burr Veneer'] },
      { name: 'Edge Banding', attributes: [], subcategories: ['PVC Edge Band', 'ABS Edge Band', 'Aluminium Edge', 'Tape'] },
      { name: 'Acrylic & PU Sheets', attributes: [], subcategories: ['Acrylic Sheet', 'PU Sheet', 'High Gloss Sheet', 'Frosted Acrylic'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Flooring',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'flooring',
    showOnHome: false,
    attributes: [
      thickness(['2 mm', '3 mm', '4 mm', '6 mm', '8 mm', '10 mm', '12 mm', '15 mm', '18 mm']),
      finish(['Glossy', 'Matt', 'Embossed', 'Hand Scraped', 'Textured', 'Anti-Scratch']),
      { key: 'plankSize', label: 'Plank Size', type: 'text', help: 'e.g. 1220 x 180 mm' },
      { key: 'installationType', label: 'Installation', type: 'select', options: ['Click Lock', 'Glue Down', 'Loose Lay', 'Nail Down', 'Floating'], filterable: true },
      { key: 'wearLayer', label: 'Wear Layer', type: 'select', options: ['0.2 mm', '0.3 mm', '0.5 mm', '0.7 mm', '1 mm', '2 mm'] },
      { key: 'acRating', label: 'AC Rating', type: 'select', options: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'], filterable: true },
    ],
    categories: [
      { name: 'Vinyl Flooring', attributes: [], subcategories: ['LVT', 'SPC', 'WPC', 'Vinyl Roll'] },
      { name: 'Laminate Flooring', attributes: [], subcategories: ['8 mm Laminate', '10 mm Laminate', '12 mm Laminate', 'Water Resistant'] },
      { name: 'Wooden & Engineered', attributes: [], subcategories: ['Engineered Wood', 'Solid Wood', 'Bamboo', 'Deck Wood'] },
      { name: 'Carpets & Rugs', attributes: [], subcategories: ['Wall to Wall Carpet', 'Carpet Tile', 'Area Rug', 'Floor Mat', 'Artificial Grass'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Doors & Windows',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'doors-windows',
    showOnHome: false,
    attributes: [
      material(['Solid Wood', 'Plywood', 'HDF', 'uPVC', 'Aluminium', 'WPC', 'Fibre', 'Steel', 'Glass']),
      finish(['Laminate', 'Veneer', 'PU Polish', 'Duco', 'Powder Coated', 'Anodised', 'Natural Wood', 'Painted']),
      { key: 'width', label: 'Width', type: 'number', unit: 'mm' },
      { key: 'height', label: 'Height', type: 'number', unit: 'mm' },
      { key: 'shutterType', label: 'Shutter Type', type: 'select', options: ['Flush', 'Panel', 'Designer', 'Glass Insert', 'Mesh', 'Sliding'], filterable: true },
      { key: 'glassType', label: 'Glass Type', type: 'select', options: ['Single Glazed', 'Double Glazed', 'Toughened', 'Frosted', 'None'], filterable: true },
      { key: 'hardwareIncluded', label: 'Hardware Included', type: 'select', options: ['Yes', 'No'], filterable: true },
      // Calculated: width x height. See utils/productCalculations.js.
      { key: 'areaPerUnit', label: 'Sq.Ft per unit', type: 'number', unit: 'sqft', calculated: true },
      warranty(),
    ],
    categories: [
      { name: 'Doors', attributes: [], subcategories: ['Flush Door', 'Panel Door', 'Designer Door', 'Glass Door', 'Sliding Door', 'Fire Door', 'PVC Door', 'WPC Door'] },
      { name: 'Windows', attributes: [], subcategories: ['uPVC Window', 'Aluminium Window', 'Sliding Window', 'Casement Window', 'Tilt & Turn', 'Fixed Window', 'Ventilator'] },
      { name: 'Frames & Architraves', attributes: [], subcategories: ['Wooden Frame', 'uPVC Frame', 'Aluminium Frame', 'Chowkhat', 'Architrave'] },
      { name: 'Screens & Partitions', attributes: [], subcategories: ['Mosquito Net', 'Insect Screen', 'Glass Partition', 'Acoustic Panel'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Hardware',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'hardware',
    showOnHome: false,
    attributes: [
      material(['Stainless Steel 304', 'Stainless Steel 202', 'Brass', 'Zinc Alloy', 'Mild Steel', 'Aluminium', 'Nylon']),
      finish(['SS Finish', 'Chrome', 'Matte Black', 'Antique Brass', 'Gold', 'PVD', 'Powder Coated', 'Zinc Plated']),
      size(['2 inch', '3 inch', '4 inch', '5 inch', '6 inch', '8 inch', '10 inch', '12 inch', '18 inch']),
      { key: 'loadRating', label: 'Load Rating', type: 'select', options: ['10 kg', '20 kg', '30 kg', '45 kg', '60 kg', '80 kg', '100 kg'], filterable: true },
      { key: 'packOf', label: 'Pack Of', type: 'number' },
      warranty(),
    ],
    categories: [
      { name: 'Hinges', attributes: [{ key: 'hingeType', label: 'Type', type: 'select', options: ['Auto Close', 'Hydraulic', 'Butt', 'Concealed', 'Piano', 'Weld On', 'Spring'], filterable: true }], subcategories: ['Hydraulic Hinge', 'Butt Hinge', 'Concealed Hinge', 'Piano Hinge', 'Glass Hinge', 'Weld Hinge'] },
      { name: 'Channels & Slides', attributes: [{ key: 'slideType', label: 'Type', type: 'select', options: ['Ball Bearing', 'Telescopic', 'Soft Close', 'Push to Open', 'Tandem Box'], filterable: true }], subcategories: ['Drawer Channel', 'Soft Close Channel', 'Tandem Box', 'Pivot Slide'] },
      { name: 'Locks & Handles', attributes: [{ key: 'lockType', label: 'Type', type: 'select', options: ['Mortise', 'Cylindrical', 'Cam Lock', 'Multipurpose', 'Padlock', 'Deadbolt'], filterable: true }], subcategories: ['Mortise Lock', 'Cylindrical Lock', 'Cam Lock', 'Door Handle', 'Pull Handle', 'Cabinet Handle', 'Knob', 'Tower Bolt'] },
      { name: 'Glass Hardware', attributes: [], subcategories: ['Patch Fitting', 'Spider Fitting', 'Glass Door Lock', 'Floor Spring', 'Glass Clamp', 'Shower Hinge'] },
      { name: 'Kitchen & Wardrobe Hardware', attributes: [], subcategories: ['Basket', 'Cutlery Tray', 'Corner Unit', 'Wicker Basket', 'Tall Unit', 'Gas Lift', 'Wardrobe Rod'] },
      { name: 'Fasteners & Tools', attributes: [], subcategories: ['Screw', 'Anchor Fastener', 'Nail', 'Bolt & Nut', 'Wall Plug', 'Hand Tool', 'Power Tool'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Modular Kitchen',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'modular-kitchen',
    showOnHome: false,
    attributes: [
      material(['Plywood + Laminate', 'HDF + Acrylic', 'Marine Ply + PU', 'Particle Board + Laminate', 'Stainless Steel', 'Aluminium', 'Solid Wood']),
      finish(['Laminate', 'Acrylic', 'PU', 'Veneer', 'Textured', 'High Gloss']),
      { key: 'layout', label: 'Layout', type: 'select', options: ['L-Shape', 'U-Shape', 'Parallel', 'Straight', 'Island', 'Peninsula'], filterable: true },
      { key: 'size', label: 'Size', type: 'text', help: 'e.g. 8 ft x 6 ft' },
      warranty(),
    ],
    categories: [
      { name: 'Kitchen Cabinets', attributes: [{ key: 'cabinetType', label: 'Cabinet Type', type: 'select', options: ['Base Unit', 'Wall Unit', 'Tall Unit', 'Corner Unit', 'Drawer Unit'], filterable: true }], subcategories: ['Base Unit', 'Wall Unit', 'Tall Unit', 'Corner Unit', 'Drawer Unit', 'Open Shelf'] },
      { name: 'Kitchen Sinks', attributes: [{ key: 'sinkType', label: 'Type', type: 'select', options: ['Single Bowl', 'Double Bowl', 'Single Bowl with Drain Board', 'Double Bowl with Drain Board'], filterable: true }], subcategories: ['Stainless Steel Sink', 'Quartz Sink', 'Granite Sink', 'Handmade Sink', 'Drain Board'] },
      { name: 'Chimneys', attributes: [{ key: 'suctionCapacity', label: 'Suction', type: 'select', options: ['600 m³/hr', '900 m³/hr', '1200 m³/hr', '1500 m³/hr', '1800 m³/hr'], filterable: true }, { key: 'chimneyType', label: 'Type', type: 'select', options: ['Auto Clean', 'Filterless', 'Baffle', 'Cassette', 'Wall Mounted', 'Island'], filterable: true }], subcategories: ['Auto Clean Chimney', 'Baffle Filter Chimney', 'Filterless Chimney', 'Island Chimney'] },
      { name: 'Hobs & Cooktops', attributes: [{ key: 'burners', label: 'Burners', type: 'select', options: ['2 Burner', '3 Burner', '4 Burner', '5 Burner'], filterable: true }, { key: 'hobType', label: 'Type', type: 'select', options: ['Glass Top', 'Stainless Steel', 'Induction', 'Hybrid', 'Built-in'], filterable: true }], subcategories: ['Gas Hob', 'Induction Cooktop', 'Built-in Hob', 'Hob & Chimney Combo'] },
      { name: 'Kitchen Organisers', attributes: [], subcategories: ['Cutlery Tray', 'Bottle Pull Out', 'Corner Carousel', 'Detergent Unit', 'Spice Rack', 'Plate Rack', 'Waste Bin'] },
      { name: 'Kitchen Faucets', attributes: [], subcategories: ['Sink Mixer', 'Pull Out Faucet', 'Sensor Faucet', 'Wall Mounted Faucet'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Furniture',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'furniture',
    showOnHome: false,
    attributes: [
      material(['Solid Wood', 'Sheesham', 'Teak', 'Plywood', 'MDF', 'Engineered Wood', 'Metal', 'Glass', 'Rattan']),
      finish(['Laminate', 'Veneer', 'PU Polish', 'Duco', 'Powder Coated', 'Natural Wood', 'Fabric', 'Leatherette']),
      { key: 'dimensions', label: 'Dimensions', type: 'text', help: 'e.g. 1800 x 900 x 750 mm (L x W x H)' },
      { key: 'assemblyRequired', label: 'Assembly Required', type: 'select', options: ['No', 'Yes - Minimal', 'Yes - Full'], filterable: true },
      warranty(),
    ],
    categories: [
      { name: 'Beds & Mattresses', attributes: [{ key: 'bedSize', label: 'Bed Size', type: 'select', options: ['Single', 'Double', 'Queen', 'King', 'Custom'], filterable: true }], subcategories: ['Single Bed', 'Double Bed', 'Queen Bed', 'King Bed', 'Bunk Bed', 'Sofa Cum Bed', 'Mattress', 'Headboard'] },
      { name: 'Wardrobes & Storage', attributes: [], subcategories: ['2 Door Wardrobe', '3 Door Wardrobe', 'Sliding Wardrobe', 'Walk-in Wardrobe', 'Chest of Drawers', 'Storage Cabinet'] },
      { name: 'Sofas & Seating', attributes: [{ key: 'seatingCapacity', label: 'Seating', type: 'select', options: ['1 Seater', '2 Seater', '3 Seater', '4 Seater', '5+ Seater'], filterable: true }], subcategories: ['Sofa Set', 'L-Shape Sofa', 'Recliner', 'Sofa Cum Bed', 'Arm Chair', 'Ottoman', 'Bean Bag'] },
      { name: 'Dining & Tables', attributes: [], subcategories: ['Dining Table', 'Coffee Table', 'Study Table', 'Centre Table', 'Side Table', 'Console Table', 'Bar Stool'] },
      { name: 'Office Furniture', attributes: [], subcategories: ['Office Chair', 'Workstation', 'Conference Table', 'Filing Cabinet', 'Reception Desk'] },
      { name: 'Outdoor Furniture', attributes: [], subcategories: ['Garden Chair', 'Swing', 'Patio Set', 'Hammock', 'Outdoor Table'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Home Decor',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'home-decor',
    showOnHome: false,
    attributes: [
      material(['Wood', 'Metal', 'Ceramic', 'Glass', 'Marble', 'Concrete', 'Fabric', 'Resin', 'Rattan']),
      colour(['White', 'Black', 'Gold', 'Silver', 'Beige', 'Brown', 'Grey', 'Multicolour']),
      { key: 'size', label: 'Size', type: 'text', help: 'e.g. 12 inch, 60 x 90 cm' },
      { key: 'style', label: 'Style', type: 'select', options: ['Modern', 'Traditional', 'Minimal', 'Bohemian', 'Industrial', 'Rustic', 'Contemporary'], filterable: true },
    ],
    categories: [
      { name: 'Wall Decor & Art', attributes: [], subcategories: ['Wall Art', 'Canvas Painting', 'Wall Plate', 'Wall Shelf', 'Photo Frame', 'Wall Sticker'] },
      { name: 'Mirrors', attributes: [], subcategories: ['Decorative Mirror', 'Full Length Mirror', 'Round Mirror', 'Wall Mirror', 'LED Mirror'] },
      { name: 'Vases & Planters', attributes: [], subcategories: ['Flower Vase', 'Indoor Planter', 'Outdoor Planter', 'Hanging Planter', 'Pot Stand'] },
      { name: 'Rugs & Carpets', attributes: [], subcategories: ['Area Rug', 'Runner', 'Doormat', 'Dhurrie', 'Shag Rug'] },
      { name: 'Clocks & Lighting Decor', attributes: [], subcategories: ['Wall Clock', 'Table Clock', 'Lantern', 'Candle Holder', 'Fairy Light', 'Diya'] },
      { name: 'Wallpaper & Panels', attributes: [], subcategories: ['Wallpaper', '3D Wall Panel', 'WPC Louver', 'Wall Moulding'] },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Outdoor & Landscaping',
    // Stable machine name — see models/Category.js. Never rename this.
    systemKey: 'outdoor-landscaping',
    showOnHome: false,
    attributes: [
      material(['Concrete', 'Natural Stone', 'Ceramic', 'Clay', 'HDPE', 'FRP', 'Metal', 'WPC', 'Fibre Cement']),
      finish(['Natural', 'Polished', 'Shot Blast', 'Coloured', 'Textured', 'Anti-Skid']),
      size(['200x100 mm', '300x300 mm', '400x400 mm', '600x600 mm', '300x600 mm', '600x300 mm']),
      { key: 'loadBearing', label: 'Load Bearing', type: 'select', options: ['Light Traffic', 'Medium Traffic', 'Heavy Traffic', 'Vehicular'], filterable: true },
      { key: 'weatherResistant', label: 'Weather Resistant', type: 'select', options: ['Yes', 'No'], filterable: true },
    ],
    categories: [
      { name: 'Pavers & Kerb Stones', attributes: [], subcategories: ['Concrete Paver', 'Interlocking Paver', 'Cobble Stone', 'Kerb Stone', 'Grass Paver'] },
      { name: 'Garden & Landscape', attributes: [], subcategories: ['Stepping Stone', 'Garden Edging', 'Mulch', 'Garden Soil', 'Pebbles & Gravel'] },
      { name: 'Planters & Pots', attributes: [{ key: 'capacity', label: 'Capacity', type: 'text', help: 'e.g. 10 inch, 20 L' }], subcategories: ['Large Planter', 'Hanging Pot', 'Vertical Garden', 'Tree Guard', 'Pot Stand'] },
      { name: 'Outdoor Lighting', attributes: [], subcategories: ['Bollard Light', 'Garden Spike Light', 'Path Light', 'Wall Washer', 'Underwater Light'] },
      { name: 'Fencing & Screens', attributes: [], subcategories: ['WPC Fence', 'Metal Fence', 'Bamboo Screen', 'Privacy Screen', 'Gate'] },
      { name: 'Artificial Grass & Turf', attributes: [], subcategories: ['Artificial Grass', 'Artificial Hedge', 'Sports Turf', 'Grass Tile'] },
    ],
  },
];

export default VERTICAL_TAXONOMY;
