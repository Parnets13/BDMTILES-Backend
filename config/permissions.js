/**
 * BDMTILES Permission System
 * Format: module.action
 * 
 * Hierarchy: Brand → Category → Subcategory → ExtendedSubcategory
 */

export const AVAILABLE_PERMISSIONS = {
  "General": [
    { id: "dashboard.view", name: "Dashboard View" },
    { id: "system.management", name: "System Management" },
    { id: "users.manage", name: "User Management" },
    { id: "document.management", name: "Document Management" },
    { id: "task.management", name: "Task Management" },
    { id: "notification.inbox", name: "Notification Inbox" },
    { id: "notification.manage", name: "Notification Settings & Templates" },
    { id: "notification.audit", name: "Notification Delivery Audit" },
    { id: "access.policy.manage", name: "Historical Access Policy Management" },
    { id: "dealer.app.manage", name: "Dealer Mobile App Access Control" },
  ],
  "Web Management": [
    { id: "webmanagement.manage", name: "Web Management (Storefront CMS)" },
    { id: "wallet.manage", name: "BDM Cash Wallet Management" },
  ],
  "Master Management": [
    { id: "product.master", name: "Product Master" },
    { id: "products.create", name: "Create Products" },
    { id: "products.update", name: "Edit Products" },
    { id: "products.delete", name: "Delete Products" },
    { id: "category.setup", name: "Category Setup (Brand/Category/Subcategory)" },
    { id: "dealer.master", name: "Dealer Master" },
    { id: "dealer.assignment.manage", name: "Assign Sales Executives to Dealers" },
    // Targets a dealer sets for its own employees. Viewing rides along with
    // dealer.master on the routes so staff who can already see a dealer's
    // employees are not locked out of the new page; overriding needs the
    // explicit manage grant.
    { id: "dealer.employee.targets.view", name: "View Dealer Employee Targets" },
    { id: "dealer.employee.targets.manage", name: "Set / Override Dealer Employee Targets" },
    { id: "customer.master", name: "Customer Master" },
    { id: "dealer.type", name: "Dealer Type" },
    { id: "dealer.category", name: "Dealer Category" },
    { id: "supplier.master", name: "Supplier Master" },
    { id: "employee.master", name: "Employee Master" },
    { id: "branch.master", name: "Branch Master" },
    { id: "warehouse.master", name: "Warehouse Master" },
    { id: "vehicle.master", name: "Vehicle Master" },
    { id: "region.master", name: "Region Master" },
    { id: "route.master", name: "Route Master" },
    { id: "expense.category", name: "Expense Category" },
    { id: "price.list", name: "Price List Management" },
  ],
  "CRM": [
    { id: "lead.management", name: "Lead Management (Legacy Aggregate)" },
    { id: "lead.view", name: "View Leads" },
    { id: "lead.create", name: "Create Leads" },
    { id: "lead.update", name: "Update Leads" },
    { id: "lead.assign", name: "Assign Leads" },
    { id: "lead.app", name: "Lead App / My Leads" },
    { id: "lead.respond", name: "Accept or Decline Assigned Leads" },
    { id: "lead.followup", name: "Record Lead Follow-ups" },
    { id: "lead.convert", name: "Convert Leads" },
    { id: "lead.delete", name: "Delete Leads" },
    { id: "followup.management", name: "Follow-up Management" },
    { id: "quotation.management", name: "Quotation Management" },
    { id: "complaint.management", name: "Complaint Management" },
  ],
  "Sales & Purchase": [
    { id: "sales.order.dashboard", name: "Sales Order Dashboard" },
    { id: "sales.order.create", name: "Create Sales Orders" },
    { id: "sales.order.approve", name: "Approve Sales Orders" },
    { id: "sales.order.dealer", name: "Create Dealer Sales Orders" },
    { id: "sales.order.wholesaler", name: "Create Wholesaler Sales Orders" },
    { id: "sales.order.retail", name: "Create Retail Sales Orders" },
    { id: "sales.order.distributor", name: "Create Distributor Sales Orders" },
    { id: "sales.order.builder", name: "Create Builder/Architect Sales Orders" },
    { id: "quotation.dealer", name: "Create Dealer Quotations" },
    { id: "quotation.wholesaler", name: "Create Wholesaler Quotations" },
    { id: "quotation.retail", name: "Create Retail Quotations" },
    { id: "quotation.distributor", name: "Create Distributor Quotations" },
    { id: "quotation.builder", name: "Create Builder/Architect Quotations" },
    { id: "dealer.discounts", name: "Dealer-Specific Discounts" },
    { id: "po.management", name: "Purchase Order Management" },
    { id: "po.approve", name: "Approve Purchase Orders" },
    { id: "grn.entry", name: "GRN Entry" },
    { id: "grn.approve", name: "Approve Goods Receipts" },
    { id: "invoice", name: "Invoice Management" },
    { id: "payment", name: "Payment Management" },
    { id: "credit.note", name: "Credit Note" },
    { id: "debit.note", name: "Debit Note" },
    { id: "recycle.bin", name: "Recycle Bin (All)" },
    { id: "recycle.bin.view", name: "View Recycle Bin" },
    { id: "recycle.bin.restore", name: "Restore from Bin" },
    { id: "recycle.bin.purge", name: "Permanently Delete from Bin" },
  ],
  "Inventory & Warehouse": [
    { id: "stock.view", name: "View Stock" },
    { id: "stock.transfer", name: "Stock Transfer" },
    { id: "stock.adjustment", name: "Stock Adjustment (Legacy Create/Submit Alias)" },
    { id: "stock.adjustment.create", name: "Create Stock Adjustments" },
    { id: "stock.adjustment.submit", name: "Submit Stock Adjustments" },
    { id: "stock.adjustment.approve", name: "Approve / Reject Stock Adjustments" },
    { id: "stock.adjustment.reverse", name: "Reverse Stock Adjustments" },
    { id: "stock.audit.create", name: "Create Physical Audits" },
    { id: "stock.audit.count", name: "Record Physical Counts" },
    { id: "stock.audit.submit", name: "Submit Physical Audits" },
    { id: "stock.audit.approve", name: "Approve / Reject Physical Audits" },
    { id: "stock.audit.reverse", name: "Reverse Physical Audits" },
    { id: "dispatch.return", name: "Dispatched Goods Recovery" },
    { id: "warehouse.verification", name: "Warehouse Complaint Verification" },
  ],
  // Capabilities for the BDM Tiles Picking & Sorting mobile app. Each maps to a
  // feature in the app: Picking, Sorting, and Loading (vehicle dispatch) verification.
  "Picking & Sorting App": [
    { id: "picking.management", name: "Picking — assign, pick, barcode/shade/batch verify" },
    { id: "sorting.management", name: "Sorting — verify, pack, mark ready for dispatch" },
    { id: "dispatch.management", name: "Loading — scan-verify items onto the vehicle" },
    { id: "dispatch.verify", name: "Loading — final dispatch verification" },
  ],
  "Finance & Accounts": [
    { id: "finance.management", name: "Finance Management" },
    { id: "dealer.ledger", name: "Dealer Ledger" },
    { id: "supplier.ledger", name: "Supplier Ledger" },
    { id: "cheque.management", name: "Cheque Management (Legacy Aggregate)" },
    { id: "cheque.view", name: "View Cheques" },
    { id: "cheque.create", name: "Record Cheques" },
    { id: "cheque.deposit", name: "Deposit Cheques" },
    { id: "cheque.clear", name: "Clear Cheques" },
    { id: "cheque.bounce", name: "Bounce Cheques" },
    { id: "cheque.return", name: "Return / Re-deposit Cheques" },
    { id: "reconciliation", name: "Auto Reconciliation" },
    { id: "expense.management", name: "Expense Management" },
    { id: "expense.approve", name: "Expense Approval" },
  ],
  "HRMS": [
    { id: "hrms.management", name: "HRMS Management" },
    { id: "attendance.master", name: "Attendance Master" },
    { id: "leave.management", name: "Leave Management" },
    { id: "salary.management", name: "Salary Management" },
    { id: "employee.registration", name: "Employee Registration" },
    { id: "job.opening.manage", name: "Job Opening Management" },
    { id: "candidate.manage", name: "Candidate Recruitment Management" },
    { id: "candidate.interview", name: "Schedule / Conduct Candidate Interviews" },
    { id: "candidate.convert", name: "Convert Candidate to Employee" },
    { id: "hr.template.manage", name: "HR Document Template Management" },
    { id: "employee.exit", name: "Employee Exit & Full-and-Final Settlement" },
    { id: "performance.appraisal", name: "Employee Performance Appraisal" },
  ],
  "Reports": [
    { id: "reports.sales", name: "Sales Reports" },
    { id: "reports.purchase", name: "Purchase Reports" },
    { id: "reports.inventory", name: "Inventory Reports" },
    { id: "reports.finance", name: "Finance Reports" },
    { id: "reports.profit", name: "Profit Analysis" },
    { id: "reports.gst", name: "GST Reports" },
    { id: "reports.hr", name: "HR Reports" },
    { id: "activity.logs", name: "Activity Logs" },
    { id: "download.logs", name: "Download Logs" },
    { id: "audit.trail", name: "Audit Trail" },
  ],
  "Schemes": [
    { id: "supplier.scheme", name: "Supplier Scheme Management (Legacy Aggregate)" },
    { id: "dealer.scheme", name: "Dealer Scheme Management (Legacy Aggregate)" },
    { id: "scheme.entry", name: "Scheme Entry" },
    { id: "scheme.analysis", name: "Scheme Analysis" },
    { id: "claim.submission", name: "Scheme Claim Submission" },
    { id: "incentive.reconciliation", name: "Incentive Reconciliation" },
    { id: "incentive.rules.view", name: "View Incentive Rules" },
    { id: "incentive.rules.manage", name: "Manage Incentive Rules" },
    { id: "incentive.earnings.view", name: "View Incentive Earnings" },
    { id: "incentive.earnings.record", name: "Record / Calculate Incentive Earnings" },
    { id: "incentive.earnings.approve", name: "Approve Incentive Earnings" },
    { id: "incentive.earnings.pay", name: "Pay Incentive Earnings" },
    { id: "incentive.earnings.self", name: "View Own Incentive Earnings" },
  ],
  "Delivery": [
    { id: "delivery.management", name: "Delivery Management (Legacy Aggregate)" },
    { id: "delivery.view", name: "View Deliveries" },
    { id: "delivery.assignment", name: "Delivery Assignment" },
    { id: "delivery.execute", name: "Start / Reach Delivery" },
    { id: "delivery.verify", name: "Delivery OTP Verification" },
    { id: "delivery.complete", name: "Complete Delivery" },
    { id: "delivery.exception", name: "Authorize OTP / POD Exception" },
    { id: "delivery.fail", name: "Fail / Reschedule Delivery" },
    { id: "delivery.tracking", name: "Live Tracking" },
  ],
  "Apps": [
    { id: "sales.executive.app", name: "Sales Executive App" },
    { id: "se.attendance.view", name: "SE Attendance / Visits / Assignment" },
    { id: "se.route.plan", name: "SE Route Planning" },
    { id: "se.dealer.insights", name: "SE Dealer Insights" },
    { id: "se.collections.view", name: "SE Collections" },
    { id: "se.targets.view", name: "SE Targets" },
    { id: "delivery.executive.app", name: "Delivery Executive App" },
    { id: "de.assignment.manage", name: "DE Assignment" },
    { id: "de.monitoring.view", name: "DE Monitoring" },
    { id: "de.deliveries.view", name: "DE Deliveries" },
    { id: "de.tracking.view", name: "DE Tracking" },
    { id: "de.route.view", name: "DE Route Plan" },
    { id: "de.collections.view", name: "DE Collections" },
    { id: "de.history.view", name: "DE History" },
    { id: "dealer.order.requests", name: "Dealer Order Requests (Legacy)" },
    { id: "dealer.order_request.create", name: "Create Dealer Order Requests" },
    { id: "dealer.order_request.review", name: "Review Dealer Order Requests" },
    { id: "dealer.order_request.approve", name: "Approve / Reject Dealer Order Requests" },
    { id: "support.chat", name: "Support Chat" },
  ],
  "Assets": [
    { id: "asset.management", name: "Asset Management (Master / Assignment / Maintenance)" },
  ],
  "Tally": [
    { id: "tally.sync", name: "Tally Sync Management" },
    { id: "tally.reconciliation", name: "Tally Reconciliation" },
  ],
};

