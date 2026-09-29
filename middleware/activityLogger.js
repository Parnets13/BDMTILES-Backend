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
                     body?.data?.voucherNumber || body?.data?.complaintNumber || body?.data?.leadNumber ||
                     body?.data?.requestNumber || '',
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
    'dealer-pricing': 'pricing', 'quotations': 'quotation', 'dealer-order-requests': 'dealer_order_request',
    'ledger': 'ledger', 'cheques': 'cheque', 'vouchers': 'voucher',
    'dispatch': 'dispatch', 'leads': 'lead', 'complaints': 'complaint',
    'approvals': 'approval', 'schemes': 'scheme', 'reports': 'report',
    'supplier-invoices': 'supplier_invoice', 'stock': 'stock',
  };
  return moduleMap[parts[0]] || parts[0] || 'system';
}

/**
 * Log an auth event (login, logout, failed login).
 *
 * Needed because `autoLogMiddleware` derives its action from the HTTP method and reads
 * `req.user`, neither of which suits auth: every auth route is a POST, and on a *login*
 * there is no `req.user` yet. Without this the audit trail can never contain a `login`
 * row at all, which leaves the Login History screen permanently empty.
 *
 * @param {object} opts
 * @param {'login'|'logout'|'access'} opts.action
 * @param {object} opts.user        the authenticated user document
 * @param {object} [opts.req]       the express request (for IP / user-agent)
 * @param {string} [opts.description]
 * @param {object} [opts.metadata]
 */
export const logAuthEvent = async ({ action, user, req, description, metadata }) => {
  if (!user) return;
  // Auth routes run before requireBranch, so there is no req.branchId. Resolve the
  // branch from the user so the row is visible to the branch-scoped log views —
  // every one of them filters on `branch`, so a branch-less row would be written
  // but never shown.
  const branch = user.defaultBranch
    || (Array.isArray(user.assignedBranches) ? user.assignedBranches[0] : undefined);

  await logActivity({
    user,
    action,
    module: 'auth',
    recordId: user._id,
    recordTitle: user.name || user.userName || user.email || '',
    recordModel: 'User',
    description: description || `${action === 'login' ? 'Signed in' : 'Signed out'}`,
    metadata: metadata || null,
    // logActivity takes `branch`; passing it explicitly avoids depending on req.branchId.
    branch: branch?._id || branch || undefined,
    req,
  });
};

/**
 * Log a document/report download.
 *
 * The auto-logger ignores GETs, so without this every download is invisible and the
 * Download Logs screen stays empty. Call it from an endpoint that streams a file, after
 * the content has been read successfully.
 *
 * `req.branchId` is honoured when present; these routes normally sit behind requireBranch.
 *
 * @param {object} opts
 * @param {object} opts.req
 * @param {string} opts.recordTitle  what was downloaded, e.g. the file name
 * @param {string} opts.module       e.g. 'hrms', 'recruitment', 'hr_templates'
 * @param {*} [opts.recordId]
 * @param {string} [opts.recordModel]
 * @param {string} [opts.description]
 */
export const logDownload = async ({ req, recordTitle, module, recordId, recordModel, description }) => {
  if (!req?.user) return;
  await logActivity({
    user: req.user,
    action: 'download',
    module: module || 'document',
    recordId: recordId || null,
    recordTitle: recordTitle || '',
    recordModel: recordModel || '',
    description: description || `Downloaded ${recordTitle || 'a document'}`,
    req,
  });
};

export default { logActivity, autoLogMiddleware, logAuthEvent, logDownload };
