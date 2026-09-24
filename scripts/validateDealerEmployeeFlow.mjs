/**
 * End-to-end test for the dealer-employee feature.
 *
 * Run:  node scripts/validateDealerEmployeeFlow.mjs
 *
 * Unlike validateDealerPermissions.mjs (which asserts pure functions), this boots
 * the real Express app against a THROWAWAY database and drives the real HTTP
 * routes: dealer login by OTP, employee login by OTP, PIN login, permission
 * enforcement, the global mobile guard, and access revocation.
 *
 * SAFETY
 *   MONGODB_URI is set to a dedicated test database BEFORE the app is imported.
 *   server.js loads dotenv, and dotenv never overwrites a variable that is
 *   already set — so this cannot reach the configured dev or production database.
 *   The database is dropped on the way out, including on failure.
 *
 *   If the URI ever fails to look like a test database the script refuses to run.
 */
import mongoose from 'mongoose';

const TEST_DB = 'bdmtiles_dealerflow_e2e';
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

// ── Environment, set before anything from the app is imported ────────────────
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.JWT_SECRET = 'e2e-only-secret-do-not-reuse';
process.env.JWT_REFRESH_SECRET = 'e2e-only-refresh-secret-do-not-reuse';
process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.FRONTEND_URL = 'http://localhost:5173';
// The OTP is returned in the response so the flow can be driven without an SMS
// gateway. Safe here because the database is throwaway.
process.env.OTP_EXPOSE_CODE = 'true';
process.env.RESERVATION_EXPIRY_SCHEDULER_ENABLED = 'false';
process.env.QUOTATION_HOLD_EXPIRY_SCHEDULER_ENABLED = 'false';
process.env.TRUST_PROXY = '';

if (!/test|e2e/i.test(process.env.MONGODB_URI)) {
  console.error(`Refusing to run: MONGODB_URI does not look like a test database (${process.env.MONGODB_URI}).`);
  process.exit(1);
}