/**
 * Default permissions per role (assigned on user creation).
 * Super Admin and Owner get ALL access via auth middleware bypass.
 * These presets are applied when creating a user with that role.
 */
export const ROLE_DEFAULT_PERMISSIONS = {
  super_admin: ['*'],  // All access — bypasses permission check in middleware
  owner: ['*'],        // All access — bypasses permission check in middleware
  admin: [
    'dashboard.view', 'system.management', 'users.manage', 'document.management', 'task.management',
    'notification.inbox', 'webmanagement.manage', 'wallet.manage', 'dealer.app.manage',
    'product.master', 'products.create', 'products.update', 'products.delete',
    'category.setup', 'dealer.master', 'dealer.assignment.manage', 'customer.master', 'dealer.type', 'dealer.category',
    'dealer.employee.targets.view', 'dealer.employee.targets.manage',
    'supplier.master', 'employee.master', 'branch.master', 'warehouse.master', 'vehicle.master',
    'region.master', 'route.master', 'expense.category', 'price.list',
    'lead.management', 'lead.view', 'lead.create', 'lead.update', 'lead.assign', 'lead.app',
    'lead.respond', 'lead.followup', 'lead.convert', 'lead.delete',
    'quotation.management',
    'quotation.dealer', 'quotation.wholesaler', 'quotation.retail', 'quotation.distributor', 'quotation.builder',
    'sales.order.dashboard', 'sales.order.create', 'sales.order.approve',
    'sales.order.dealer', 'quotation.wholesaler', 'sales.order.retail', 'sales.order.distributor', 'sales.order.builder',
    'po.management', 'po.approve', 'grn.entry', 'grn.approve', 'invoice', 'payment',
    'credit.note', 'debit.note', 'recycle.bin', 'dispatch.return',
    'stock.view', 'stock.transfer', 'stock.adjustment',
    'stock.adjustment.create', 'stock.adjustment.submit', 'stock.adjustment.approve', 'stock.adjustment.reverse',
    'stock.audit.create', 'stock.audit.count', 'stock.audit.submit', 'stock.audit.approve', 'stock.audit.reverse', 'dispatch.return',
    'picking.management', 'sorting.management',
    'dispatch.management', 'dispatch.verify', 'warehouse.verification', 'delivery.management', 'delivery.view', 'delivery.assignment',
    'delivery.execute', 'delivery.verify', 'delivery.complete', 'delivery.exception', 'delivery.fail',
    'finance.management', 'dealer.ledger', 'supplier.ledger',
    'cheque.management', 'cheque.view', 'cheque.create', 'cheque.deposit', 'cheque.clear', 'cheque.bounce', 'cheque.return',
    'reconciliation', 'expense.management', 'expense.approve',
    'hrms.management', 'attendance.master', 'leave.management', 'salary.management', 'employee.registration',
    'job.opening.manage', 'candidate.manage', 'candidate.interview', 'candidate.convert', 'hr.template.manage',
    'employee.exit', 'performance.appraisal',
    'reports.sales', 'reports.purchase', 'reports.inventory', 'reports.finance',
    'reports.profit', 'reports.gst', 'reports.hr', 'activity.logs', 'audit.trail',
    'supplier.scheme', 'dealer.scheme', 'scheme.entry', 'scheme.analysis', 'claim.submission',
    'incentive.reconciliation', 'incentive.rules.view', 'incentive.rules.manage',
    'incentive.earnings.view', 'incentive.earnings.record', 'incentive.earnings.approve', 'incentive.earnings.pay',
    'asset.management',
  ],
  sub_admin: [
    'dashboard.view', 'notification.inbox', 'webmanagement.manage', 'document.management', 'task.management', 'complaint.management', 'product.master', 'category.setup',
    'dealer.master', 'dealer.assignment.manage', 'supplier.master',
    'quotation.management', 'dealer.discounts',
    'dealer.order_request.review', 'dealer.order_request.approve',
    'sales.order.dashboard', 'sales.order.create', 'sales.order.approve',
    'po.management', 'po.approve', 'grn.entry', 'grn.approve', 'invoice', 'payment',
    'stock.view', 'stock.transfer',
    'dispatch.management', 'dispatch.verify', 'delivery.management', 'delivery.view',
    'finance.management', 'dealer.ledger', 'supplier.ledger',
    'reports.sales', 'reports.purchase', 'reports.inventory',
  ],
  sales_manager: [
    'dashboard.view', 'notification.inbox', 'task.management', 'complaint.management', 'product.master', 'dealer.master', 'dealer.assignment.manage', 'dealer.type', 'dealer.category',
    'lead.management', 'lead.view', 'lead.create', 'lead.update', 'lead.assign',
    'lead.followup', 'lead.convert', 'followup.management', 'quotation.management',
    // Sales managers see what dealers have set their staff, but do not override
    // it — that stays with admin/owner.
    'dealer.employee.targets.view',
    'quotation.dealer', 'quotation.wholesaler', 'quotation.retail', 'quotation.distributor', 'quotation.builder',
    'sales.order.dashboard', 'sales.order.create', 'sales.order.approve',
    'sales.order.dealer', 'sales.order.wholesaler', 'sales.order.retail',
    'sales.order.distributor', 'sales.order.builder',
    'dealer.discounts', 'invoice', 'payment', 'credit.note', 'dispatch.return',
    'reports.sales', 'reports.profit',
    'sales.executive.app', 'dealer.order.requests',
    'dealer.order_request.review', 'dealer.order_request.approve',
    'dealer.scheme', 'scheme.entry', 'scheme.analysis', 'claim.submission',
  ],
  purchase_manager: [
    'dashboard.view', 'notification.inbox', 'task.management', 'product.master', 'products.create', 'products.update',
    'category.setup', 'supplier.master', 'price.list',
    'po.management', 'po.approve', 'grn.entry', 'grn.approve', 'invoice', 'payment', 'debit.note',
    'stock.view', 'stock.transfer', 'stock.adjustment',
    'stock.adjustment.create', 'stock.adjustment.submit', 'stock.adjustment.approve', 'stock.adjustment.reverse',
    'stock.audit.create', 'stock.audit.count', 'stock.audit.submit', 'stock.audit.approve', 'stock.audit.reverse', 'dispatch.return',
    'reports.purchase', 'reports.inventory',
    'supplier.scheme', 'scheme.entry', 'scheme.analysis', 'claim.submission', 'incentive.reconciliation',
  ],
  warehouse_manager: [
    'dashboard.view', 'notification.inbox', 'task.management', 'stock.view', 'stock.transfer', 'stock.adjustment', 'dispatch.return',
    'picking.management', 'sorting.management', 'warehouse.verification',
    'dispatch.management', 'dispatch.verify', 'delivery.management', 'delivery.view', 'delivery.assignment',
    'delivery.exception',
    'warehouse.master', 'vehicle.master',
    'reports.inventory',
  ],
  finance_manager: [
    'dashboard.view', 'notification.inbox', 'task.management', 'finance.management',
    'dealer.ledger', 'supplier.ledger', 'cheque.management', 'cheque.view', 'cheque.create',
    'cheque.deposit', 'cheque.clear', 'cheque.bounce', 'cheque.return',
    'reconciliation', 'expense.management', 'expense.approve',
    'payment', 'invoice', 'credit.note', 'debit.note',
    'incentive.earnings.view', 'incentive.earnings.approve', 'incentive.earnings.pay',
    'reports.finance', 'reports.gst', 'reports.profit', 'reports.sales',
    'tally.sync', 'tally.reconciliation',
    'asset.management',
  ],
  hr_manager: [
    'dashboard.view', 'notification.inbox', 'task.management', 'hrms.management',
    'attendance.master', 'leave.management', 'salary.management',
    'employee.registration', 'employee.master',
    'job.opening.manage', 'candidate.manage', 'candidate.interview', 'candidate.convert', 'hr.template.manage',
    'employee.exit', 'performance.appraisal',
    'expense.management', 'expense.approve',
    'reports.hr',
  ],
  sales_executive: [
    'dashboard.view', 'notification.inbox', 'complaint.management', 'product.master', 'dealer.master',
    'lead.app', 'lead.view', 'lead.create', 'lead.respond', 'lead.followup', 'followup.management',
    'incentive.earnings.self',
    'sales.order.create', 'sales.order.dashboard',
    'sales.order.dealer', 'sales.order.wholesaler', 'sales.order.retail', 'sales.order.distributor', 'sales.order.builder',
    'quotation.management',
    'quotation.dealer', 'quotation.wholesaler', 'quotation.retail', 'quotation.distributor', 'quotation.builder',
    'sales.executive.app', 'se.attendance.view', 'se.route.plan', 'se.dealer.insights',
    'se.collections.view', 'se.targets.view', 'dealer.order_request.create',
  ],
  delivery_executive: [
    'dashboard.view', 'notification.inbox',
    'delivery.executive.app', 'de.deliveries.view', 'de.tracking.view', 'de.route.view',
    'de.collections.view', 'de.history.view',
    'delivery.view', 'delivery.execute', 'delivery.verify', 'delivery.complete', 'delivery.fail', 'delivery.tracking', 'dispatch.return',
  ],
  // Floor picker — picks and can sort. Does NOT handle vehicle loading/dispatch.
  picking_staff: [
    'dashboard.view', 'notification.inbox',
    'picking.management', 'sorting.management',
    'stock.view',
  ],
  // Sorting + loading staff — sorts, packs, and verifies vehicle loading/dispatch.
  sorting_staff: [
    'dashboard.view', 'notification.inbox',
    'sorting.management',
    'dispatch.management', 'dispatch.verify',
    'stock.view',
  ],
  dealer: [
    'notification.inbox', 'dealer.order.requests', 'support.chat',
  ],
};

