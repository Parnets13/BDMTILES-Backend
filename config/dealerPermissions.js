/**
 * BDMTILES — Dealer Employee Permission System
 *
 * A dealer employee is NOT a BDMTILES employee. They are created by a dealer and
 * can only ever act inside that dealer's own account. This catalog is therefore
 * deliberately kept separate from config/permissions.js:
 *
 *   - The two are resolved against different principals and never mixed. A
 *     dealer employee's grants live on `DealerEmployee.permissions` and are read
 *     by `dealerPrincipalHasPermission`; a staff member's live on
 *     `User.permissions` and are read by `userHasPermission`. A DealerEmployee is
 *     not a User, and no route checks one principal against the other's catalog.
 *
 *   - Two ids do appear in both catalogs: `dashboard.view` and `reports.sales`.
 *     That is intentional and harmless — they mean the same thing on both sides,
 *     and neither confers money, admin or authoring power. What must never be
 *     shared is a PRIVILEGED id, and none is: every sensitive and finance id here
 *     is unique to this catalog. `scripts/validateDealerPermissions.mjs` asserts
 *     exactly that, so a future addition cannot quietly break it.
 *
 *   - The vocabulary is the one a dealer understands — View / Create / Edit /
 *     Order / Collection / Price View / Report View — not the ERP module names.
 *
 * The `owner` of a dealer account (the dealer itself) always has every
 * permission implicitly and is never listed as an employee.
 *
 * SENSITIVE FINANCE
 * `finance.ledger`, `finance.outstanding` and `finance.creditLimit` are marked
 * sensitive. They are:
 *   1. excluded from every role preset, so they are never granted by accident;
 *   2. additionally gated by Dealer.allowEmployeeFinanceAccess — BDMTILES can
 *      switch finance delegation off for a dealer entirely, in which case even
 *      an explicit grant is ignored (see resolveDealerEmployeePermissions).
 */

/**
 * Permission id format: `module.action`.
 *
 * `sensitive: true` means the permission touches money or credit standing and
 * must be granted explicitly — never inherited from a role preset.
 */
