import { Router } from 'express';
import { protect, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import {
  actionStockAdjustmentApproval, createStockAdjustment, getWorkflowDocument, listWorkflowDocuments,
  reverseStockAdjustment, submitStockAdjustment, updateStockAdjustment, workflowStats,
} from '../services/stockWorkflowService.js';

const router = Router();
router.use(protect, requireBranch);
const maker = requireAnyPermission('stock.adjustment.create', 'stock.adjustment');
const submitter = requireAnyPermission('stock.adjustment.submit', 'stock.adjustment');
const reader = requireAnyPermission('stock.view', 'stock.adjustment.create', 'stock.adjustment.submit', 'stock.adjustment.approve', 'stock.adjustment.reverse', 'stock.adjustment');
const sendError = (res, error) => res.status(error.status || (error.code === 11000 ? 409 : ['CastError', 'ValidationError'].includes(error.name) ? 422 : 500)).json({ success: false, message: error.message, ...(error.details ? { details: error.details } : {}) });
const idempotencyKey = req => {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!key || key.length > 200) throw Object.assign(new Error('A valid Idempotency-Key header is required.'), { status: 422 });
  return `${req.branchId}:stock-adjustment:${key}`;
};
const response = (res, result, message) => res.json({ success: true, message, data: result.document, affectedStockIds: result.stocks || [], movementIds: result.movements || [] });

router.get('/', reader, async (req, res) => { try { return res.json({ success: true, ...(await listWorkflowDocuments('adjustment', req.branchId, req.query)) }); } catch (error) { return sendError(res, error); } });
router.get('/stats', reader, async (req, res) => { try { return res.json({ success: true, data: await workflowStats('adjustment', req.branchId, req.query) }); } catch (error) { return sendError(res, error); } });
router.get('/:id', reader, async (req, res) => { try { return res.json({ success: true, data: await getWorkflowDocument('adjustment', req.branchId, req.params.id) }); } catch (error) { return sendError(res, error); } });
router.post('/', maker, async (req, res) => { try { const result = await createStockAdjustment({ branchId: req.branchId, actorId: req.user._id, payload: req.body, sourceKey: idempotencyKey(req) }); return res.status(result.replayed ? 200 : 201).json({ success: true, replayed: result.replayed, message: result.replayed ? 'Stock adjustment draft replayed.' : 'Stock adjustment draft created.', data: result.document }); } catch (error) { return sendError(res, error); } });
router.patch('/:id', maker, async (req, res) => { try { return res.json({ success: true, message: 'Draft updated.', data: await updateStockAdjustment({ branchId: req.branchId, actorId: req.user._id, adjustmentId: req.params.id, payload: req.body }) }); } catch (error) { return sendError(res, error); } });
router.patch('/:id/submit', submitter, async (req, res) => { try { return res.json({ success: true, message: 'Stock adjustment submitted for independent approval. No stock has been posted.', data: await submitStockAdjustment({ branchId: req.branchId, actorId: req.user._id, adjustmentId: req.params.id }) }); } catch (error) { return sendError(res, error); } });
router.patch('/:id/approve', requirePermission('stock.adjustment.approve'), async (req, res) => { try { return response(res, await actionStockAdjustmentApproval({ branchId: req.branchId, actorId: req.user._id, adjustmentId: req.params.id, nextStatus: 'approved', remarks: req.body?.remarks || '' }), 'Stock adjustment approved and posted.'); } catch (error) { return sendError(res, error); } });
router.patch('/:id/reject', requirePermission('stock.adjustment.approve'), async (req, res) => { try { return response(res, await actionStockAdjustmentApproval({ branchId: req.branchId, actorId: req.user._id, adjustmentId: req.params.id, nextStatus: 'rejected', remarks: req.body?.remarks || '' }), 'Stock adjustment rejected. No stock movement was posted.'); } catch (error) { return sendError(res, error); } });
router.patch('/:id/reverse', requirePermission('stock.adjustment.reverse'), async (req, res) => { try { return response(res, await reverseStockAdjustment({ branchId: req.branchId, actorId: req.user._id, adjustmentId: req.params.id, reason: req.body?.reason }), 'Stock adjustment reversed with appended inverse movements.'); } catch (error) { return sendError(res, error); } });

export default router;