/**
 * Role display names and descriptions for the UI
 */
export const ROLE_INFO = {
  super_admin: { name: 'Super Admin', description: 'Full unrestricted access to everything', color: '#ff4d4f', rank: 100 },
  owner: { name: 'Owner', description: 'Full access — business owner', color: '#722ed1', rank: 90 },
  admin: { name: 'Admin', description: 'All modules except system-critical settings', color: '#1890ff', rank: 80 },
  sub_admin: { name: 'Sub Admin', description: 'Core operations without HR/finance deep access', color: '#13c2c2', rank: 70 },
  sales_manager: { name: 'Sales Manager', description: 'Sales orders, quotations, leads, dealer management', color: '#fa8c16', rank: 50 },
  purchase_manager: { name: 'Purchase Manager', description: 'PO, GRN, supplier management, stock', color: '#52c41a', rank: 50 },
  warehouse_manager: { name: 'Warehouse Manager', description: 'Stock, picking, sorting, dispatch, delivery', color: '#2f54eb', rank: 50 },
  finance_manager: { name: 'Finance & Accounts', description: 'Ledger, payments, cheques, reconciliation, GST', color: '#eb2f96', rank: 50 },
  hr_manager: { name: 'HR Manager', description: 'Employees, attendance, leave, salary, expenses', color: '#faad14', rank: 50 },
  sales_executive: { name: 'Sales Executive', description: 'Field sales, leads, quotations, orders', color: '#ff7a45', rank: 30 },
  delivery_executive: { name: 'Delivery Executive', description: 'Delivery assignments and tracking', color: '#36cfc9', rank: 30 },
  picking_staff: { name: 'Picking Staff', description: 'Warehouse picking and sorting, stock view', color: '#9254de', rank: 20 },
  sorting_staff: { name: 'Sorting / Loading Staff', description: 'Sorting, packing, and vehicle loading / dispatch verification', color: '#597ef7', rank: 20 },
  dealer: { name: 'Dealer (App)', description: 'Dealer portal — orders and support', color: '#73d13d', rank: 10 },
};