export const DEALER_AVAILABLE_PERMISSIONS = {
  'Dashboard': [
    { id: 'dashboard.view', name: 'Dashboard View', description: 'See the home summary for this dealer account.' },
  ],

  'Catalogue': [
    { id: 'catalogue.view', name: 'View Catalogue', description: 'Browse products, shades and batches.' },
    { id: 'catalogue.priceView', name: 'Price View', description: 'See rates. Without this, prices are hidden in the app.' },
    { id: 'catalogue.stockView', name: 'Stock View', description: 'See available quantity at the branch.' },
  ],

  'Orders': [
    { id: 'orders.view', name: 'View Orders', description: 'See your own order requests, orders and their status.' },
    // Without this, an employee sees only what they raised themselves. Granted,
    // they see every order on the dealer account — useful for a manager covering
    // for someone, but not something a salesperson needs by default.
    { id: 'orders.viewAll', name: 'View All Dealer Orders', description: 'See every order on this dealer account, not just your own.' },
    { id: 'orders.create', name: 'Create Order', description: 'Build a cart and start an order request.' },
    { id: 'orders.order', name: 'Place Order', description: 'Submit an order request to BDMTILES for approval.' },
    { id: 'orders.edit', name: 'Edit Order', description: 'Change an order request that has not been approved yet.' },
    { id: 'orders.cancel', name: 'Cancel Order', description: 'Cancel an order request or a pending order.' },
    { id: 'orders.shortfallRespond', name: 'Respond to Shortfall', description: 'Answer when BDMTILES can only supply part of a request.' },
  ],

  'Deliveries': [
    { id: 'deliveries.view', name: 'View Deliveries', description: 'Track dispatched goods and delivery status.' },
  ],

  'Payments & Collections': [
    { id: 'payments.view', name: 'View Payments', description: 'See payment history, receipts and credit/debit notes.' },
    { id: 'payments.collection', name: 'Record Collection', description: 'Submit a payment intimation with UTR or proof of payment.' },
  ],

  // Reserved. A dealer has no customer list of its own in this system — Customer
  // Master belongs to BDMTILES and is assigned to staff, not to dealers. The
  // permissions and `DealerEmployee.assignedCustomers` exist so the model is ready
  // when a dealer-owned customer list lands, but nothing enforces them today.
  //
  // `reserved: true` makes the app render the group as unavailable instead of
  // offering ticks that would grant nothing — a dealer ticking "Create Customer"
  // and finding no such feature is worse than the option not being offered.
  'Customers': [
    { id: 'customers.view', name: 'View Customers', description: 'See the customers assigned to this employee.', reserved: true },
    { id: 'customers.create', name: 'Create Customer', description: 'Add a customer record.', reserved: true },
    { id: 'customers.edit', name: 'Edit Customer', description: 'Change customer details.', reserved: true },
  ],

  'Complaints & Support': [
    { id: 'complaints.view', name: 'View Complaints', description: 'See complaints raised on this dealer account.' },
    { id: 'complaints.create', name: 'Raise Complaint', description: 'Raise a complaint with photo evidence.' },
    { id: 'chat.view', name: 'Support Chat', description: 'Chat with the BDMTILES sales executive.' },
  ],

  'Schemes & Rewards': [
    { id: 'schemes.view', name: 'View Schemes', description: 'See schemes running for this dealer.' },
    { id: 'points.view', name: 'View Points & Gifts', description: 'See points balance and claim gifts.' },
  ],

  'Reports': [
    { id: 'reports.view', name: 'Report View', description: 'Open the report section.' },
    { id: 'reports.sales', name: 'Sales Reports', description: 'See sales and purchase reports for this dealer.' },
    { id: 'reports.collection', name: 'Collection Reports', description: 'See collection reports.' },
  ],

  'Targets & Incentives': [
    // Employee-facing: see your own numbers.
    { id: 'targets.view', name: 'My Target', description: 'See own assigned targets and achievement.' },
    { id: 'incentives.view', name: 'My Incentive', description: 'See own eligible and earned incentive.' },
    // Dealer-facing: author and oversee. Deliberately absent from every role
    // preset — setting someone's target, and the money attached to it, is the
    // account holder's decision, not something a role should confer by default.
    { id: 'targets.manage', name: 'Assign Targets', description: 'Set and edit sales targets for employees.', sensitive: true },
    { id: 'incentives.manage', name: 'Configure Incentives', description: 'Create and edit incentive rules, and record payouts.', sensitive: true },
    { id: 'performance.view', name: 'View Team Performance', description: 'See every employee\'s targets, achievement and incentive.' },
  ],

  'Team': [
    { id: 'team.view', name: 'View Team', description: 'See the other employees on this dealer account.' },
    { id: 'team.create', name: 'Add Employee', description: 'Create a new employee login for this dealer.' },
    { id: 'team.edit', name: 'Edit Employee', description: 'Change employee details, role and permissions.' },
    { id: 'team.access', name: 'Manage Login & Access', description: 'Activate, deactivate and reset app access for employees.' },
  ],

  // Money and credit standing. Never part of a preset — see the header note.
  //
  // `finance: true` is a narrower marker than `sensitive: true`, and the two must
  // stay distinct: `sensitive` means "warn before granting, never inherit from a
  // preset", while `finance` means "this is money data, and BDMTILES can revoke it
  // wholesale with the dealer's allowEmployeeFinanceAccess policy". Marking target
  // authoring sensitive is right; letting a finance policy switch silently strip
  // it would not be.
  'Finance (Sensitive)': [
    { id: 'finance.ledger', name: 'Dealer Ledger', description: 'See the full dealer ledger.', sensitive: true, finance: true },
    { id: 'finance.outstanding', name: 'Outstanding', description: 'See outstanding balance and ageing.', sensitive: true, finance: true },
    { id: 'finance.creditLimit', name: 'Credit Limit', description: 'See credit limit and credit days.', sensitive: true, finance: true },
  ],
};

/** Flat list of every valid dealer-employee permission id. */
export const ALL_DEALER_PERMISSIONS = Object.values(DEALER_AVAILABLE_PERMISSIONS)
  .flat()
  .map((permission) => permission.id);

/**
 * Sensitive permissions and why they are sensitive. The app shows this warning
 * before a dealer ticks one, and the server refuses them entirely when the
 * dealer's `allowEmployeeFinanceAccess` policy is off.
 */
export const DEALER_SENSITIVE_PERMISSIONS = Object.fromEntries(
  Object.values(DEALER_AVAILABLE_PERMISSIONS)
    .flat()
    .filter((permission) => permission.sensitive)
    .map((permission) => [permission.id, permission.description]),
);

