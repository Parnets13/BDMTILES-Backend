/**
 * Validates the dealer-employee permission and target model.
 *
 * Run:  node scripts/validateDealerPermissions.mjs
 *
 * These are the invariants that keep a dealer from being able to hand out more
 * than BDMTILES intends, and that keep a dealer employee from reaching finance
 * data they were never granted. They are pure functions, so this needs no
 * database and can run in CI before anything is deployed.
 *
 * Exits non-zero on the first failing group so a pipeline stops.
 */
import {
  ALL_DEALER_PERMISSIONS,
  DEALER_AVAILABLE_PERMISSIONS,
  DEALER_FINANCE_PERMISSION_IDS,
  DEALER_ROLE_PRESETS,
  DEALER_RESERVED_PERMISSION_IDS,
  DEALER_SENSITIVE_PERMISSION_IDS,
  dealerPrincipalHasAnyPermission,
  dealerPrincipalHasPermission,
  dealerOrderScope,
  resolveDealerEmployeePermissions,
} from '../config/dealerPermissions.js';
import { AVAILABLE_PERMISSIONS as STAFF_AVAILABLE_PERMISSIONS } from '../config/permissions.js';
import {
  DEALER_METRIC_META,
  DEALER_TARGET_METRICS,
  DEALER_TARGET_PERIODS,
  triggerEventForDealer,
} from '../services/dealerTargetService.js';