/**
 * Aggregate permissions that stand in for a set of granular ones.
 *
 * Holding the aggregate satisfies a check for any of its children. This is what
 * makes it safe to start enforcing a granular permission on a route that used to
 * accept only the aggregate: every account that works today keeps working, because
 * `ROLE_DEFAULT_PERMISSIONS` is only consulted for accounts in `role_default` mode
 * and most accounts store an explicit permission array that will never gain the
 * new id on its own.
 *
 * Resolution is one-directional: the aggregate implies the children, never the
 * reverse. So a route that still demands the aggregate will reject an account that
 * holds only a child — which is why route-level gates also have to accept the
 * children explicitly (see requireAnyPermission use in productRoutes/quotationRoutes).
 *
 * This is the single source of truth. middleware/auth.js imports it, and it is
 * served to the frontend through GET /users/permissions-config.
 */
export const PERMISSION_ALIASES = {
  'lead.management': ['lead.view', 'lead.create', 'lead.update', 'lead.assign', 'lead.app', 'lead.respond', 'lead.followup', 'lead.convert', 'lead.delete'],
  'cheque.management': ['cheque.view', 'cheque.create', 'cheque.deposit', 'cheque.clear', 'cheque.bounce', 'cheque.return'],
  'delivery.management': ['delivery.view', 'delivery.execute', 'delivery.verify', 'delivery.complete', 'delivery.fail'],

  // Product write access used to be one blanket grant; the granular ids existed but
  // enforced nothing. Note the module prefix differs (`product.master` vs
  // `products.create`), so the `product.*` wildcard does NOT cover these.
  'product.master': ['products.create', 'products.update', 'products.delete'],

  // Follow-ups are recorded through lead routes, which gate on `lead.followup`.
  'followup.management': ['lead.followup'],

  // A duplicate of employee.registration in everything but name.
  'employee.master': ['employee.registration'],

  // Scheme aggregates. Each also restricts *which party's* schemes you may manage —
  // see the per-path gates in routes/schemeRoutes.js.
  'supplier.scheme': ['scheme.entry', 'scheme.analysis', 'claim.submission'],
  'dealer.scheme': ['scheme.entry', 'scheme.analysis', 'claim.submission'],

  // Customer-type scoping for quotations and orders. Holding the aggregate lets you
  // transact every type; holding only a granular one limits you to that type.
  'quotation.management': ['quotation.dealer', 'quotation.wholesaler', 'quotation.retail', 'quotation.distributor', 'quotation.builder'],
  'sales.order.create': ['sales.order.dealer', 'sales.order.wholesaler', 'sales.order.retail', 'sales.order.distributor', 'sales.order.builder'],

  // Deliberately maps to `create` only. The `dealer` role holds this aggregate, and
  // expanding it to review/approve would let dealers approve their own requests.
  'dealer.order.requests': ['dealer.order_request.create'],

  // Recycle-bin aggregates. The bin previously required users.manage, which is
  // control over the user directory. Now grantable separately.
  'recycle.bin': ['recycle.bin.view', 'recycle.bin.restore', 'recycle.bin.purge'],
};