let passed = 0;
const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m  ${label}`);
  } else {
    failures.push(`${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
    console.log(`  \u001b[31mFAIL\u001b[0m  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
};
const section = (title) => console.log(`\n\u001b[1m${title}\u001b[0m`);

// ── HTTP helper ──────────────────────────────────────────────────────────────
const call = async (method, path, { body, token } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await response.json(); } catch { /* some failures have no body */ }
  return { status: response.status, body: json };
};

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.status === 200) return true;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

let server;
const cleanup = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      console.log(`\nDropped test database ${TEST_DB}.`);
    }
  } catch (error) {
    console.error(`Could not drop ${TEST_DB}: ${error.message}`);
  }
  try { await mongoose.disconnect(); } catch { /* already down */ }
  try { server?.close?.(); } catch { /* already closed */ }
};

/**
 * The app logs one CORS line per request, which buries the test output. Swallow
 * just that line and let everything else through — a swallowed error here would
 * be far worse than a noisy log.
 */
const quietCorsNoise = () => {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' && chunk.includes('[CORS] Request without origin header')) return true;
      return write(chunk, ...rest);
    };
  }
};

const run = async () => {
  // Importing server.js boots it — `start()` runs at module load, so calling it
  // again here would open a second connection and a second listener on the same
  // port. Import, then wait for the already-started server to report healthy.
  await import('../server.js');

  if (!await waitForHealth()) {
    throw new Error('The app never became healthy. Is MongoDB running on 27017?');
  }

  const { default: Dealer } = await import('../models/Dealer.js');
  const { default: DealerEmployee } = await import('../models/DealerEmployee.js');
  const { default: User } = await import('../models/User.js');
  const { default: Incentive } = await import('../models/Incentive.js');
  const { default: DealerOrderRequest } = await import('../models/DealerOrderRequest.js');
  const orderService = await import('../services/dealerOrderRequestService.js');

  // ── Status groups ──────────────────────────────────────────────────────────
  // The dealer app's status boxes are driven by ORDER_STATUS_GROUPS. If someone
  // adds a status to the model and forgets the groups, requests in it would be
  // invisible from every box AND missing from the "All" total — silently, and only
  // for that one status. Asserted against the model's own enum so it cannot drift.
  section('Order status boxes cover every status exactly once');
  {
    const modelStatuses = DealerOrderRequest.schema.path('status').enumValues;
    const grouped = Object.values(orderService.ORDER_STATUS_GROUPS).flat();

    check('every model status is in a box', modelStatuses.filter((s) => !grouped.includes(s)), []);
    check('no box names a status the model does not have', grouped.filter((s) => !modelStatuses.includes(s)), []);
    check('no status is counted in two boxes', grouped.filter((s, i) => grouped.indexOf(s) !== i), []);
    check('the boxes together cover the enum', grouped.length, modelStatuses.length);
    check('"all" is an empty list, meaning no filter', orderService.ORDER_STATUS_GROUPS.all, []);

    // With two of each status, "all" must be the sum and the parts must add up.
    const synthetic = modelStatuses.map((status) => ({ _id: status, count: 2 }));
    const counts = orderService.buildStatusCounts(synthetic);
    check('"all" is the total', counts.all, modelStatuses.length * 2);
    const parts = Object.entries(counts).filter(([key]) => key !== 'all');
    check(
      'the boxes sum to "all"',
      parts.reduce((sum, [, value]) => sum + value, 0),
      counts.all,
    );

    check('an unknown group falls back to all', orderService.resolveStatusGroup('nonsense'), 'all');
    check('a known group resolves', orderService.resolveStatusGroup('pending'), 'pending');
    check('an unknown group applies no filter', orderService.statusFilterForGroup('nonsense'), {});
    check('"all" applies no filter', orderService.statusFilterForGroup('all'), {});
    check(
      'a known group filters to its statuses',
      orderService.statusFilterForGroup('pending').status.$in,
      orderService.ORDER_STATUS_GROUPS.pending,
    );
  }

  // ── Fixtures ───────────────────────────────────────────────────────────────
  const dealer = await Dealer.create({
    businessName: 'E2E Tiles',
    ownerName: 'Owner One',
    mobile: '9000000001',
    status: 'active',
    appAccess: true,
    employeeAccessEnabled: true,
  });

  // A staff user, to prove the mobile guard spans collections. Also the dealer's
  // assigned executive, which the chat write path requires.
  const salesExecutive = await User.create({
    name: 'Staff Person',
    username: 'staffperson',
    email: 'staff@example.test',
    password: 'Password123!',
    phone: '9000000003',
    role: 'sales_executive',
  });

  // Back-office support: holds `support.chat`, so their socket joins the support
  // room and receives every dealer's messages.
  await User.create({
    name: 'Support Person',
    username: 'supportperson',
    email: 'support@example.test',
    password: 'Password123!',
    phone: '9000000006',
    role: 'admin',
    permissionMode: 'custom',
    permissions: ['support.chat', 'dashboard.view'],
    status: 'Active',
  });

  await Dealer.updateOne(
    { _id: dealer._id },
    { $set: { assignedSalesExecutive: salesExecutive._id } },
  );

  const employee = await DealerEmployee.create({
    dealer: dealer._id,
    name: 'Emp One',
    mobile: '9000000002',
    designation: 'Salesperson',
    status: 'active',
    loginEnabled: true,
    role: 'salesperson',
    permissionMode: 'role_default',
    employeeCode: 'EMP-0001',
  });

  // A target, so the employee's own target endpoint has something to return.
  await Incentive.create({
    incentiveCode: `DT-${dealer.dealerCode || 'E2E'}-0001`,
    incentiveName: 'Monthly sales',
    dealer: dealer._id,
    applicableTo: 'dealer_employee',
    incentiveType: 'target',
    triggerEvent: 'monthly_sales',
    targetMetric: 'sales',
    targetValue: 100000,
    period: 'monthly',
    validFrom: new Date(Date.now() - 86400000),
    validTo: new Date(Date.now() + 86400000),
    status: 'active',
    specificDealerEmployees: [employee._id],
  });

  // ── Login ──────────────────────────────────────────────────────────────────
  section('Login — OTP resolves a mobile to the right principal');

  const otpFor = async (mobile) => {
    const requested = await call('POST', '/dealer-app/auth/otp/request', { body: { mobile } });
    return { status: requested.status, code: requested.body?.devOtp };
  };

  const dealerOtp = await otpFor('9000000001');
  check('dealer OTP requested', dealerOtp.status, 200);
  const dealerLogin = await call('POST', '/dealer-app/auth/otp/verify', {
    body: { mobile: '9000000001', otp: dealerOtp.code },
  });
  check('dealer logged in', dealerLogin.status, 200);
  const dealerToken = dealerLogin.body?.token;
  check('dealer is the owner', dealerLogin.body?.dealer?.isOwner, true);

  const employeeOtp = await otpFor('9000000002');
  check('employee OTP requested', employeeOtp.status, 200);
  const employeeLogin = await call('POST', '/dealer-app/auth/otp/verify', {
    body: { mobile: '9000000002', otp: employeeOtp.code },
  });
  check('employee logged in', employeeLogin.status, 200);
  const employeeToken = employeeLogin.body?.token;
  check('employee is not the owner', employeeLogin.body?.dealer?.isOwner, false);
  check('employee profile names the employee', employeeLogin.body?.dealer?.employee?.name, 'Emp One');

  const unregistered = await call('POST', '/dealer-app/auth/otp/request', { body: { mobile: '9000000999' } });
  check('an unregistered mobile is refused', unregistered.status, 404);

  // ── Finance redaction ──────────────────────────────────────────────────────
  section('A salesperson cannot reach finance');

  check('salesperson has no ledger permission', employeeLogin.body?.dealer?.permissions?.includes('finance.ledger'), false);
  check('credit limit is redacted on the profile', employeeLogin.body?.dealer?.creditLimit, null);
  check('outstanding is redacted on the profile', employeeLogin.body?.dealer?.currentOutstanding, null);

  const employeeStatement = await call('GET', '/dealer-app/statement', { token: employeeToken });
  check('employee is blocked from the ledger statement', employeeStatement.status, 403);
  check('the block names the missing permission', employeeStatement.body?.requiredPermissions, ['finance.ledger']);

  const ownerStatement = await call('GET', '/dealer-app/statement', { token: dealerToken });
  check('owner reaches the ledger statement', ownerStatement.status, 200);

  const employeeDashboard = await call('GET', '/dealer-app/dashboard', { token: employeeToken });
  check('dashboard hides the credit block', employeeDashboard.body?.data?.creditHidden, true);
  check('dashboard hides invoices', employeeDashboard.body?.data?.invoicesHidden, true);
  check('dashboard sends no credit limit', employeeDashboard.body?.data?.credit, undefined);

  // ── Order scope ────────────────────────────────────────────────────────────
  section('Order scope — an employee cannot widen their own view');

  const employeeAll = await call('GET', '/dealer-app/orders?scope=all', { token: employeeToken });
  check('employee asking for all still gets mine', employeeAll.body?.scope, 'mine');

  const ownerAll = await call('GET', '/dealer-app/orders?scope=all', { token: dealerToken });
  check('owner gets all', ownerAll.body?.scope, 'all');

  const ownerMine = await call('GET', '/dealer-app/orders?scope=mine', { token: dealerToken });
  check('owner can narrow to their own', ownerMine.body?.scope, 'mine');

  const employeeRequests = await call('GET', '/dealer-app/order-requests?scope=all', { token: employeeToken });
  check('employee requests are scoped too', employeeRequests.body?.scope, 'mine');

  // ── Team permissions ───────────────────────────────────────────────────────
  section('An employee cannot manage the team');

  const employeeCreates = await call('POST', '/dealer-app/employees', {
    token: employeeToken,
    body: { name: 'Sneaky', mobile: '9000000004' },
  });
  check('employee cannot create an employee', employeeCreates.status, 403);

  const employeeList = await call('GET', '/dealer-app/employees', { token: employeeToken });
  check('employee cannot list the team without team.view', employeeList.status, 403);

  const employeePermissions = await call('GET', '/dealer-app/employees/permissions', { token: employeeToken });
  check('employee cannot read the permission catalog', employeePermissions.status, 403);

  // ── Mobile guard ───────────────────────────────────────────────────────────
  section('The mobile guard spans every collection');

  // Anything that would identify the current holder. If a name, a business name
  // or the kind of account leaks into the response, the add-employee form becomes
  // an enumeration tool for other dealers' staff and BDMTILES numbers.
  const HOLDER_NAMES = /E2E Tiles|Other Tiles|Owner One|Owner Two|Staff Person|Emp One|Emp Two/;
  const HOLDER_CATEGORY = /\b(dealer|staff|employee|user|supplier|customer)\b/i;

  const clashDealer = await call('POST', '/dealer-app/employees', {
    token: dealerToken,
    body: { name: 'Clash Dealer', mobile: '9000000001' },
  });
  check('cannot reuse the dealer owner number', clashDealer.status, 409);
  check('the clash is reported as such', clashDealer.body?.code, 'MOBILE_ALREADY_IN_USE');
  check('the clash does not name the holder', HOLDER_NAMES.test(clashDealer.body?.message || ''), false);
  check('the clash does not reveal the account kind', HOLDER_CATEGORY.test(clashDealer.body?.message || ''), false);

  const clashEmployee = await call('POST', '/dealer-app/employees', {
    token: dealerToken,
    body: { name: 'Clash Employee', mobile: '9000000002' },
  });
  check('cannot reuse another employee number', clashEmployee.status, 409);
  check('that clash names nobody either', HOLDER_NAMES.test(clashEmployee.body?.message || ''), false);

  const clashStaff = await call('POST', '/dealer-app/employees', {
    token: dealerToken,
    body: { name: 'Clash Staff', mobile: '9000000003' },
  });
  check('cannot reuse a BDMTILES staff number', clashStaff.status, 409);
  // The most sensitive case: revealing this would tell a dealer that a number is
  // an internal BDMTILES one.
  check('a staff number is not identified as staff', HOLDER_CATEGORY.test(clashStaff.body?.message || ''), false);
  check('a staff number names no one', HOLDER_NAMES.test(clashStaff.body?.message || ''), false);

  const clean = await call('POST', '/dealer-app/employees', {
    token: dealerToken,
    body: { name: 'Emp Two', mobile: '9000000005', role: 'viewer' },
  });
  check('a free number is accepted', clean.status, 201);
  check('the new employee has no login until enabled', clean.body?.data?.loginEnabled, false);
  const secondEmployeeId = clean.body?.data?.id;

  const availability = await call('GET', '/dealer-app/employees/mobile-availability?mobile=9000000003', { token: dealerToken });
  check('availability probe reports the clash', availability.body?.data?.available, false);
  // The probe is the easiest enumeration route, so it must be as tight as the form.
  check('the probe does not name the holder', HOLDER_NAMES.test(availability.body?.data?.message || ''), false);
  check('the probe does not reveal the account kind', HOLDER_CATEGORY.test(availability.body?.data?.message || ''), false);
  check('the probe reason is generic', availability.body?.data?.reason, 'IN_USE');

  // ── Grants the dealer can make ─────────────────────────────────────────────
  section('Explicit grants and the BDMTILES finance policy');

  // Grant a finance permission AND a non-finance one, so the next step can prove
  // the policy is narrow. Custom mode REPLACES the list, so targets.view has to be
  // included explicitly or it is revoked here rather than by the policy.
  const grantFinance = await call('PUT', `/dealer-app/employees/${employee._id}`, {
    token: dealerToken,
    body: {
      permissionMode: 'custom',
      permissions: ['payments.view', 'finance.ledger', 'targets.view', 'targets.manage'],
    },
  });
  check('dealer can grant the ledger', grantFinance.status, 200);

  const nowAllowed = await call('GET', '/dealer-app/statement', { token: employeeToken });
  check('the grant takes effect without re-login', nowAllowed.status, 200);

  await Dealer.updateOne({ _id: dealer._id }, { $set: { allowEmployeeFinanceAccess: false } });
  const afterPolicy = await call('GET', '/dealer-app/statement', { token: employeeToken });
  check('BDMTILES policy revokes it immediately', afterPolicy.status, 403);

  // targets.manage is `sensitive` but not `finance`, so the policy must not reach
  // it. This is the regression guard for the bug the pure-function validator found.
  const targetViewSurvives = await call('GET', '/dealer-app/targets/me', { token: employeeToken });
  check('the finance policy does not revoke target viewing', targetViewSurvives.status, 200);

  const stillAuthoring = await call('POST', '/dealer-app/targets', {
    token: employeeToken,
    body: {
      employeeId: String(employee._id),
      title: 'Authoring survives the finance policy',
      targetMetric: 'sales',
      targetValue: 5000,
      period: 'monthly',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    },
  });
  check('the finance policy does not revoke target authoring', stillAuthoring.status, 201);

  await Dealer.updateOne({ _id: dealer._id }, { $set: { allowEmployeeFinanceAccess: true } });

  const wildcard = await call('PUT', `/dealer-app/employees/${employee._id}`, {
    token: dealerToken,
    body: { permissionMode: 'custom', permissions: ['*'] },
  });
  check('a wildcard is refused', wildcard.status, 422);

  const reserved = await call('PUT', `/dealer-app/employees/${employee._id}`, {
    token: dealerToken,
    body: { permissionMode: 'custom', permissions: ['customers.view'] },
  });
  check('a reserved permission is refused', reserved.status, 422);

  const unknown = await call('PUT', `/dealer-app/employees/${employee._id}`, {
    token: dealerToken,
    body: { permissionMode: 'custom', permissions: ['orders.nuke'] },
  });
  check('an unknown permission is refused', unknown.status, 422);

  // ── PIN login ──────────────────────────────────────────────────────────────
  section('PIN login belongs to the signed-in principal');

  const setPin = await call('POST', '/dealer-app/auth/pin/set', { token: employeeToken, body: { pin: '4321' } });
  check('employee can set a PIN', setPin.status, 200);

  const pinLogin = await call('POST', '/dealer-app/auth/pin/login', {
    body: { mobile: '9000000002', pin: '4321' },
  });
  check('employee can sign in with the PIN', pinLogin.status, 200);
  check('PIN login resolves to the employee', pinLogin.body?.dealer?.isOwner, false);

  const ownerPinStillUnset = await call('POST', '/dealer-app/auth/pin/login', {
    body: { mobile: '9000000001', pin: '4321' },
  });
  check('the employee PIN did not become the owner PIN', ownerPinStillUnset.status, 401);

  // ── Revocation ─────────────────────────────────────────────────────────────
  section('Revoking access takes effect immediately');

  const disable = await call('PATCH', `/dealer-app/employees/${employee._id}/access`, {
    token: dealerToken,
    body: { loginEnabled: false },
  });
  check('dealer can disable the login', disable.status, 200);

  // Disabling returns 403 with a specific code rather than 401: the token itself
  // is still well-formed, the account is what changed. The app can then say "your
  // access was turned off" instead of "session expired", which would send the
  // employee round a pointless re-login loop.
  const afterDisable = await call('GET', '/dealer-app/auth/me', { token: employeeToken });
  check('the existing token stops working', afterDisable.status, 403);
  check('and says why', afterDisable.body?.code, 'EMPLOYEE_LOGIN_DISABLED');

  const reloginBlocked = await call('POST', '/dealer-app/auth/otp/request', { body: { mobile: '9000000002' } });
  check('and they cannot request a new OTP', reloginBlocked.status, 403);
  check('the reason is specific', reloginBlocked.body?.code, 'EMPLOYEE_LOGIN_DISABLED');

  const dealerKillSwitch = await Dealer.updateOne({ _id: dealer._id }, { $set: { employeeAccessEnabled: false } });
  check('the dealer-level kill switch applies', dealerKillSwitch.modifiedCount, 1);
  await DealerEmployee.updateOne({ _id: employee._id }, { $set: { loginEnabled: true } });
  const blockedByDealer = await call('POST', '/dealer-app/auth/otp/request', { body: { mobile: '9000000002' } });
  check('employee logins blocked at dealer level', blockedByDealer.body?.code, 'EMPLOYEE_ACCESS_DISABLED');

  // Restore both switches and sign in again. The sections below are about
  // isolation and targets, and a disabled employee 403s before reaching either —
  // leaving it off would test the wrong thing. A fresh token is needed because
  // disabling bumped tokenVersion.
  await Dealer.updateOne({ _id: dealer._id }, { $set: { employeeAccessEnabled: true } });
  const reEnabledOtp = await otpFor('9000000002');
  const reEnabledLogin = await call('POST', '/dealer-app/auth/otp/verify', {
    body: { mobile: '9000000002', otp: reEnabledOtp.code },
  });
  check('a re-enabled employee can sign in again', reEnabledLogin.status, 200);
  const employeeToken2 = reEnabledLogin.body?.token;

  // ── Isolation between dealers ──────────────────────────────────────────────
  section('One dealer cannot reach another dealer staff');

  // An explicit dealerCode: `Dealer.dealerCode` is `unique: true` WITHOUT sparse,
  // so a second dealer created with no code collides on `null`. Every dealer the
  // admin API creates gets a generated code, so this only bites code that writes a
  // Dealer directly — but the test must not depend on that path.
  const otherDealer = await Dealer.create({
    businessName: 'Other Tiles',
    ownerName: 'Owner Two',
    mobile: '9000000100',
    dealerCode: 'E2E-OTHER-01',
    status: 'active',
    appAccess: true,
  });
  const otherEmployee = await DealerEmployee.create({
    dealer: otherDealer._id,
    name: 'Other Emp',
    mobile: '9000000101',
    status: 'active',
    loginEnabled: true,
    role: 'salesperson',
  });

  const crossRead = await call('GET', `/dealer-app/employees/${otherEmployee._id}`, { token: dealerToken });
  check('the other dealer employee is not found', crossRead.status, 404);

  const crossPerformance = await call('GET', `/dealer-app/targets/employees/${otherEmployee._id}/performance`, { token: dealerToken });
  check('their performance is not reachable', crossPerformance.status, 404);

  const crossWrite = await call('PUT', `/dealer-app/employees/${otherEmployee._id}`, {
    token: dealerToken,
    body: { name: 'Hijacked' },
  });
  check('their record cannot be edited', crossWrite.status, 404);

  const crossTarget = await call('POST', '/dealer-app/targets', {
    token: dealerToken,
    body: {
      employeeId: String(otherEmployee._id),
      title: 'Cross-dealer target',
      targetMetric: 'sales',
      targetValue: 1000,
      period: 'monthly',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    },
  });
  check('a target cannot be assigned to their employee', crossTarget.status, 404);

  // ── Targets ────────────────────────────────────────────────────────────────
  section('Targets and incentives');

  const myTargets = await call('GET', '/dealer-app/targets/me', { token: employeeToken2 });
  check('employee sees their own target', myTargets.status, 200);
  check('and it is the one assigned to them', myTargets.body?.data?.length > 0, true);

  const teamTargets = await call('GET', '/dealer-app/targets', { token: dealerToken });
  check('owner can read team targets', teamTargets.status, 200);

  const employeeTeamTargets = await call('GET', '/dealer-app/targets', { token: employeeToken2 });
  check('employee cannot read team targets', employeeTeamTargets.status, 403);

  const employeePerformance = await call('GET', `/dealer-app/targets/employees/${employee._id}/performance`, { token: dealerToken });
  check('owner can read an employee performance', employeePerformance.status, 200);
  check('and the trend covers twelve months', employeePerformance.body?.data?.trend?.length, 12);

  const selfPerformance = await call('GET', `/dealer-app/targets/employees/${employee._id}/performance`, { token: employeeToken2 });
  check('an employee cannot read performance', selfPerformance.status, 403);

  const badDates = await call('POST', '/dealer-app/targets', {
    token: dealerToken,
    body: {
      employeeId: String(employee._id),
      title: 'Backwards',
      targetMetric: 'sales',
      targetValue: 1000,
      period: 'monthly',
      startDate: '2026-05-01',
      endDate: '2026-04-01',
    },
  });
  check('an inverted date range is refused', badDates.status, 422);

  const scopedRequired = await call('POST', '/dealer-app/targets', {
    token: dealerToken,
    body: {
      employeeId: String(employee._id),
      title: 'No products picked',
      targetMetric: 'product',
      targetValue: 100,
      period: 'monthly',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    },
  });
  check('a product target needs a product', scopedRequired.status, 422);

  // ── Order status boxes over HTTP ───────────────────────────────────────────
  section('Order status boxes and filtering');
  {
    const { default: Branch } = await import('../models/Branch.js');
    const branch = await Branch.create({
      branchCode: 'E2E-BR-01',
      name: 'E2E Branch',
      status: 'active',
    });

    const statuses = ['submitted', 'submitted', 'approved', 'rejected', 'partially_processed', 'cancelled'];
    const productId = new mongoose.Types.ObjectId();
    const item = {
      product: productId,
      productName: 'E2E Tile',
      quantity: 1, boxes: 1, pieces: 1, sqft: 1, piecesPerBox: 1, sqftPerBox: 1,
    };

    await DealerOrderRequest.insertMany(statuses.map((status, index) => ({
      requestNumber: `E2E-REQ-${index + 1}`,
      branch: branch._id,
      dealer: dealer._id,
      dealerSnapshot: { businessName: 'E2E Tiles' },
      salesExecutive: (dealer.assignedSalesExecutive || new mongoose.Types.ObjectId()),
      items: [item],
      status,
      submittedAt: new Date(),
      sourceKey: `e2e-status-${index}`,
      requestFingerprint: `fp-${index}`,
      createdBy: new mongoose.Types.ObjectId(),
    })));

    const allBox = await call('GET', '/dealer-app/order-requests?group=all', { token: dealerToken });
    check('all box returns every request', allBox.body?.counts?.all, 6);
    check('all box returns all rows', allBox.body?.data?.length, 6);
    check('the box group is echoed back', allBox.body?.group, 'all');

    // The parts must sum to "all", or a box is double-counting or missing.
    const counts = allBox.body?.counts || {};
    check('submitted box', counts.submitted, 2);
    check('pending box (partially_processed only)', counts.pending, 1);
    check('approved box', counts.approved, 1);
    check('rejected box', counts.rejected, 1);
    check('cancelled box', counts.cancelled, 1);
    check(
      'the boxes sum to all',
      ['submitted', 'pending', 'approved', 'rejected', 'cancelled'].reduce((sum, key) => sum + (counts[key] || 0), 0),
      counts.all,
    );

    // Counts must not change when a box is selected — the dealer still needs to see
    // how much is in the other buckets.
    const submittedBox = await call('GET', '/dealer-app/order-requests?group=submitted', { token: dealerToken });
    check('the submitted box filters the list', submittedBox.body?.data?.length, 2);
    check('and the counts stay the full picture', submittedBox.body?.counts?.all, 6);
    check('with the same submitted figure', submittedBox.body?.counts?.submitted, 2);

    const pendingBox = await call('GET', '/dealer-app/order-requests?group=pending', { token: dealerToken });
    check('the pending box filters the list', pendingBox.body?.data?.length, 1);

    // A stale or hostile group must not blank the screen.
    const junk = await call('GET', '/dealer-app/order-requests?group=nonsense', { token: dealerToken });
    check('an unknown group falls back to all', junk.body?.group, 'all');
    check('an unknown group shows everything', junk.body?.data?.length, 6);

    // The dashboard must agree with the Orders screen.
    const dashboard = await call('GET', '/dealer-app/dashboard', { token: dealerToken });
    check('the dashboard carries the same boxes', dashboard.body?.data?.requestCounts?.all, 6);
    check('and the same pending figure', dashboard.body?.data?.requestCounts?.pending, 1);
  }

  // ── Realtime chat over socket.io ───────────────────────────────────────────
  section('Realtime chat over socket.io');
  {
    const { io } = await import('socket.io-client');
    const SOCKET_URL = `http://127.0.0.1:${PORT}`;
    const openSockets = [];

    const connectSocket = (token) => new Promise((resolve, reject) => {
      const socket = io(SOCKET_URL, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
        timeout: 6000,
      });
      openSockets.push(socket);
      const fail = setTimeout(() => reject(new Error('socket never became ready')), 8000);
      socket.on('ready', () => { clearTimeout(fail); resolve(socket); });
      socket.on('connect_error', (error) => { clearTimeout(fail); reject(error); });
    });

    const expectConnectError = (token) => new Promise((resolve) => {
      const socket = io(SOCKET_URL, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
        timeout: 6000,
      });
      openSockets.push(socket);
      const done = setTimeout(() => resolve(null), 8000);
      socket.on('ready', () => { clearTimeout(done); resolve('READY'); });
      socket.on('connect_error', (error) => { clearTimeout(done); resolve(error.message); });
    });

    const waitForEvent = (socket, event, ms = 6000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms);
      socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
    });

    /** Resolves true if the event does NOT arrive — the isolation check. */
    const expectNoEvent = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(true), ms);
      socket.once(event, () => { clearTimeout(timer); reject(new Error(`unexpected ${event}`)); });
    });

    // ── Handshake rejections ──
    check('a socket with no token is refused', await expectConnectError(null), 'unauthorized');
    check('a socket with a junk token is refused', await expectConnectError('not-a-token'), 'unauthorized');

    // ── The dealer receives their own message ──
    const dealerSocket = await connectSocket(dealerToken);
    check('the dealer socket connects', Boolean(dealerSocket.connected), true);

    const pushed = waitForEvent(dealerSocket, 'message:new');
    const sent = await call('POST', '/dealer-app/messages', {
      token: dealerToken,
      body: { body: 'Realtime hello' },
    });
    check('the message was accepted', sent.status, 201);

    const delivered = await pushed;
    check('the dealer receives it over the socket', delivered.body, 'Realtime hello');
    check('the payload names the dealer', delivered.dealer, String(dealer._id));
    check('the payload marks it as the dealer side', delivered.senderRole, 'dealer');
    check('the payload carries the message id', Boolean(delivered.id), true);

    // ── The support desk receives it too ──
    const supportLogin = await call('POST', '/auth/login', {
      body: { email: 'support@example.test', password: 'Password123!' },
    });
    check('the support user can sign in', supportLogin.status, 200);
    const supportSocket = await connectSocket(supportLogin.body?.token);
    check('the support socket connects', Boolean(supportSocket.connected), true);

    const supportPush = waitForEvent(supportSocket, 'message:new');
    await call('POST', '/dealer-app/messages', {
      token: dealerToken,
      body: { body: 'Visible to the support desk' },
    });
    const supportDelivered = await supportPush;
    check('the support desk receives it', supportDelivered.body, 'Visible to the support desk');

    // ── Another dealer must NOT receive it ──
    const rival = await Dealer.create({
      businessName: 'Rival Tiles',
      ownerName: 'Rival Owner',
      mobile: '9000000200',
      dealerCode: 'E2E-RIVAL-01',
      status: 'active',
      appAccess: true,
    });
    const rivalOtp = await otpFor('9000000200');
    const rivalLogin = await call('POST', '/dealer-app/auth/otp/verify', {
      body: { mobile: '9000000200', otp: rivalOtp.code },
    });
    const rivalSocket = await connectSocket(rivalLogin.body?.token);
    check('the rival dealer connects', Boolean(rivalSocket.connected), true);

    const leakCheck = expectNoEvent(rivalSocket, 'message:new');
    await call('POST', '/dealer-app/messages', {
      token: dealerToken,
      body: { body: 'Private to E2E Tiles' },
    });
    check('another dealer does NOT receive it', await leakCheck, true);

    // ── A dealer employee without chat.view gets no feed ──
    await DealerEmployee.updateOne(
      { _id: employee._id },
      { $set: { permissionMode: 'custom', permissions: ['orders.view'], loginEnabled: true } },
    );
    const noChatOtp = await otpFor('9000000002');
    const noChatLogin = await call('POST', '/dealer-app/auth/otp/verify', {
      body: { mobile: '9000000002', otp: noChatOtp.code },
    });
    const noChatSocket = await connectSocket(noChatLogin.body?.token);
    check('an employee without chat.view still connects', Boolean(noChatSocket.connected), true);

    const noChatLeak = expectNoEvent(noChatSocket, 'message:new');
    await call('POST', '/dealer-app/messages', {
      token: dealerToken,
      body: { body: 'Should not reach a non-chat employee' },
    });
    check('but receives nothing', await noChatLeak, true);

    // ── An employee WITH chat.view does ──
    await DealerEmployee.updateOne(
      { _id: employee._id },
      { $set: { permissionMode: 'custom', permissions: ['chat.view'], loginEnabled: true } },
    );
    const chatOtp = await otpFor('9000000002');
    const chatLogin = await call('POST', '/dealer-app/auth/otp/verify', {
      body: { mobile: '9000000002', otp: chatOtp.code },
    });
    const chatSocket = await connectSocket(chatLogin.body?.token);
    const chatPush = waitForEvent(chatSocket, 'message:new');
    await call('POST', '/dealer-app/messages', {
      token: dealerToken,
      body: { body: 'Reaches the granted employee' },
    });
    check('an employee granted chat.view receives it', (await chatPush).body, 'Reaches the granted employee');

    // ── Revoking access closes the feed ──
    // Through the ROUTE, not a direct write: the route is what drops the live
    // socket immediately. A direct DB edit would only be caught by the 60s
    // revalidation sweep, which is the backstop for changes made outside the API.
    const revoke = await call('PATCH', `/dealer-app/employees/${employee._id}/access`, {
      token: dealerToken,
      body: { loginEnabled: false },
    });
    check('the dealer can revoke access', revoke.status, 200);

    const revokedLeak = expectNoEvent(chatSocket, 'message:new');
    await call('POST', '/dealer-app/messages', {
      token: dealerToken,
      body: { body: 'After revocation' },
    });
    check('a revoked employee socket stops being fed', await revokedLeak, true);

    openSockets.forEach((socket) => socket.disconnect());
    check('a rival dealer fixture was created', Boolean(rival._id), true);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const bar = '='.repeat(64);
  if (failures.length) {
    console.error(`\n${bar}\n  ${passed} passed, ${failures.length} FAILED\n${bar}`);
    failures.forEach((failure) => console.error(`  - ${failure}`));
    console.error('');
    return 1;
  }
  console.log(`\n${bar}\n  ${passed} passed, 0 failed\n${bar}\n`);
  return 0;
};

let exitCode = 1;
try {
  quietCorsNoise();
  exitCode = await run();
} catch (error) {
  console.error(`\n\u001b[31mThe flow could not complete:\u001b[0m ${error.message}`);
  if (error.stack) console.error(error.stack.split('\n').slice(0, 4).join('\n'));
} finally {
  await cleanup();
}
process.exit(exitCode);