/** Everything marked sensitive. Warned about, and excluded from every preset. */
export const DEALER_SENSITIVE_PERMISSION_IDS = Object.keys(DEALER_SENSITIVE_PERMISSIONS);

/**
 * Permissions whose feature does not exist yet.
 *
 * They stay in the catalog so the data model is ready, but granting one achieves
 * nothing — so the app disables them rather than presenting a tick that silently
 * does no work.
 */
export const DEALER_RESERVED_PERMISSION_IDS = Object.values(DEALER_AVAILABLE_PERMISSIONS)
  .flat()
  .filter((permission) => permission.reserved)
  .map((permission) => permission.id);

/**
 * The subset that is actually money data, and therefore the subset the
 * `allowEmployeeFinanceAccess` policy governs.
 *
 * Deliberately narrower than the sensitive list: revoking finance delegation must
 * not also revoke a manager's ability to assign targets. Only these ids are
 * stripped when the policy is off.
 */
export const DEALER_FINANCE_PERMISSION_IDS = Object.values(DEALER_AVAILABLE_PERMISSIONS)
  .flat()
  .filter((permission) => permission.finance)
  .map((permission) => permission.id);

/** Permissions the dealer owner always holds, whatever the employee records say. */
export const DEALER_OWNER_PERMISSIONS = ['*'];

/**
 * Role presets a dealer can pick from when creating an employee.
 *
 * Every preset is a starting point the dealer can then fine-tune, except
 * `custom`, which starts empty. Sensitive finance permissions are intentionally
 * absent from all of them.
 */
export const DEALER_ROLE_PRESETS = {
  manager: [
    'dashboard.view',
    'catalogue.view', 'catalogue.priceView', 'catalogue.stockView',
    'orders.view', 'orders.viewAll', 'orders.create', 'orders.order', 'orders.edit', 'orders.cancel', 'orders.shortfallRespond',
    'deliveries.view',
    'payments.view', 'payments.collection',
    // No customers.* here: that module is reserved (see DEALER_RESERVED_PERMISSION_IDS).
    // A preset must never grant a permission with no feature behind it.
    'complaints.view', 'complaints.create', 'chat.view',
    'schemes.view', 'points.view',
    'reports.view', 'reports.sales', 'reports.collection',
    'targets.view', 'incentives.view',
    // A manager oversees the floor, so they see the team's numbers — but they
    // still cannot SET a target or an incentive (targets.manage /
    // incentives.manage stay owner-only unless granted explicitly).
    'performance.view',
    'team.view', 'team.create', 'team.edit',
  ],

  salesperson: [
    'dashboard.view',
    'catalogue.view', 'catalogue.priceView', 'catalogue.stockView',
    'orders.view', 'orders.create', 'orders.order', 'orders.edit', 'orders.cancel', 'orders.shortfallRespond',
    'deliveries.view',
    // No customers.* here — reserved module, see DEALER_RESERVED_PERMISSION_IDS.
    'complaints.view', 'complaints.create', 'chat.view',
    'schemes.view', 'points.view',
    'targets.view', 'incentives.view',
  ],

  accountant: [
    'dashboard.view',
    'catalogue.view',
    'orders.view',
    'deliveries.view',
    'payments.view', 'payments.collection',
    'reports.view', 'reports.sales', 'reports.collection',
    'targets.view', 'incentives.view',
  ],

  viewer: [
    'dashboard.view',
    'catalogue.view',
    'orders.view',
    'deliveries.view',
    'reports.view',
    'targets.view', 'incentives.view',
  ],

  // Starts empty — the dealer ticks exactly what this person needs.
  custom: [],
};

/** Display names for the role picker in the app. */
export const DEALER_ROLE_INFO = {
  manager: { name: 'Manager', description: 'Runs day-to-day orders, team and reports. No finance access.' },
  salesperson: { name: 'Salesperson', description: 'Takes orders, sees prices, manages customers and targets.' },
  accountant: { name: 'Accountant', description: 'Handles collections and reports. No ledger or credit access unless granted.' },
  viewer: { name: 'Viewer', description: 'Read-only access to orders, catalogue and reports.' },
  custom: { name: 'Custom', description: 'Choose each permission manually.' },
};

/** Dealer employees may never hold a wildcard; the owner already does. */
const stripWildcards = (permissions = []) => permissions.filter((permission) => permission !== '*');

