/**
 * BDMTILES — Complete Module Test Script
 * Tests CREATE (POST) on every module using real API calls.
 * Run: node scripts/testAllModules.js
 *
 * Requires backend running on PORT 5000 and a super_admin user.
 */

import dotenv from 'dotenv';
dotenv.config();

const BASE = `http://localhost:${process.env.PORT || 5000}/api/v1`;

// ─── ANSI Colors ─────────────────────────────────────────────────────────────
const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  gray:   (s) => `\x1b[90m${s}\x1b[0m`,
};

// ─── State ────────────────────────────────────────────────────────────────────
let TOKEN = '';
const IDS = {};           // stores created IDs for cross-module references
const results = [];       // { module, status, message, id? }
const ts = () => new Date().toLocaleTimeString('en-IN');

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
async function api(method, path, body = null, auth = true) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (auth && TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

// ─── Test runner ──────────────────────────────────────────────────────────────
async function test(module, fn) {
  try {
    const result = await fn();
    const ok = result?.success;
    const id = result?.data?._id || result?.data?.id;
    results.push({ module, status: ok ? 'PASS' : 'FAIL', message: result?.message || '', id });
    const icon = ok ? C.green('✅ PASS') : C.red('❌ FAIL');
    const idStr = id ? C.gray(` [${id}]`) : '';
    console.log(`  ${icon}  ${C.bold(module.padEnd(38))} ${(result?.message || '').slice(0, 60)}${idStr}`);
    return result;
  } catch (err) {
    results.push({ module, status: 'ERROR', message: err.message });
    console.log(`  ${C.red('💥 ERR ')}  ${C.bold(module.padEnd(38))} ${err.message.slice(0, 80)}`);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('\n' + C.bold(C.cyan('════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  BDMTILES — Complete Module Test')));
  console.log(C.bold(C.cyan(`  ${ts()}  |  ${BASE}`)));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════\n')));

  // ─── 0. Health Check ────────────────────────────────────────────────────────
  console.log(C.bold('[ 0 ] HEALTH CHECK'));
  const health = await test('GET /health', async () => {
    const r = await api('GET', '/health', null, false);
    return r.data;
  });

  // ─── 1. Auth ────────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 1 ] AUTH'));
  const loginRes = await test('POST /auth/login (super_admin)', async () => {
    const r = await api('POST', '/auth/login', {
      email: 'superadmin@bdmtiles.com',
      password: 'superadmin123',
    }, false);
    if (r.data?.token) TOKEN = r.data.token;
    return r.data;
  });

  if (!TOKEN) {
    console.log(C.red('\n⛔  Login failed — cannot continue. Is the backend running? Is super_admin seeded?'));
    console.log(C.yellow('   Run: npm run create-admin  (in BDMTILES Backend/)'));
    printSummary();
    return;
  }

  await test('GET /auth/me', async () => {
    const r = await api('GET', '/auth/me');
    return r.data;
  });

  // ─── 2. User Management ─────────────────────────────────────────────────────
  console.log(C.bold('\n[ 2 ] USER MANAGEMENT'));
  const userRes = await test('GET /users (list)', async () => {
    const r = await api('GET', '/users?limit=5');
    return r.data;
  });

  const newUserRes = await test('POST /users (create sales_executive)', async () => {
    const r = await api('POST', '/users', {
      name: 'Test Sales Exec',
      username: `testse_${Date.now()}`,
      email: `testse_${Date.now()}@bdmtiles.com`,
      phone: '9876543210',
      role: 'sales_executive',
      password: 'test1234',
      status: 'Active',
      permissions: ['dashboard.view', 'product.master', 'dealer.master', 'sales.order.create'],
    });
    if (r.data?.data?._id) IDS.user = r.data.data._id;
    return r.data;
  });

  // ─── 3. Category Setup ──────────────────────────────────────────────────────
  console.log(C.bold('\n[ 3 ] CATEGORY SETUP'));
  const brandRes = await test('POST /category-setup/brands', async () => {
    const r = await api('POST', '/category-setup/brands', { name: `TestBrand_${Date.now()}`, status: 'Active' });
    if (r.data?.data?._id) IDS.brand = r.data.data._id;
    return r.data;
  });

  const catRes = await test('POST /category-setup/brands/:id/categories', async () => {
    if (!IDS.brand) return { success: false, message: 'No brand ID — skipped' };
    const r = await api('POST', `/category-setup/brands/${IDS.brand}/categories`, {
      name: `TestCategory_${Date.now()}`, status: 'Active'
    });
    if (r.data?.data?._id) IDS.category = r.data.data._id;
    return r.data;
  });

  const subCatRes = await test('POST /category-setup/brands/:id/categories/:id/subcategories', async () => {
    if (!IDS.brand || !IDS.category) return { success: false, message: 'No brand/category ID — skipped' };
    const r = await api('POST', `/category-setup/brands/${IDS.brand}/categories/${IDS.category}/subcategories`, {
      name: `TestSubcat_${Date.now()}`, status: 'Active'
    });
    if (r.data?.data?._id) IDS.subcategory = r.data.data._id;
    return r.data;
  });

  // ─── 4. Masters ─────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 4 ] MASTERS'));

  await test('POST /masters/dealer-types', async () => {
    const r = await api('POST', '/masters/dealer-types', { name: `DType_${Date.now()}`, status: 'active' });
    if (r.data?.data?._id) IDS.dealerType = r.data.data._id;
    return r.data;
  });

  await test('POST /masters/dealer-categories', async () => {
    const r = await api('POST', '/masters/dealer-categories', { name: `DCat_${Date.now()}`, status: 'active' });
    if (r.data?.data?._id) IDS.dealerCategory = r.data.data._id;
    return r.data;
  });

  await test('POST /masters/regions', async () => {
    const r = await api('POST', '/masters/regions', { name: `Region_${Date.now()}` });
    if (r.data?.data?._id) IDS.region = r.data.data._id;
    return r.data;
  });

  await test('POST /masters/expense-categories', async () => {
    const r = await api('POST', '/masters/expense-categories', { name: `ExpCat_${Date.now()}` });
    return r.data;
  });

  await test('POST /masters/warehouses', async () => {
    const r = await api('POST', '/masters/warehouses', {
      name: `TestWarehouse_${Date.now()}`,
      type: 'main',
      address: '123 Industrial Area',
      city: 'Bengaluru',
      state: 'Karnataka',
      managerName: 'Suresh Kumar',
      managerPhone: '9876543210',
      capacity: '5000 sqft',
    });
    if (r.data?.data?._id) IDS.warehouse = r.data.data._id;
    return r.data;
  });

  await test('POST /masters/routes', async () => {
    const r = await api('POST', '/masters/routes', {
      name: `Route_${Date.now()}`,
      visitFrequency: 'weekly',
      dayOfWeek: 'monday',
      citiesCovered: ['Bengaluru', 'Mysuru'],
    });
    if (r.data?.data?._id) IDS.route = r.data.data._id;
    return r.data;
  });

  await test('POST /masters/dealers', async () => {
    const r = await api('POST', '/masters/dealers', {
      businessName: `Test Tiles Shop_${Date.now()}`,
      ownerName: 'Rajesh Kumar',
      mobile: '9900112233',
      gstin: 'TESTGSTIN1234567',
      creditLimit: 100000,
      creditDays: 30,
      city: 'Bengaluru',
      state: 'Karnataka',
      dealerType: IDS.dealerType,
      assignedRegion: IDS.region,
    });
    if (r.data?.data?._id) IDS.dealer = r.data.data._id;
    return r.data;
  });

  await test('POST /masters/suppliers', async () => {
    const r = await api('POST', '/masters/suppliers', {
      companyName: `Test Supplier Pvt Ltd_${Date.now()}`,
      contactPerson: 'Amit Sharma',
      mobile: '9911223344',
      gstin: 'SUPGSTIN1234567',
      city: 'Ahmedabad',
      state: 'Gujarat',
    });
    if (r.data?.data?._id) IDS.supplier = r.data.data._id;
    return r.data;
  });

  await test('POST /masters/vehicles', async () => {
    const r = await api('POST', '/masters/vehicles', {
      vehicleNumber: `KA01AB${Date.now().toString().slice(-4)}`,
      vehicleType: 'truck',
      capacity: '5 Ton',
    });
    return r.data;
  });

  // ─── 5. Products ────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 5 ] PRODUCTS'));
  const prodRes = await test('POST /products', async () => {
    if (!IDS.brand || !IDS.category || !IDS.subcategory) {
      return { success: false, message: 'Missing category IDs — skipped' };
    }
    const r = await api('POST', '/products', {
      itemName: `Ivory Glossy Floor Tile_${Date.now()}`,
      productCode: `TILE${Date.now().toString().slice(-6)}`,
      brand: IDS.brand,
      category: IDS.category,
      subcategory: IDS.subcategory,
      hsnCode: '6908',
      gst: 18,
      tileSize: '600x600mm',
      thickness: '9mm',
      finish: 'Glossy',
      grade: 'A',
      unit: 'Box',
      piecesPerBox: 4,
      sqftPerBox: 15.6,
      purchaseRate: 450,
      dealerRate: 600,
      mrp: 750,
      minimumSellingRate: 550,
      status: 'active',
    });
    if (r.data?.data?._id) IDS.product = r.data.data._id;
    return r.data;
  });

  await test('GET /products (list + search)', async () => {
    const r = await api('GET', '/products?limit=5&search=Tile');
    return r.data;
  });

  // ─── 6. Sales Orders ────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 6 ] SALES ORDERS'));
  await test('GET /sales-orders/stats', async () => {
    const r = await api('GET', '/sales-orders/stats');
    return r.data;
  });

  const soRes = await test('POST /sales-orders', async () => {
    if (!IDS.dealer || !IDS.product) return { success: false, message: 'Need dealer + product — skipped' };
    const r = await api('POST', '/sales-orders', {
      dealer: IDS.dealer,
      dealerName: 'Test Tiles Shop',
      orderType: 'dealer',
      items: [{
        product: IDS.product,
        productName: 'Ivory Glossy Floor Tile',
        shade: 'Shade-A',
        batch: 'Batch-2024-01',
        quantity: 10,
        unit: 'Box',
        rate: 600,
        discount: 0,
        gstPercentage: 18,
        warehouse: IDS.warehouse,
      }],
      deliveryAddress: 'Bengaluru, Karnataka',
      remarks: 'Test order from test script',
    });
    if (r.data?.data?._id) IDS.salesOrder = r.data.data._id;
    return r.data;
  });

  await test('GET /sales-orders (list)', async () => {
    const r = await api('GET', '/sales-orders?limit=5');
    return r.data;
  });

  // ─── 7. Purchase Orders ─────────────────────────────────────────────────────
  console.log(C.bold('\n[ 7 ] PURCHASE ORDERS'));
  const poRes = await test('POST /purchase/purchase-orders', async () => {
    if (!IDS.supplier || !IDS.product) return { success: false, message: 'Need supplier + product — skipped' };
    const r = await api('POST', '/purchase/purchase-orders', {
      supplier: IDS.supplier,
      items: [{
        product: IDS.product,
        productName: 'Ivory Glossy Floor Tile',
        quantity: 100,
        rate: 450,
        gstPercentage: 18,
      }],
      expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      remarks: 'Test PO from script',
    });
    if (r.data?.data?._id) IDS.po = r.data.data._id;
    return r.data;
  });

  await test('GET /purchase/purchase-orders', async () => {
    const r = await api('GET', '/purchase/purchase-orders?limit=5');
    return r.data;
  });

  // ─── 8. GRN ─────────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 8 ] GRN (Goods Receipt)'));
  const grnRes = await test('POST /purchase/grn', async () => {
    if (!IDS.supplier || !IDS.product || !IDS.warehouse) return { success: false, message: 'Missing IDs — skipped' };
    const r = await api('POST', '/purchase/grn', {
      purchaseOrder: IDS.po,
      supplier: IDS.supplier,
      supplierInvoiceNo: 'SI-TEST-001',
      vehicleNo: 'KA01AB1234',
      items: [{
        product: IDS.product,
        productName: 'Ivory Glossy Floor Tile',
        orderedQty: 100,
        receivedQty: 100,
        acceptedQty: 98,
        damagedQty: 2,
        shade: 'Shade-A',
        batch: 'Batch-2024-01',
        qualityStatus: 'accepted',
        warehouse: IDS.warehouse,
        rate: 450,
      }],
      status: 'verified',
    });
    if (r.data?.data?._id) IDS.grn = r.data.data._id;
    return r.data;
  });

  // ─── 9. Stock ───────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 9 ] STOCK'));
  await test('GET /purchase/stock (list)', async () => {
    const r = await api('GET', '/purchase/stock?limit=10');
    return r.data;
  });

  await test('GET /purchase/stock/summary', async () => {
    const r = await api('GET', '/purchase/stock/summary');
    return r.data;
  });

  // ─── 10. Payments ───────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 10 ] PAYMENTS'));
  await test('POST /payments (dealer receipt)', async () => {
    if (!IDS.dealer) return { success: false, message: 'No dealer ID — skipped' };
    const r = await api('POST', '/payments', {
      paymentType: 'dealer_receipt',
      dealer: IDS.dealer,
      partyName: 'Test Tiles Shop',
      amount: 10000,
      paymentMode: 'upi',
      transactionRef: `UPI${Date.now()}`,
      remarks: 'Test payment from script',
    });
    if (r.data?.data?._id) IDS.payment = r.data.data._id;
    return r.data;
  });

  await test('POST /payments (supplier payment)', async () => {
    if (!IDS.supplier) return { success: false, message: 'No supplier ID — skipped' };
    const r = await api('POST', '/payments', {
      paymentType: 'supplier_payment',
      supplier: IDS.supplier,
      partyName: 'Test Supplier Pvt Ltd',
      amount: 50000,
      paymentMode: 'neft',
      transactionRef: `NEFT${Date.now()}`,
    });
    return r.data;
  });

  // ─── 11. Dealer Pricing ─────────────────────────────────────────────────────
  console.log(C.bold('\n[ 11 ] DEALER PRICING'));
  await test('GET /dealer-pricing (list overrides)', async () => {
    const r = await api('GET', '/dealer-pricing?limit=5');
    return r.data;
  });

  // ─── 12. Quotations ─────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 12 ] QUOTATIONS'));
  await test('POST /quotations', async () => {
    if (!IDS.product) return { success: false, message: 'No product — skipped' };
    const r = await api('POST', '/quotations', {
      dealer: IDS.dealer,
      dealerName: 'Test Tiles Shop',
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      items: [{
        product: IDS.product,
        productName: 'Ivory Glossy Floor Tile',
        quantity: 50,
        rate: 580,
        gstPercentage: 18,
      }],
      remarks: 'Test quotation',
    });
    if (r.data?.data?._id) IDS.quotation = r.data.data._id;
    return r.data;
  });

  // ─── 13. HRMS — Employee ────────────────────────────────────────────────────
  console.log(C.bold('\n[ 13 ] HRMS — EMPLOYEE'));
  const empRes = await test('POST /hrms/employees', async () => {
    const r = await api('POST', '/hrms/employees', {
      name: `Test Employee_${Date.now()}`,
      designation: 'Sales Executive',
      department: 'Sales',
      dateOfJoining: new Date('2024-01-15'),
      mobile: '9812345678',
      employmentType: 'Full Time',
      salaryType: 'Monthly',
      basicSalary: 25000,
      hra: 5000,
      pf: 1800,
      attendanceType: 'GPS',
    });
    if (r.data?.data?._id) IDS.employee = r.data.data._id;
    return r.data;
  });

  // ─── 14. Attendance ─────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 14 ] HRMS — ATTENDANCE'));
  await test('POST /hrms/attendance/mark', async () => {
    if (!IDS.employee) return { success: false, message: 'No employee — skipped' };
    const r = await api('POST', '/hrms/attendance/mark', {
      employee: IDS.employee,
      date: new Date().toISOString().slice(0, 10),
      status: 'Present',
      remarks: 'Marked by test script',
    });
    return r.data;
  });

  await test('GET /hrms/attendance (list)', async () => {
    const r = await api('GET', '/hrms/attendance?limit=5');
    return r.data;
  });

  // ─── 15. Leave ──────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 15 ] HRMS — LEAVE'));
  await test('POST /hrms/leaves', async () => {
    if (!IDS.employee) return { success: false, message: 'No employee — skipped' };
    const r = await api('POST', '/hrms/leaves', {
      employee: IDS.employee,
      leaveType: 'Casual',
      fromDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      toDate: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      days: 2,
      reason: 'Personal work',
    });
    return r.data;
  });

  // ─── 16. Salary ─────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 16 ] HRMS — SALARY'));
  await test('GET /hrms/salary-slips (list)', async () => {
    const r = await api('GET', '/hrms/salary-slips?limit=5');
    return r.data;
  });

  // ─── 17. Loans ──────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 17 ] HRMS — LOANS'));
  await test('POST /hrms/loans', async () => {
    if (!IDS.employee) return { success: false, message: 'No employee — skipped' };
    const r = await api('POST', '/hrms/loans', {
      employee: IDS.employee,
      type: 'Advance',
      amount: 10000,
      emiAmount: 2000,
      totalInstallments: 5,
      reason: 'Test advance from script',
    });
    return r.data;
  });

  // ─── 18. HRMS Settings ──────────────────────────────────────────────────────
  console.log(C.bold('\n[ 18 ] HRMS — SETTINGS'));
  await test('GET /hrms/settings', async () => {
    const r = await api('GET', '/hrms/settings');
    return r.data;
  });

  // ─── 19. Finance — Ledger ───────────────────────────────────────────────────
  console.log(C.bold('\n[ 19 ] FINANCE — LEDGER'));
  await test('GET /ledger/dealers (outstanding list)', async () => {
    const r = await api('GET', '/ledger/dealers?limit=5');
    return r.data;
  });

  if (IDS.dealer) {
    await test(`GET /ledger/dealer/:id`, async () => {
      const r = await api('GET', `/ledger/dealer/${IDS.dealer}?limit=5`);
      return r.data;
    });
  }

  // ─── 20. Cheques ────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 20 ] FINANCE — CHEQUES'));
  await test('POST /cheques', async () => {
    const r = await api('POST', '/cheques', {
      chequeNumber: `CHQ${Date.now().toString().slice(-6)}`,
      chequeDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      amount: 25000,
      bankName: 'HDFC Bank',
      branchName: 'MG Road Branch',
      chequeType: 'received',
      dealer: IDS.dealer,
      partyName: 'Test Tiles Shop',
    });
    if (r.data?.data?._id) IDS.cheque = r.data.data._id;
    return r.data;
  });

  // ─── 21. Vouchers ───────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 21 ] FINANCE — VOUCHERS'));
  await test('POST /vouchers (receipt)', async () => {
    const r = await api('POST', '/vouchers', {
      voucherType: 'receipt',
      voucherDate: new Date(),
      narration: 'Test receipt voucher',
      totalAmount: 10000,
      paymentMode: 'cash',
      entries: [
        { accountName: 'Cash', accountType: 'cash', debit: 10000, credit: 0 },
        { accountName: 'Test Tiles Shop', accountType: 'dealer', debit: 0, credit: 10000 },
      ],
    });
    return r.data;
  });

  await test('GET /vouchers (list)', async () => {
    const r = await api('GET', '/vouchers?limit=5');
    return r.data;
  });

  // ─── 22. Expenses ───────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 22 ] EXPENSES'));
  await test('POST /expenses', async () => {
    const r = await api('POST', '/expenses', {
      expenseDate: new Date(),
      description: 'Office stationery purchase',
      amount: 1500,
      paymentMode: 'cash',
      employee: IDS.employee,
      status: 'draft',
    });
    return r.data;
  });

  // ─── 23. Supplier Invoice ───────────────────────────────────────────────────
  console.log(C.bold('\n[ 23 ] SUPPLIER INVOICE'));
  await test('POST /supplier-invoices', async () => {
    if (!IDS.supplier) return { success: false, message: 'No supplier — skipped' };
    const r = await api('POST', '/supplier-invoices', {
      supplier: IDS.supplier,
      invoiceNumber: `SI${Date.now()}`,
      invoiceDate: new Date(),
      amount: 55000,
      gstAmount: 9900,
      totalAmount: 64900,
      purchaseOrder: IDS.po,
      grn: IDS.grn,
      status: 'pending',
    });
    return r.data;
  });

  // ─── 24. Purchase Return ────────────────────────────────────────────────────
  console.log(C.bold('\n[ 24 ] PURCHASE RETURN'));
  await test('POST /purchase-returns', async () => {
    if (!IDS.supplier || !IDS.product) return { success: false, message: 'Missing IDs — skipped' };
    const r = await api('POST', '/purchase-returns', {
      supplier: IDS.supplier,
      supplierName: 'Test Supplier Pvt Ltd',
      purchaseOrder: IDS.po,
      grn: IDS.grn,
      items: [{
        product: IDS.product,
        productName: 'Ivory Glossy Floor Tile',
        returnQty: 2,
        reason: 'damaged_on_receipt',
        rate: 450,
      }],
      remarks: 'Returning damaged goods',
    });
    return r.data;
  });

  // ─── 25. Sales Return ───────────────────────────────────────────────────────
  console.log(C.bold('\n[ 25 ] SALES RETURN'));
  await test('POST /sales-returns', async () => {
    if (!IDS.dealer || !IDS.product) return { success: false, message: 'Missing IDs — skipped' };
    const r = await api('POST', '/sales-returns', {
      dealer: IDS.dealer,
      dealerName: 'Test Tiles Shop',
      salesOrder: IDS.salesOrder,
      items: [{
        product: IDS.product,
        productName: 'Ivory Glossy Floor Tile',
        returnQty: 1,
        reason: 'damaged',
        rate: 600,
      }],
      remarks: 'Test sales return',
    });
    return r.data;
  });

  // ─── 26. Dispatch ───────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 26 ] DISPATCH'));
  await test('POST /dispatch', async () => {
    const r = await api('POST', '/dispatch', {
      dispatchDate: new Date(),
      vehicle: 'KA01AB1234',
      driverName: 'Raju Driver',
      driverPhone: '9988776655',
      route: IDS.route,
      warehouse: IDS.warehouse,
      orders: IDS.salesOrder ? [{
        salesOrder: IDS.salesOrder,
        orderNumber: 'SO-00001',
        dealerName: 'Test Tiles Shop',
        deliveryAddress: 'Bengaluru',
        items: [{ productName: 'Ivory Glossy Floor Tile', quantity: 10, unit: 'Box' }],
      }] : [],
      status: 'planned',
    });
    if (r.data?.data?._id) IDS.dispatch = r.data.data._id;
    return r.data;
  });

  // ─── 27. CRM — Leads ────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 27 ] CRM — LEADS'));
  await test('POST /leads', async () => {
    const r = await api('POST', '/leads', {
      name: `Test Lead_${Date.now()}`,
      phone: '9911001122',
      businessName: 'New Tiles World',
      city: 'Mysuru',
      source: 'cold_call',
      interestedIn: ['Floor Tiles', 'Wall Tiles'],
      estimatedValue: 500000,
      priority: 'high',
    });
    if (r.data?.data?._id) IDS.lead = r.data.data._id;
    return r.data;
  });

  await test('GET /leads (list)', async () => {
    const r = await api('GET', '/leads?limit=5');
    return r.data;
  });

  // ─── 28. Complaints ─────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 28 ] COMPLAINTS'));
  await test('POST /complaints', async () => {
    const r = await api('POST', '/complaints', {
      dealer: IDS.dealer,
      dealerName: 'Test Tiles Shop',
      salesOrder: IDS.salesOrder,
      category: 'damaged_goods',
      description: 'Tiles received with cracks on 3 boxes',
      priority: 'high',
    });
    if (r.data?.data?._id) IDS.complaint = r.data.data._id;
    return r.data;
  });

  // ─── 29. Approvals ──────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 29 ] APPROVALS'));
  await test('POST /approvals', async () => {
    const r = await api('POST', '/approvals', {
      type: 'rate_override',
      title: 'Rate below minimum selling price',
      description: 'SE requesting rate below MSP for bulk order',
      referenceModel: 'SalesOrder',
      referenceId: IDS.salesOrder,
      requestedValue: 500,
      currentValue: 550,
      reason: 'Bulk order — 500 boxes',
      priority: 'urgent',
    });
    return r.data;
  });

  await test('GET /approvals (pending)', async () => {
    const r = await api('GET', '/approvals?status=pending');
    return r.data;
  });

  // ─── 30. Purchase Requisition ───────────────────────────────────────────────
  console.log(C.bold('\n[ 30 ] PURCHASE REQUISITION'));
  await test('POST /purchase-requisitions', async () => {
    if (!IDS.product) return { success: false, message: 'No product — skipped' };
    const r = await api('POST', '/purchase-requisitions', {
      items: [{
        product: IDS.product,
        productName: 'Ivory Glossy Floor Tile',
        requiredQty: 200,
        unit: 'Box',
        remarks: 'Low stock',
      }],
      priority: 'high',
      requiredByDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      remarks: 'Urgent restock needed',
    });
    return r.data;
  });

  // ─── 31. Schemes ────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 31 ] SCHEMES'));
  await test('POST /schemes/supplier', async () => {
    if (!IDS.supplier) return { success: false, message: 'No supplier — skipped' };
    const r = await api('POST', '/schemes/supplier', {
      schemeName: `Test Supplier Scheme_${Date.now()}`,
      supplier: IDS.supplier,
      schemeType: 'quantity_discount',
      startDate: new Date(),
      endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      products: IDS.product ? [{
        product: IDS.product,
        targetQty: 500,
        incentiveRate: 5,
        incentiveType: 'percentage',
      }] : [],
    });
    return r.data;
  });

  await test('POST /schemes/dealer', async () => {
    const r = await api('POST', '/schemes/dealer', {
      schemeName: `Test Dealer Scheme_${Date.now()}`,
      schemeType: 'slab_discount',
      applicableTo: 'all',
      startDate: new Date(),
      endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      slabs: [
        { minValue: 50000, maxValue: 100000, discountPercent: 3 },
        { minValue: 100001, maxValue: 500000, discountPercent: 5 },
      ],
    });
    return r.data;
  });

  // ─── 32. Reports ────────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 32 ] REPORTS'));
  await test('GET /reports/sales', async () => {
    const r = await api('GET', '/reports/sales?period=monthly');
    return r.data;
  });

  await test('GET /reports/purchase', async () => {
    const r = await api('GET', '/reports/purchase?period=monthly');
    return r.data;
  });

  await test('GET /reports/inventory', async () => {
    const r = await api('GET', '/reports/inventory');
    return r.data;
  });

  await test('GET /reports/gst', async () => {
    const r = await api('GET', '/reports/gst?period=monthly');
    return r.data;
  });

  await test('GET /reports/profit', async () => {
    const r = await api('GET', '/reports/profit?period=monthly');
    return r.data;
  });

  await test('GET /reports/dealer-performance', async () => {
    const r = await api('GET', '/reports/dealer-performance?limit=5');
    return r.data;
  });

  // ─── 33. Daily Wages ────────────────────────────────────────────────────────
  console.log(C.bold('\n[ 33 ] DAILY WAGES'));
  await test('POST /daily-wages/workers', async () => {
    const r = await api('POST', '/daily-wages/workers', {
      workerName: `Daily Worker_${Date.now()}`,
      workerPhone: '9876501234',
      category: 'loader',
      wagePerDay: 600,
    });
    if (r.data?.data?._id) IDS.dailyWorker = r.data.data._id;
    return r.data;
  });

  await test('POST /daily-wages/attendance (batch)', async () => {
    if (!IDS.dailyWorker) return { success: false, message: 'No daily worker — skipped' };
    const r = await api('POST', '/daily-wages/attendance', {
      records: [{
        worker: IDS.dailyWorker,
        date: new Date().toISOString().slice(0, 10),
        present: true,
        hoursWorked: 8,
      }],
    });
    return r.data;
  });

  // ─── Print Summary ───────────────────────────────────────────────────────────
  printSummary();
}

function printSummary() {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const err  = results.filter(r => r.status === 'ERROR').length;
  const total = results.length;

  console.log('\n' + C.bold(C.cyan('════════════════════════════════════════════════════')));
  console.log(C.bold(`  TEST SUMMARY`));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════')));
  console.log(`  Total Tests : ${C.bold(String(total))}`);
  console.log(`  ${C.green('✅ Passed')}   : ${C.bold(String(pass))}`);
  console.log(`  ${C.red('❌ Failed')}   : ${C.bold(String(fail))}`);
  console.log(`  ${C.red('💥 Errors')}   : ${C.bold(String(err))}`);
  console.log(`  Pass Rate   : ${C.bold(`${Math.round((pass / total) * 100)}%`)}`);

  if (fail > 0 || err > 0) {
    console.log(C.bold(C.yellow('\n  FAILURES & ERRORS:')));
    results
      .filter(r => r.status !== 'PASS')
      .forEach(r => {
        const icon = r.status === 'ERROR' ? C.red('💥') : C.red('❌');
        console.log(`  ${icon} ${r.module.padEnd(38)} ${C.gray(r.message.slice(0, 80))}`);
      });
  }

  console.log('\n' + C.bold(C.cyan('════════════════════════════════════════════════════')));
  console.log(C.bold('  IDs Created (for cross-module verification):'));
  Object.entries(IDS).forEach(([k, v]) => {
    if (v) console.log(`    ${C.cyan(k.padEnd(16))} ${C.gray(v)}`);
  });
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════\n')));
}

// Node 18+ has global fetch. Check first.
if (typeof fetch === 'undefined') {
  console.error(C.red('\n❌ fetch is not available. Please use Node.js 18+ or install node-fetch.\n'));
  process.exit(1);
}

run().catch(err => {
  console.error(C.red('\n❌ Fatal error: ' + err.message));
  process.exit(1);
});
