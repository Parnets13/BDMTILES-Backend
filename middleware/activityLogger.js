import ActivityLog from '../models/ActivityLog.js';

/**
 * Log an activity to the audit trail.
 * Call this from route handlers after successful operations.
 *
 * Usage:
 *   await logActivity({
 *     user: req.user,
 *     action: 'create',
 *     module: 'sales_order',
 *     recordId: order._id,
 *     recordTitle: order.orderNumber,
 *     recordModel: 'SalesOrder',
 *     description: `Created sales order ${order.orderNumber}`,
 *     req,
 *   });
 */
export const logActivity = async ({
  user, action, module, recordId, recordTitle, recordModel,
  description, changes, metadata, branch, req,
}) => {
  try {
    await ActivityLog.create({
      branch: branch || req?.branchId || undefined,
      user: user?._id || user,
      userName: user?.name || user?.userName || '',
      userRole: user?.role || '',
      action,
      module,
      recordId,
      recordTitle: recordTitle || '',
      recordModel: recordModel || '',
      description: description || '',
      changes: changes || [],
      metadata: metadata || null,
      ipAddress: req?.ip || req?.connection?.remoteAddress || '',
      userAgent: req?.get?.('user-agent') || '',
      device: req?.get?.('x-device') || 'web',
      timestamp: new Date(),
    });
  } catch (err) {
    // Never let logging errors break the main flow
    console.error('ActivityLog error:', err.message);
  }
};

/**
 * Express middleware that auto-logs POST/PUT/PATCH/DELETE requests.
 * Attach AFTER auth middleware so req.user is available.
 * Note: This is a "fire-and-forget" logger — doesn't block the response.
 */
export const autoLogMiddleware = (req, res, next) => {
  // Only log write operations
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  // Store original json method to intercept response
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Explicit lifecycle/audit logging can suppress the generic entry to avoid duplicates.
    if (body?.success && req.user && !res.locals.skipAutoActivityLog) {
      const action = getActionFromMethod(req.method, req.path);
      const module = getModuleFromPath(req.originalUrl || req.path);

      // Don't await — fire and forget
      logActivity({
        user: req.user,
        action,
        module,
        recordId: body?.data?._id || body?.data?.id || null,
        recordTitle: body?.data?.orderNumber || body?.data?.poNumber || body?.data?.name ||
                     body?.data?.itemName || body?.data?.businessName || body?.data?.paymentNumber ||
                     body?.data?.voucherNumber || body?.data?.complaintNumber || body?.data?.leadNumber || '',
        recordModel: '',
        description: body?.message || `${action} on ${module}`,
        req,
      }).catch(() => {});
    }

    return originalJson(body);
  };

  next();
};

function getActionFromMethod(method, path) {
  if (method === 'POST') return 'create';
  if (method === 'PUT') return 'update';
  if (method === 'PATCH') {
    if (path.includes('/approve')) return 'approve';
    if (path.includes('/reject')) return 'reject';
    if (path.includes('/cancel')) return 'status_change';
    if (path.includes('/status')) return 'status_change';
    if (path.includes('/restore')) return 'restore';
    return 'update';
  }
  if (method === 'DELETE') return 'delete';
  return 'update';
}

function getModuleFromPath(url) {
  const parts = url.replace('/api/v1/', '').split('/');
  const moduleMap = {
    'products': 'product', 'sales-orders': 'sales_order', 'purchase': 'purchase',
    'purchase-returns': 'purchase_return', 'sales-returns': 'sales_return',
    'payments': 'payment', 'hrms': 'hrms', 'masters': 'master',
    'category-setup': 'category', 'users': 'user', 'auth': 'auth',
    'dealer-pricing': 'pricing', 'quotations': 'quotation',
    'ledger': 'ledger', 'cheques': 'cheque', 'vouchers': 'voucher',
    'dispatch': 'dispatch', 'leads': 'lead', 'complaints': 'complaint',
    'approvals': 'approval', 'schemes': 'scheme', 'reports': 'report',
    'supplier-invoices': 'supplier_invoice', 'stock': 'stock',
  };
  return moduleMap[parts[0]] || parts[0] || 'system';
}

export default { logActivity, autoLogMiddleware };