/**
 * Resolve the effective permission list for an employee.
 *
 * `role_default` mode mirrors the staff User model: the role preset is applied
 * live, so changing what a preset means updates every employee using it.
 * `custom` mode uses the stored explicit list.
 *
 * Only FINANCE permissions are dropped when the dealer's policy forbids finance
 * delegation — `targets.manage` and `incentives.manage` are sensitive but not
 * finance, so a finance policy switch cannot silently take target authoring away.
 */
export const resolveDealerEmployeePermissions = (employee, dealer) => {
  if (!employee) return [];
  const explicit = stripWildcards(
    employee.permissionMode === 'role_default'
      ? DEALER_ROLE_PRESETS[employee.role] || []
      : employee.permissions || [],
  );
  const unique = [...new Set(explicit)];
  if (dealer?.allowEmployeeFinanceAccess === false) {
    return unique.filter((permission) => !DEALER_FINANCE_PERMISSION_IDS.includes(permission));
  }
  return unique;
};

/**
 * Permission check for a dealer-app principal.
 *
 * `principal` is what middleware/dealerAuth.js puts on the request:
 *   { isOwner: true }                                  — the dealer itself
 *   { isOwner: false, permissions: [...] }             — a dealer employee
 */
export const dealerPrincipalHasPermission = (principal, permission) => {
  if (!principal) return false;
  if (principal.isOwner) return true;
  const permissions = principal.permissions || [];
  if (permissions.includes('*')) return true;
  if (permissions.includes(permission)) return true;
  // Module wildcard, e.g. `orders.*` covers `orders.create`.
  const module = String(permission).split('.')[0];
  return permissions.includes(`${module}.*`);
};

/** Any-of check, used where a route accepts several capabilities. */
export const dealerPrincipalHasAnyPermission = (principal, permissions = []) =>
  permissions.some((permission) => dealerPrincipalHasPermission(principal, permission));

/**
 * Which slice of orders a principal may see.
 *
 * Lives here, next to the permission rules it depends on, rather than inside a
 * route — it is a security decision, and keeping it a pure function means it can
 * be asserted in scripts/validateDealerPermissions.mjs instead of only reasoned
 * about by reading the handler.
 *
 *   owner                      everything, and may narrow to `mine`
 *   employee with viewAll      everything, and may narrow to `mine`
 *   employee without viewAll   their own, always — `scope=all` is not honoured
 *
 * "Mine" for the owner means the records they raised personally, which are stored
 * with a null `createdByEmployee`. `{ field: null }` also matches documents where
 * the field is absent, which is exactly that set.
 *
 * @returns {{ scope: 'mine'|'all', filter: object }}
 */
export const dealerOrderScope = ({ principal = null, employeeId = null, requested = '' } = {}) => {
  const isOwner = Boolean(principal?.isOwner);
  const canSeeAll = dealerPrincipalHasPermission(principal, 'orders.viewAll');
  const raw = String(requested || '').toLowerCase();

  // Default: the owner sees everything, an employee sees their own.
  const wantsMine = raw === 'mine' || (!raw && !isOwner);
  const allowAll = isOwner || canSeeAll;

  if (wantsMine || !allowAll) {
    return { scope: 'mine', filter: { createdByEmployee: employeeId || null } };
  }
  return { scope: 'all', filter: {} };
};

/** Payload served to the app so it can render the permission editor. */
export const getDealerPermissionsConfig = (dealer) => ({
  permissions: DEALER_AVAILABLE_PERMISSIONS,
  rolePresets: DEALER_ROLE_PRESETS,
  roleInfo: DEALER_ROLE_INFO,
  sensitivePermissions: DEALER_SENSITIVE_PERMISSIONS,
  // The narrower money-only list. The app uses this — not the sensitive list — to
  // decide which group the finance policy hides, so that marking a permission
  // sensitive (for the warning badge) can never hide an unrelated group.
  financePermissions: DEALER_FINANCE_PERMISSION_IDS,
  // Ids whose feature is not built yet, so the editor can disable them.
  reservedPermissions: DEALER_RESERVED_PERMISSION_IDS,
  // Lets the app hide the finance section entirely rather than show options
  // that the server would silently drop.
  financeDelegationAllowed: dealer?.allowEmployeeFinanceAccess !== false,
});
