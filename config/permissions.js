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
  ],
  "Sales & Purchase": [
    { id: "sales.order.dashboard", name: "Sales Order Dashboard" },
    { id: "sales.order.create", name: "Create Sales Orders" },
    { id: "sales.order.approve", name: "Approve Sales Orders" },
    { id: "dealer.discounts", name: "Dealer-Specific Discounts" },
    { id: "po.management", name: "Purchase Order Management" },
    { id: "grn.entry", name: "GRN Entry" },
    { id: "invoice", name: "Invoice Management" },
    { id: "payment", name: "Payment Management" },
    { id: "credit.note", name: "Credit Note" },
    { id: "debit.note", name: "Debit Note" },
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
 * Default permissions per role (assigned on user creation)
 */
export const ROLE_DEFAULT_PERMISSIONS = {
  super_admin: ['*'],  // All access
  admin: ['*'],
  owner: ['dashboard.view', 'reports.*', 'activity.logs', 'audit.trail'],
  sales_manager: [
    'dashboard.view', 'product.master', 'dealer.master', 'sales.order.dashboard',
    'sales.order.create', 'sales.order.approve', 'dealer.discounts',
    'invoice', 'payment', 'reports.sales', 'reports.profit',
    'sales.executive.app', 'dealer.order.requests', 'support.chat',
  ],
  purchase_manager: [
    'dashboard.view', 'product.master', 'supplier.master', 'category.setup',
    'po.management', 'grn.entry', 'invoice', 'payment',
    'stock.view', 'reports.purchase', 'reports.inventory',
  ],
  warehouse_manager: [
    'dashboard.view', 'stock.view', 'stock.transfer', 'stock.adjustment',
    'picking.management', 'sorting.management', 'dispatch.management',
    'warehouse.master', 'reports.inventory',
  ],
  finance_manager: [
    'dashboard.view', 'finance.management', 'dealer.ledger', 'supplier.ledger',
    'cheque.management', 'reconciliation', 'expense.management', 'expense.approve',
    'reports.finance', 'reports.gst', 'reports.profit', 'tally.sync',
    'asset.management',
  ],
  hr_manager: [
    'dashboard.view', 'hrms.management', 'attendance.master', 'leave.management',
    'salary.management', 'employee.registration', 'reports.hr',
  ],
  sales_executive: [
    'dashboard.view', 'product.master', 'dealer.master',
    'sales.order.create', 'sales.executive.app',
  ],
  delivery_executive: [
    'delivery.executive.app',
  ],
  picking_staff: ['picking.management'],
  sorting_staff: ['sorting.management'],
  dealer: ['dealer.order.requests', 'support.chat'],
};

/**
 * Get permissions config for frontend (User Management UI)
 */
export const getPermissionsConfig = () => ({
  permissions: AVAILABLE_PERMISSIONS,
  rolePermissions: ROLE_DEFAULT_PERMISSIONS,
});