/** Customer-type scoping for quotations and sales orders. */
export const CUSTOMER_TYPES = ['dealer', 'wholesaler', 'retail', 'distributor', 'builder'];

export const QUOTATION_TYPE_PERMISSIONS = CUSTOMER_TYPES.map((type) => `quotation.${type}`);
export const SALES_ORDER_TYPE_PERMISSIONS = CUSTOMER_TYPES.map((type) => `sales.order.${type}`);

/**
 * DealerType has no stable code field — `name` is free text an admin can rename —
 * so the only reliable discriminator is the `pricingTier` enum.
 */
export const PRICING_TIER_TO_CUSTOMER_TYPE = {
  dealerRate: 'dealer',
  wholesaleRate: 'wholesaler',
  retailRate: 'retail',
  distributorRate: 'distributor',
  builderRate: 'builder',
  // projectRate has no customerType counterpart on Quotation, so it stays unmapped
  // and falls through to the aggregate check rather than being denied.
};

/**
 * Permissions that grant approval authority, move money, or administer the system.
 * Granting one of these does not just reveal a screen — it lets the holder sign off
 * on their own work or change who else can do anything. The UI warns before
 * granting them; nothing here changes how they are enforced.
 */
export const SENSITIVE_PERMISSIONS = {
  // Administrative control
  'system.management': 'Can change system-level settings.',
  'users.manage': 'Can create users and change anyone\'s permissions, including their own team\'s.',
  'access.policy.manage': 'Can change how far back other users may see historical data.',
  'notification.manage': 'Can change who is notified about what.',
  'dealer.app.manage': 'Can grant or revoke Dealer App sign-in for any dealer.',
  'recycle.bin': 'Can permanently destroy deleted records.',

  // Approval authority — the holder can sign off on work
  'sales.order.approve': 'Can approve sales orders, including below-minimum prices.',
  'po.approve': 'Can approve purchase orders.',
  'grn.approve': 'Can approve goods receipts.',
  'stock.adjustment.approve': 'Can approve stock adjustments, which change recorded quantities.',
  'stock.adjustment.reverse': 'Can reverse posted stock adjustments.',
  'stock.audit.approve': 'Can approve physical stock audits.',
  'stock.audit.reverse': 'Can reverse posted physical audits.',
  'expense.approve': 'Can approve expense claims.',
  'incentive.earnings.approve': 'Can approve incentive payouts.',
  'incentive.earnings.pay': 'Can mark incentive payouts as paid.',
  'dealer.order_request.approve': 'Can approve dealer order requests.',
  'dealer.employee.targets.manage': 'Can set or override the targets a dealer gives its own employees.',

  // Money and pricing
  'finance.management': 'Full access to ledgers, payments and financial records.',
  'dealer.discounts': 'Can set dealer-specific prices and discounts.',
  'credit.note': 'Can issue credit notes, which reduce what a dealer owes.',
  'debit.note': 'Can issue debit notes.',
  'reconciliation': 'Can reconcile bank and ledger balances.',
  'wallet.manage': 'Can adjust customer wallet balances.',

  // People and pay
  'salary.management': 'Can see and change salary figures.',
  'employee.exit': 'Can terminate employees and settle final dues.',
  'performance.appraisal': 'Can record performance ratings that affect increments.',

  // Deletion
  'products.delete': 'Can delete products.',
  'lead.delete': 'Can delete leads.',
};

/**
 * Get permissions config for frontend (User Management UI)
 */
export const getPermissionsConfig = () => ({
  permissions: AVAILABLE_PERMISSIONS,
  rolePermissions: ROLE_DEFAULT_PERMISSIONS,
  roleInfo: ROLE_INFO,
  sensitivePermissions: SENSITIVE_PERMISSIONS,
});
