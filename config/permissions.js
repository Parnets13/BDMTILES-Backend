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
  ],
  "Master Management": [
    { id: "product.master", name: "Product Master" },
    { id: "products.create", name: "Create Products" },
    { id: "products.update", name: "Edit Products" },
    { id: "products.delete", name: "Delete Products" },
    { id: "category.setup", name: "Category Setup (Brand/Category/Subcategory)" },
    { id: "dealer.master", name: "Dealer Master" },
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
    { id: "lead.management", name: "Lead Management" },
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
    { id: "grn.entry", name: "GRN Entry" },
    { id: "invoice", name: "Invoice Management" },
    { id: "payment", name: "Payment Management" },
    { id: "credit.note", name: "Credit Note" },
    { id: "debit.note", name: "Debit Note" },
    { id: "recycle.bin", name: "Recycle Bin Access" },
  ],
  "Inventory & Warehouse": [
    { id: "stock.view", name: "View Stock" },
    { id: "stock.transfer", name: "Stock Transfer" },
    { id: "stock.adjustment", name: "Stock Adjustment" },
    { id: "picking.management", name: "Picking Management" },
    { id: "sorting.management", name: "Sorting Management" },
    { id: "dispatch.management", name: "Dispatch Management" },
  ],
  "Finance & Accounts": [
    { id: "finance.management", name: "Finance Management" },
    { id: "dealer.ledger", name: "Dealer Ledger" },
    { id: "supplier.ledger", name: "Supplier Ledger" },
    { id: "cheque.management", name: "Cheque Management" },
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
    { id: "supplier.scheme", name: "Supplier Scheme Management" },
    { id: "dealer.scheme", name: "Dealer Scheme Management" },
  ],
  "Delivery": [
    { id: "delivery.management", name: "Delivery Management" },
    { id: "delivery.assignment", name: "Delivery Assignment" },
    { id: "delivery.tracking", name: "Live Tracking" },
  ],
  "Apps": [
    { id: "sales.executive.app", name: "Sales Executive App" },
    { id: "delivery.executive.app", name: "Delivery Executive App" },
    { id: "dealer.order.requests", name: "Dealer Order Requests" },
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
    'product.master', 'products.create', 'products.update', 'products.delete',
    'category.setup', 'dealer.master', 'dealer.type', 'dealer.category',
    'supplier.master', 'employee.master', 'branch.master', 'warehouse.master', 'vehicle.master',
    'region.master', 'route.master', 'expense.category', 'price.list',
    'lead.management', 'followup.management', 'quotation.management', 'complaint.management',
    'sales.order.dashboard', 'sales.order.create', 'sales.order.approve',
    'dealer.discounts', 'po.management', 'grn.entry', 'invoice', 'payment',
    'credit.note', 'debit.note', 'recycle.bin',
    'stock.view', 'stock.transfer', 'stock.adjustment',
    'picking.management', 'sorting.management',
    'dispatch.management', 'delivery.management', 'delivery.assignment',
    'finance.management', 'dealer.ledger', 'supplier.ledger',
    'cheque.management', 'reconciliation', 'expense.management', 'expense.approve',
    'hrms.management', 'attendance.master', 'leave.management', 'salary.management', 'employee.registration',
    'reports.sales', 'reports.purchase', 'reports.inventory', 'reports.finance',
    'reports.profit', 'reports.gst', 'reports.hr', 'activity.logs', 'audit.trail',
    'supplier.scheme', 'dealer.scheme', 'asset.management',
  ],
  sub_admin: [
    'dashboard.view', 'document.management', 'task.management', 'complaint.management', 'product.master', 'category.setup',
    'dealer.master', 'supplier.master',
    'sales.order.dashboard', 'sales.order.create', 'sales.order.approve',
    'po.management', 'grn.entry', 'invoice', 'payment',
    'stock.view', 'stock.transfer',
    'dispatch.management', 'delivery.management',
    'finance.management', 'dealer.ledger', 'supplier.ledger',
    'reports.sales', 'reports.purchase', 'reports.inventory',
  ],
  sales_manager: [
    'dashboard.view', 'task.management', 'complaint.management', 'product.master', 'dealer.master', 'dealer.type', 'dealer.category',
    'lead.management', 'followup.management', 'quotation.management',
    'sales.order.dashboard', 'sales.order.create', 'sales.order.approve',
    'sales.order.dealer', 'sales.order.wholesaler', 'sales.order.retail',
    'sales.order.distributor', 'sales.order.builder',
    'quotation.dealer', 'quotation.wholesaler', 'quotation.retail',
    'dealer.discounts', 'invoice', 'payment', 'credit.note',
    'reports.sales', 'reports.profit',
    'sales.executive.app', 'dealer.order.requests',
  ],
  purchase_manager: [
    'dashboard.view', 'task.management', 'product.master', 'products.create', 'products.update',
    'category.setup', 'supplier.master', 'price.list',
    'po.management', 'grn.entry', 'invoice', 'payment', 'debit.note',
    'stock.view', 'stock.transfer', 'stock.adjustment',
    'reports.purchase', 'reports.inventory',
    'supplier.scheme',
  ],
  warehouse_manager: [
    'dashboard.view', 'task.management', 'stock.view', 'stock.transfer', 'stock.adjustment',
    'picking.management', 'sorting.management',
    'dispatch.management', 'delivery.management', 'delivery.assignment',
    'warehouse.master', 'vehicle.master',
    'reports.inventory',
  ],
  finance_manager: [
    'dashboard.view', 'task.management', 'finance.management',
    'dealer.ledger', 'supplier.ledger', 'cheque.management',
    'reconciliation', 'expense.management', 'expense.approve',
    'payment', 'invoice', 'credit.note', 'debit.note',
    'reports.finance', 'reports.gst', 'reports.profit', 'reports.sales',
    'tally.sync', 'tally.reconciliation',
    'asset.management',
  ],
  hr_manager: [
    'dashboard.view', 'task.management', 'hrms.management',
    'attendance.master', 'leave.management', 'salary.management',
    'employee.registration', 'employee.master',
    'expense.management', 'expense.approve',
    'reports.hr',
  ],
  sales_executive: [
    'dashboard.view', 'complaint.management', 'product.master', 'dealer.master',
    'lead.management', 'followup.management',
    'sales.order.create', 'sales.order.dashboard',
    'quotation.management',
    'sales.executive.app',
  ],
  delivery_executive: [
    'dashboard.view',
    'delivery.executive.app',
    'delivery.management', 'delivery.tracking',
  ],
  picking_staff: [
    'dashboard.view',
    'picking.management', 'sorting.management',
    'stock.view',
  ],
  sorting_staff: [
    'dashboard.view',
    'sorting.management', 'picking.management',
    'stock.view',
    'dispatch.management',
  ],
  dealer: [
    'dealer.order.requests', 'support.chat',
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
  picking_staff: { name: 'Picking/Sorting Staff', description: 'Warehouse picking, sorting, stock view', color: '#9254de', rank: 20 },
  sorting_staff: { name: 'Sorting Staff', description: 'Sorting, dispatch preparation', color: '#597ef7', rank: 20 },
  dealer: { name: 'Dealer (App)', description: 'Dealer portal — orders and support', color: '#73d13d', rank: 10 },
};

/**
 * Get permissions config for frontend (User Management UI)
 */
export const getPermissionsConfig = () => ({
  permissions: AVAILABLE_PERMISSIONS,
  rolePermissions: ROLE_DEFAULT_PERMISSIONS,
  roleInfo: ROLE_INFO,
});
