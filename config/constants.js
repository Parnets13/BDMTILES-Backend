// App-wide constants

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  SUB_ADMIN: 'sub_admin',
  OWNER: 'owner',
  SALES_MANAGER: 'sales_manager',
  PURCHASE_MANAGER: 'purchase_manager',
  WAREHOUSE_MANAGER: 'warehouse_manager',
  FINANCE_MANAGER: 'finance_manager',
  HR_MANAGER: 'hr_manager',
  SALES_EXECUTIVE: 'sales_executive',
  DELIVERY_EXECUTIVE: 'delivery_executive',
  PICKING_STAFF: 'picking_staff',
  SORTING_STAFF: 'sorting_staff',
  DEALER: 'dealer',
};

export const ROLE_LIST = Object.values(ROLES);

export const ORDER_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  PARTIAL_DISPATCH: 'partial_dispatch',
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

export const PAYMENT_STATUS = {
  PENDING: 'pending',
  PARTIAL: 'partial',
  PAID: 'paid',
  OVERDUE: 'overdue',
};

export const STOCK_TYPE = {
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  BLOCKED: 'blocked',
  TRANSIT: 'transit',
  DAMAGED: 'damaged',
  SAMPLE: 'sample',
  RETURN: 'return',
};

export const APPROVAL_STATUS = {
  NOT_REQUIRED: 'not_required',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
};

export const GST_RATES = [0, 5, 12, 18, 28];

export const UNITS = ['Box', 'Piece', 'SqFt', 'Kg', 'Meter', 'Litre', 'Set', 'Pair', 'Bundle', 'Nos'];

export const TILE_SIZES = [
  '200x200', '200x300', '250x375', '300x300', '300x450',
  '300x600', '400x400', '600x600', '600x1200', '800x800',
  '800x1200', '800x1600', '1000x1000', '1200x1200',
  '1200x1800', '1200x2400', '1600x3200',
];

export const TILE_FINISHES = [
  'Glossy', 'Matt', 'Sugar', 'Carving', 'Satin',
  'Rustic', 'Polished', 'Lapato', 'High Gloss',
  'Anti-Skid', 'Rocker', 'Book Match',
];