let passed = 0;
const failures = [];

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failures.push(`${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
};

const section = (title) => console.log(`\n${title}`);

// ── Catalog integrity ────────────────────────────────────────────────────────
section('Catalog integrity');
check('permission ids are unique', ALL_DEALER_PERMISSIONS.length, new Set(ALL_DEALER_PERMISSIONS).size);
check(
  'every id is module.action shaped',
  ALL_DEALER_PERMISSIONS.every((id) => /^[a-z]+\.[a-zA-Z]+$/.test(id)),
  true,
);
check('no wildcard is offered as a permission', ALL_DEALER_PERMISSIONS.includes('*'), false);

// The dealer catalog and the staff catalog are resolved against different
// principals, so a shared id is not a privilege escalation — `dashboard.view`
// means the same thing on both sides. What must never be shared is a PRIVILEGED
// id, because that is the one that could plausibly be reached from the wrong
// side of the boundary. This asserts the meaningful half of the separation
// rather than pretending the catalogs are fully disjoint.
{
  const staffIds = new Set(
    Object.values(STAFF_AVAILABLE_PERMISSIONS).flat().map((permission) => permission.id),
  );
  const shared = ALL_DEALER_PERMISSIONS.filter((id) => staffIds.has(id));
  check('no privileged dealer permission is also a staff permission', shared.filter((id) => DEALER_SENSITIVE_PERMISSION_IDS.includes(id)), []);
  check('no finance permission is also a staff permission', shared.filter((id) => DEALER_FINANCE_PERMISSION_IDS.includes(id)), []);
  // Documents the known, intentional overlap so an unexpected third one is caught.
  check('the only shared ids are the two harmless view permissions', [...shared].sort(), ['dashboard.view', 'reports.sales']);
}
check(
  'every preset id exists in the catalog',
  Object.values(DEALER_ROLE_PRESETS).flat().filter((id) => !ALL_DEALER_PERMISSIONS.includes(id)),
  [],
);
check(
  'every preset id has a definition',
  ALL_DEALER_PERMISSIONS.filter((id) => !Object.values(DEALER_AVAILABLE_PERMISSIONS).flat().some((p) => p.id === id)),
  [],
);

// ── Sensitive finance must never be inherited ────────────────────────────────
section('Sensitive finance is never inherited');
for (const [role, preset] of Object.entries(DEALER_ROLE_PRESETS)) {
  check(
    `preset "${role}" carries no sensitive permission`,
    preset.filter((id) => DEALER_SENSITIVE_PERMISSION_IDS.includes(id)),
    [],
  );
}
check(
  'exactly the three finance permissions are the money-data set',
  [...DEALER_FINANCE_PERMISSION_IDS].sort(),
  ['finance.creditLimit', 'finance.ledger', 'finance.outstanding'],
);
check(
  'the money-data set is a subset of the sensitive set',
  DEALER_FINANCE_PERMISSION_IDS.every((id) => DEALER_SENSITIVE_PERMISSION_IDS.includes(id)),
  true,
);
check(
  'target authoring is sensitive but NOT money data',
  [
    DEALER_SENSITIVE_PERMISSION_IDS.includes('targets.manage'),
    DEALER_FINANCE_PERMISSION_IDS.includes('targets.manage'),
    DEALER_FINANCE_PERMISSION_IDS.includes('incentives.manage'),
  ],
  [true, false, false],
);

section('No preset employee can reach the ledger, outstanding or credit limit');
for (const role of ['manager', 'salesperson', 'accountant', 'viewer']) {
  const resolved = resolveDealerEmployeePermissions(
    { permissionMode: 'role_default', role, permissions: [] },
    { allowEmployeeFinanceAccess: true },
  );
  check(`${role} cannot see finance.ledger`, resolved.includes('finance.ledger'), false);
  check(`${role} cannot see finance.outstanding`, resolved.includes('finance.outstanding'), false);
  check(`${role} cannot see finance.creditLimit`, resolved.includes('finance.creditLimit'), false);
}

section('No preset employee can author targets or incentives');
for (const role of ['manager', 'salesperson', 'accountant', 'viewer']) {
  const resolved = resolveDealerEmployeePermissions(
    { permissionMode: 'role_default', role, permissions: [] },
    { allowEmployeeFinanceAccess: true },
  );
  check(`${role} cannot assign targets`, resolved.includes('targets.manage'), false);
  check(`${role} cannot configure incentives`, resolved.includes('incentives.manage'), false);
}
check(
  'a manager can still see team performance',
  resolveDealerEmployeePermissions(
    { permissionMode: 'role_default', role: 'manager', permissions: [] },
    { allowEmployeeFinanceAccess: true },
  ).includes('performance.view'),
  true,
);

// ── Explicit grants ─────────────────────────────────────────────────────────
section('Explicit grants and the BDMTILES policy override');
{
  const employee = {
    permissionMode: 'custom',
    role: 'accountant',
    permissions: ['payments.view', 'finance.ledger', 'finance.outstanding', 'finance.creditLimit'],
  };
  const allowed = resolveDealerEmployeePermissions(employee, { allowEmployeeFinanceAccess: true });
  check('grant survives when the policy allows it', allowed.includes('finance.ledger'), true);

  const blocked = resolveDealerEmployeePermissions(employee, { allowEmployeeFinanceAccess: false });
  check('ledger stripped when the policy forbids it', blocked.includes('finance.ledger'), false);
  check('outstanding stripped when the policy forbids it', blocked.includes('finance.outstanding'), false);
  check('credit limit stripped when the policy forbids it', blocked.includes('finance.creditLimit'), false);
  check('non-finance permission is untouched by the policy', blocked.includes('payments.view'), true);
}

// Regression: the finance policy must not reach beyond finance. An earlier
// revision keyed the strip off the sensitive list, so switching finance off also
// took target authoring away — the two lists are now deliberately separate.
section('The finance policy does not over-reach');
{
  const author = {
    permissionMode: 'custom',
    role: 'manager',
    permissions: ['targets.manage', 'incentives.manage', 'performance.view', 'finance.ledger'],
  };
  const withFinanceOff = resolveDealerEmployeePermissions(author, { allowEmployeeFinanceAccess: false });
  check('target authoring survives the finance policy', withFinanceOff.includes('targets.manage'), true);
  check('incentive authoring survives the finance policy', withFinanceOff.includes('incentives.manage'), true);
  check('performance viewing survives the finance policy', withFinanceOff.includes('performance.view'), true);
  check('finance is still stripped by the policy', withFinanceOff.includes('finance.ledger'), false);
}

// ── Permission checks ───────────────────────────────────────────────────────
section('Principal permission checks');
{
  const owner = { isOwner: true, permissions: ['*'] };
  check('owner passes a finance gate', dealerPrincipalHasPermission(owner, 'finance.ledger'), true);
  check('owner passes a target-authoring gate', dealerPrincipalHasPermission(owner, 'targets.manage'), true);

  const employee = { isOwner: false, permissions: ['orders.view', 'targets.view'] };
  check('employee passes a granted gate', dealerPrincipalHasPermission(employee, 'orders.view'), true);
  check('employee fails an ungranted finance gate', dealerPrincipalHasPermission(employee, 'finance.ledger'), false);
  check('employee fails an ungranted authoring gate', dealerPrincipalHasPermission(employee, 'targets.manage'), false);
  check(
    'any-of passes on a single match',
    dealerPrincipalHasAnyPermission(employee, ['finance.ledger', 'targets.view']),
    true,
  );
  check(
    'any-of fails with no match',
    dealerPrincipalHasAnyPermission(employee, ['finance.ledger', 'incentives.manage']),
    false,
  );

  const moduleWildcard = { isOwner: false, permissions: ['orders.*'] };
  check('module wildcard covers children', dealerPrincipalHasPermission(moduleWildcard, 'orders.cancel'), true);
  check(
    'module wildcard does not leak across modules',
    dealerPrincipalHasPermission(moduleWildcard, 'finance.ledger'),
    false,
  );
}

section('Reserved permissions (no feature behind them yet)');
check(
  'exactly the customers module is reserved',
  [...DEALER_RESERVED_PERMISSION_IDS].sort(),
  ['customers.create', 'customers.edit', 'customers.view'],
);
check(
  'no preset offers a reserved permission',
  Object.values(DEALER_ROLE_PRESETS).flat().filter((id) => DEALER_RESERVED_PERMISSION_IDS.includes(id)),
  [],
);
check(
  'reserved permissions are neither finance nor sensitive',
  DEALER_RESERVED_PERMISSION_IDS.filter(
    (id) => DEALER_FINANCE_PERMISSION_IDS.includes(id) || DEALER_SENSITIVE_PERMISSION_IDS.includes(id),
  ),
  [],
);
check(
  'every reserved id is a real catalog id',
  DEALER_RESERVED_PERMISSION_IDS.filter((id) => !ALL_DEALER_PERMISSIONS.includes(id)),
  [],
);

// ── Order scope ─────────────────────────────────────────────────────────────
section('Order scope — an employee cannot widen their own view');
{
  const EMP = 'emp-1';
  const employee = { isOwner: false, permissions: ['orders.view'] };
  const granted = { isOwner: false, permissions: ['orders.view', 'orders.viewAll'] };
  const owner = { isOwner: true, permissions: ['*'] };

  // Without the grant, "all" is not on offer whatever the caller asks for.
  check('employee default is their own', dealerOrderScope({ principal: employee, employeeId: EMP }).scope, 'mine');
  check('employee asking for all is refused', dealerOrderScope({ principal: employee, employeeId: EMP, requested: 'all' }).scope, 'mine');
  check('employee filter is pinned to them', dealerOrderScope({ principal: employee, employeeId: EMP, requested: 'all' }).filter, { createdByEmployee: EMP });
  check('scope match is case-insensitive', dealerOrderScope({ principal: employee, employeeId: EMP, requested: 'ALL' }).scope, 'mine');
  check('a junk scope is ignored', dealerOrderScope({ principal: employee, employeeId: EMP, requested: '../../etc' }).scope, 'mine');
  check('an empty scope value is ignored', dealerOrderScope({ principal: employee, employeeId: EMP, requested: '' }).scope, 'mine');

  // With the grant: default stays narrow, widening is opt-in.
  check('granted employee defaults to their own', dealerOrderScope({ principal: granted, employeeId: EMP }).scope, 'mine');
  check('granted employee can widen', dealerOrderScope({ principal: granted, employeeId: EMP, requested: 'all' }).scope, 'all');
  check('granted employee all carries no filter', dealerOrderScope({ principal: granted, employeeId: EMP, requested: 'all' }).filter, {});
  check('granted employee can narrow again', dealerOrderScope({ principal: granted, employeeId: EMP, requested: 'mine' }).filter, { createdByEmployee: EMP });

  // The owner always sees everything, and may narrow to their own.
  check('owner defaults to all', dealerOrderScope({ principal: owner }).scope, 'all');
  check('owner all carries no filter', dealerOrderScope({ principal: owner }).filter, {});
  check('owner can narrow to their own', dealerOrderScope({ principal: owner, requested: 'mine' }).filter, { createdByEmployee: null });

  // A missing principal must fail closed, not open.
  check('no principal does not widen', dealerOrderScope({}).scope, 'mine');
  check('no principal is pinned to nothing', dealerOrderScope({}).filter, { createdByEmployee: null });
}

section('Order visibility is not granted by default');
check(
  'salesperson cannot see the whole dealer book',
  DEALER_ROLE_PRESETS.salesperson.includes('orders.viewAll'),
  false,
);
check(
  'manager can, since they cover the floor',
  DEALER_ROLE_PRESETS.manager.includes('orders.viewAll'),
  true,
);

// ── Target metrics ──────────────────────────────────────────────────────────
section('Dealer target metrics');
check('metrics are the supported set', [...DEALER_TARGET_METRICS], ['sales', 'orders', 'collections', 'product', 'category']);
check(
  'no visits metric for dealer employees (no data source)',
  DEALER_TARGET_METRICS.includes('visits'),
  false,
);
check(
  'product and category are the only scoped metrics',
  Object.entries(DEALER_METRIC_META).filter(([, meta]) => meta.scope).map(([key]) => key),
  ['product', 'category'],
);
check(
  'product and category are measured in boxes, not currency',
  [DEALER_METRIC_META.product.unit, DEALER_METRIC_META.category.unit],
  ['boxes', 'boxes'],
);
check('every metric has metadata', DEALER_TARGET_METRICS.filter((m) => !DEALER_METRIC_META[m]), []);
check('every period is trigger-mapped', DEALER_TARGET_PERIODS.every((p) => triggerEventForDealer('sales', p)), true);
check(
  'the four periods map to the expected trigger events',
  [
    triggerEventForDealer('sales', 'monthly'),
    triggerEventForDealer('orders', 'monthly'),
    triggerEventForDealer('collections', 'monthly'),
    triggerEventForDealer('product', 'monthly'),
  ],
  ['monthly_sales', 'order_created', 'collection_target', 'target_achieved'],
);

// ── Report ──────────────────────────────────────────────────────────────────
const bar = '='.repeat(62);
if (failures.length) {
  console.error(`\n${bar}\n  ${passed} passed, ${failures.length} FAILED\n${bar}`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error('');
  process.exit(1);
}
console.log(`\n${bar}\n  ${passed} passed, 0 failed\n${bar}\n`);
