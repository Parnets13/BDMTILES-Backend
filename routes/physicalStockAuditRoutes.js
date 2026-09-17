import { Router } from 'express';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import {
  actionPhysicalAuditApproval, createPhysicalStockAudit, getWorkflowDocument, listWorkflowDocuments,
  reversePhysicalStockAudit, savePhysicalAuditCounts, submitPhysicalStockAudit, workflowStats,
} from '../services/stockWorkflowService.js';

const router = Router();
router.use(protect, requireBranch);
const creator = requirePermission('stock.audit.create');
const reader = requireAnyPermission('stock.view', 'stock.audit.create', 'stock.audit.count', 'stock.audit.submit', 'stock.audit.approve', 'stock.audit.reverse');
const sendError = (res, error) => res.status(error.status || (error.code === 11000 ? 409 : ['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message, ...(error.details ? { details: error.details } : {}) });
const idempotencyKey = req => {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!key || key.length > 200) throw Object.assign(new Error('A valid Idempotency-Key header is required.'), { status: 422 });
  return `${req.branchId}:physical-stock-audit:${key}`;
};
const response = (res, result, message) => res.json({ success: true, message, data: result.document, affectedStockIds: result.stocks || [], movementIds: result.movements || [] });

router.get('/', reader, async (req, res) => { try { return res.json({ success: true, ...(await listWorkflowDocuments('audit', req.branchId, req.query)) }); } catch (error) { return sendError(res, error); } });
router.get('/stats', reader, async (req, res) => { try { return res.json({ success: true, data: await workflowStats('audit', req.branchId, req.query) }); } catch (error) { return sendError(res, error); } });
router.get('/:id', reader, async (req, res) => { try { return res.json({ success: true, data: await getWorkflowDocument('audit', req.branchId, req.params.id) }); } catch (error) { return sendError(res, error); } });
router.post('/', creator, async (req, res) => { try { const result = await createPhysicalStockAudit({ branchId: req.branchId, actorId: req.user._id, payload: req.body, sourceKey: idempotencyKey(req) }); return res.status(result.replayed ? 200 : 201).json({ success: true, replayed: result.replayed, message: result.replayed ? 'Physical audit count sheet replayed.' : 'Physical audit count sheet created. No stock has been posted.', data: result.document }); } catch (error) { return sendError(res, error); } });
router.patch('/:id/counts', requirePermission('stock.audit.count'), async (req, res) => { try { return res.json({ success: true, message: 'Counts saved. No stock has been posted.', data: await savePhysicalAuditCounts({ branchId: req.branchId, actorId: req.user._id, auditId: req.params.id, counts: req.body?.counts, remarks: req.body?.remarks }) }); } catch (error) { return sendError(res, error); } });
router.patch('/:id/submit', requirePermission('stock.audit.submit'), async (req, res) => { try { return res.json({ success: true, message: 'Physical audit submitted for independent approval. No stock has been posted.', data: await submitPhysicalStockAudit({ branchId: req.branchId, actorId: req.user._id, auditId: req.params.id }) }); } catch (error) { return sendError(res, error); } });
router.patch('/:id/approve', requirePermission('stock.audit.approve'), async (req, res) => { try { return response(res, await actionPhysicalAuditApproval({ branchId: req.branchId, actorId: req.user._id, auditId: req.params.id, nextStatus: 'approved', remarks: req.body?.remarks || '' }), 'Physical audit approved and posted.'); } catch (error) { return sendError(res, error); } });
router.patch('/:id/reject', requirePermission('stock.audit.approve'), async (req, res) => { try { return response(res, await actionPhysicalAuditApproval({ branchId: req.branchId, actorId: req.user._id, auditId: req.params.id, nextStatus: 'rejected', remarks: req.body?.remarks || '' }), 'Physical audit rejected. No stock movement was posted.'); } catch (error) { return sendError(res, error); } });
router.patch('/:id/reverse', requirePermission('stock.audit.reverse'), async (req, res) => { try { return response(res, await reversePhysicalStockAudit({ branchId: req.branchId, actorId: req.user._id, auditId: req.params.id, reason: req.body?.reason }), 'Physical audit reversed with appended inverse movements.'); } catch (error) { return sendError(res, error); } });

export default router;
