import mongoose from 'mongoose';
import { Router } from 'express';
import ApprovalRequest from '../models/ApprovalRequest.js';
import SalesOrder from '../models/SalesOrder.js';
import DealerLedger from '../models/DealerLedger.js';
import PickList from '../models/PickList.js';
import Quotation from '../models/Quotation.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import PurchaseReturn from '../models/PurchaseReturn.js';
import SalesReturn from '../models/SalesReturn.js';
import { protect, requireAnyPermission, userHasPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { generateBranchNumber } from '../utils/branchSequence.js';
import { approvalExposureFingerprint } from '../services/approvalRequestService.js';
import { actionPurchaseOrderApproval } from '../services/purchaseOrderService.js';
import { reserveSalesOrderInventory } from '../utils/salesOrderInventory.js';
import { releaseSalesOrderReservation } from '../utils/releaseSalesOrderReservation.js';
import { postSubledgerEntry } from '../utils/subledgerPosting.js';

const APPROVAL_TYPE_PERMISSIONS = Object.freeze({
  sales_order: 'sales.order.approve',
  sales_order_cancellation: 'sales.order.approve',
  quotation: 'sales.order.approve',
  purchase_order: 'po.approve',
  credit_limit: 'finance.management',
  rate_override: 'dealer.discounts',
  debit_note: 'debit.note',
  credit_note: 'credit.note',
  discount: 'dealer.discounts',
  other: 'system.management',
});

const APPROVAL_REFERENCE_TYPES = Object.freeze({
  sales_order: { referenceModel: 'SalesOrder', Model: SalesOrder, displayField: 'orderNumber', required: true },
  sales_order_cancellation: { referenceModel: 'SalesOrder', Model: SalesOrder, displayField: 'orderNumber', required: true },
  quotation: { referenceModel: 'Quotation', Model: Quotation, displayField: 'quotationNumber', required: true },
  purchase_order: { referenceModel: 'PurchaseOrder', Model: PurchaseOrder, displayField: 'poNumber', required: true },
  credit_limit: { referenceModel: 'SalesOrder', Model: SalesOrder, displayField: 'orderNumber' },
  rate_override: { referenceModel: 'SalesOrder', Model: SalesOrder, displayField: 'orderNumber' },
  debit_note: { referenceModel: 'PurchaseReturn', Model: PurchaseReturn, displayField: 'debitNoteNumber' },
  credit_note: { referenceModel: 'SalesReturn', Model: SalesReturn, displayField: 'returnNumber' },
  discount: { referenceModel: 'SalesOrder', Model: SalesOrder, displayField: 'orderNumber' },
});

const CREATE_FIELDS = [
  'type',
  'title',
  'description',
  'referenceModel',
  'referenceId',
  'requestedValue',
  'currentValue',
  'reason',
  'priority',
];

const routeError = (status, message) => Object.assign(new Error(message), { status });

const sendRouteError = (res, error) => {
  let status = error.status;
  if (!status && (error.name === 'CastError' || error.name === 'ValidationError')) status = 422;
  if (!status && error.code === 11000) status = 409;
  return res.status(status || 500).json({ success: false, message: error.message });
};

const allowedApprovalTypes = (user) => Object.entries(APPROVAL_TYPE_PERMISSIONS)
  .filter(([, permission]) => userHasPermission(user, permission))
  .map(([type]) => type);

const canActionApproval = (user, approval) => {
  const permission = APPROVAL_TYPE_PERMISSIONS[approval.type];
  return permission ? userHasPermission(user, permission) : false;
};

const pick = (source, fields) => fields.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
  return result;
}, {});

const validateApprovalReference = async (branchId, type, referenceModel, referenceId) => {
  const config = APPROVAL_REFERENCE_TYPES[type];
  const hasReferenceModel = Boolean(referenceModel);
  const hasReferenceId = Boolean(referenceId);

  if (!hasReferenceModel && !hasReferenceId) {
    if (config?.required) throw routeError(422, `${type} approvals require a reference.`);
    return null;
  }
  if (!hasReferenceModel || !hasReferenceId) {
    throw routeError(422, 'Both referenceModel and referenceId are required for a referenced approval.');
  }
  if (!config || referenceModel !== config.referenceModel) {
    throw routeError(422, 'Unsupported approval type and reference model combination.');
  }

  const reference = await config.Model.findOne({ _id: referenceId, branch: branchId })
    .select(config.displayField)
    .lean();
  if (!reference) throw routeError(404, 'Referenced document was not found in the active branch.');
  return reference[config.displayField] || String(reference._id);
};

const validateActionBody = (body = {}) => {
  const unexpected = Object.keys(body).filter((key) => key !== 'remarks');
  if (unexpected.length) throw routeError(422, 'Only remarks may be supplied for approval actions.');
  if (body.remarks !== undefined && typeof body.remarks !== 'string') {
    throw routeError(422, 'Remarks must be a string.');
  }
  return body.remarks || '';
};

const router = Router();
router.use(protect);
router.use(requireBranch);

const readApprovalPermissions = requireAnyPermission(...new Set(Object.values(APPROVAL_TYPE_PERMISSIONS)));

// GET /api/v1/approvals
router.get('/', readApprovalPermissions, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type, search } = req.query;
    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const p = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const l = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;
    const allowedTypes = allowedApprovalTypes(req.user);

    if (type && (!Object.hasOwn(APPROVAL_TYPE_PERMISSIONS, type) || !allowedTypes.includes(type))) {
      return res.status(403).json({ success: false, message: 'Access denied for this approval type.' });
    }

    const filter = {
      branch: req.branchId,
      type: type || { $in: allowedTypes },
      ...(status ? { status } : {}),
    };
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { requestNumber: regex }, { title: regex }, { description: regex },
        { referenceNumber: regex }, { requestedByName: regex },
      ];
    }
    const [data, total] = await Promise.all([
      ApprovalRequest.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('requestedBy', 'name').populate('approvedBy', 'name').lean(),
      ApprovalRequest.countDocuments(filter),
    ]);
    return res.json({ success: true, data, pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total } });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// GET /api/v1/approvals/stats
router.get('/stats', readApprovalPermissions, async (req, res) => {
  try {
    const visible = { branch: req.branchId, type: { $in: allowedApprovalTypes(req.user) } };
    const [total, pending, approved, rejected, byType] = await Promise.all([
      ApprovalRequest.countDocuments(visible),
      ApprovalRequest.countDocuments({ ...visible, status: 'pending' }),
      ApprovalRequest.countDocuments({ ...visible, status: 'approved' }),
      ApprovalRequest.countDocuments({ ...visible, status: 'rejected' }),
      ApprovalRequest.aggregate([
        { $match: { ...visible, status: 'pending' } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
    ]);
    return res.json({ success: true, data: { total, pending, approved, rejected, byType } });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

// POST /api/v1/approvals — create request
router.post('/', async (req, res) => {
  try {
    const data = pick(req.body || {}, CREATE_FIELDS);
    if (!Object.hasOwn(APPROVAL_TYPE_PERMISSIONS, data.type)) {
      throw routeError(422, 'Unsupported approval type.');
    }

    if (data.type === 'sales_order_cancellation') {
      throw routeError(422, 'Use the Sales Order cancellation-request endpoint.');
    }
    if (data.type === 'purchase_order') {
      throw routeError(422, 'Use the Purchase Order submit endpoint to create its approval request.');
    }
    const referenceNumber = await validateApprovalReference(
      req.branchId,
      data.type,
      data.referenceModel,
      data.referenceId
    );
    data.branch = req.branchId;
    data.requestedBy = req.user._id;
    data.requestedByName = req.user.name;
    data.status = 'pending';
    data.requestNumber = await generateBranchNumber(req.branchId, 'approval', new Date());
    if (referenceNumber) data.referenceNumber = referenceNumber;

    const approval = await ApprovalRequest.create(data);
    return res.status(201).json({ success: true, message: 'Approval request submitted.', data: approval });
  } catch (error) {
    return sendRouteError(res, error);
  }
});

const actionApproval = async (req, res, nextStatus) => {
  let remarks;
  try {
    remarks = validateActionBody(req.body);
  } catch (error) {
    return sendRouteError(res, error);
  }

  const session = await mongoose.startSession();
  let approval;
  try {
    await session.withTransaction(async () => {
      const current = await ApprovalRequest.findOne({ _id: req.params.id, branch: req.branchId }).session(session);
      if (!current) throw routeError(404, 'Not found.');
      if (!canActionApproval(req.user, current)) {
        throw routeError(403, 'Access denied for this approval type.');
      }
      if (current.status !== 'pending') throw routeError(409, 'Already actioned.');

      const purchaseOrderAction = current.type === 'purchase_order'
        && current.referenceModel === 'PurchaseOrder'
        && current.referenceId;
      if (purchaseOrderAction) {
        const result = await actionPurchaseOrderApproval({
          branchId: req.branchId,
          poId: current.referenceId,
          actorId: req.user._id,
          nextStatus,
          remarks,
          session,
          approvalRequestId: current._id,
        });
        approval = await ApprovalRequest.findById(current._id).session(session);
        if (!approval || approval.status !== nextStatus || result.po.status !== nextStatus) {
          throw routeError(409, 'Purchase order and approval request could not be synchronized.');
        }
        return;
      }

      const cancellationAction = current.type === 'sales_order_cancellation'
        && current.referenceModel === 'SalesOrder'
        && current.referenceId;
      const autoActionSalesOrder = ['sales_order', 'credit_limit', 'rate_override', 'discount'].includes(current.type)
        && current.referenceModel === 'SalesOrder'
        && current.referenceId;
      const autoActionQuotation = current.type === 'quotation'
        && current.referenceModel === 'Quotation'
        && current.referenceId;
      let referencedSalesOrder = null;
      let referencedQuotation = null;

      if (cancellationAction) {
        referencedSalesOrder = await SalesOrder.findOne({
          _id: current.referenceId,
          branch: req.branchId,
          cancellationRequestStatus: 'pending',
          status: { $in: ['confirmed', 'approved', 'processing'] },
        }).session(session).lean();
        if (!referencedSalesOrder) throw routeError(409, 'Referenced Sales Order is unavailable or no longer pending cancellation.');
        if ((referencedSalesOrder.items || []).some(item => Number(item.dispatchedQuantity || 0) > 0)) {
          throw routeError(409, 'A partially dispatched Sales Order cannot be cancelled wholesale.');
        }
      }

      if (autoActionSalesOrder) {
        referencedSalesOrder = await SalesOrder.findOne({
          _id: current.referenceId,
          branch: req.branchId,
          approvalStatus: 'pending',
        }).session(session).lean();
        if (!referencedSalesOrder) throw routeError(409, 'Referenced sales order is unavailable or no longer pending approval.');
      }
      if (autoActionQuotation) {
        referencedQuotation = await Quotation.findOne({
          _id: current.referenceId,
          branch: req.branchId,
          status: 'pending_approval',
          approvalStatus: 'pending',
        }).session(session).lean();
        if (!referencedQuotation) throw routeError(409, 'Referenced quotation is unavailable or no longer pending approval.');
      }

      if (current.isAutomatic) {
        const referencedDocument = referencedSalesOrder || referencedQuotation;
        const currentExposure = approvalExposureFingerprint(referencedDocument);
        if (!current.exposureFingerprint || current.exposureFingerprint !== currentExposure) {
          throw routeError(409, 'The referenced document changed after this request was created. Review the latest approval request.');
        }
      }

      const actionedAt = new Date();
      approval = await ApprovalRequest.findOneAndUpdate(
        { _id: current._id, branch: req.branchId, status: 'pending' },
        {
          $set: {
            status: nextStatus,
            approvedBy: req.user._id,
            approvedAt: actionedAt,
            approvalRemarks: remarks,
          },
        },
        { new: true, runValidators: true, session }
      );
      if (!approval) throw routeError(409, 'Approval was actioned by another request.');

      if (cancellationAction) {
        if (nextStatus === 'approved') {
          await releaseSalesOrderReservation(current.referenceId, { session });
          await PickList.updateMany(
            { branch: req.branchId, salesOrder: current.referenceId, stockConsumedAt: null },
            {
              $set: {
                status: 'cancelled', stockReserved: false, reservationState: 'released',
                reservationReleasedAt: actionedAt, cancellationProcessing: false,
              },
              $unset: { dispatchTrip: 1, tripClaimedAt: 1 },
            },
            { session }
          );
          const cancelledOrder = await SalesOrder.findOneAndUpdate(
            {
              _id: current.referenceId,
              branch: req.branchId,
              cancellationRequestStatus: 'pending',
              status: { $in: ['confirmed', 'approved', 'processing'] },
            },
            {
              $set: {
                status: 'cancelled', cancellationRequestStatus: 'approved',
                cancellationReason: current.reason || current.description || '',
                tallySyncStatus: referencedSalesOrder.tallySyncStatus === 'synced' ? 'pending' : referencedSalesOrder.tallySyncStatus,
              },
              $push: { modificationLogs: { field: 'status', oldValue: referencedSalesOrder.status, newValue: 'cancelled', changedBy: req.user._id, changedAt: actionedAt, reason: current.reason || current.description || '' } },
            },
            { new: true, runValidators: true, session }
          );
          if (!cancelledOrder) throw routeError(409, 'Sales Order cancellation state changed before approval was applied.');
          await ApprovalRequest.updateMany(
            { branch: req.branchId, referenceModel: 'SalesOrder', referenceId: current.referenceId, type: 'sales_order', status: 'pending' },
            { $set: { status: 'cancelled' } },
            { session }
          );
          if (cancelledOrder.dealer) {
            const originalPostingKey = `sales-order:${cancelledOrder._id}:confirmed`;
            const originalPosting = await DealerLedger.findOne({ branch: req.branchId, dealer: cancelledOrder.dealer, postingKey: originalPostingKey }).session(session).select('_id').lean();
            if (originalPosting) {
              await postSubledgerEntry({
                session, branch: req.branchId, partyType: 'dealer', partyId: cancelledOrder.dealer,
                postingKey: `sales-order:${cancelledOrder._id}:cancelled`, reversalOfPostingKey: originalPostingKey,
                entryType: 'credit_note', entryDate: actionedAt,
                description: `Cancellation reversal for Sales Order ${cancelledOrder.orderNumber}`,
                referenceNumber: cancelledOrder.orderNumber, referenceModel: 'SalesOrder', referenceId: cancelledOrder._id, createdBy: req.user._id,
              });
            }
          }
        } else {
          const rejectedOrder = await SalesOrder.findOneAndUpdate(
            { _id: current.referenceId, branch: req.branchId, cancellationRequestStatus: 'pending' },
            { $set: { cancellationRequestStatus: 'rejected' } },
            { new: true, session }
          );
          if (!rejectedOrder) throw routeError(409, 'Sales Order cancellation state changed before rejection was applied.');
        }
      }

      if (autoActionSalesOrder) {
        const reasonType = current.type === 'credit_limit'
          ? 'credit_limit'
          : ['rate_override', 'discount'].includes(current.type)
            ? 'below_minimum_price'
            : null;
        const updatedReasons = (referencedSalesOrder.approvalReasons || []).map((reason) => ({
          ...reason,
          status: !reasonType || reason.type === reasonType ? nextStatus : reason.status,
        }));
        const aggregateStatus = updatedReasons.length
          ? updatedReasons.some((reason) => reason.status === 'rejected')
            ? 'rejected'
            : updatedReasons.some((reason) => reason.status !== 'approved')
              ? 'pending'
              : 'approved'
          : nextStatus;
        const setFields = {
          approvalStatus: aggregateStatus,
          approvalReasons: updatedReasons,
          approvalRemarks: remarks,
        };
        if (aggregateStatus === 'approved') {
          setFields.approvedBy = req.user._id;
          setFields.approvalDate = actionedAt;
        }
        const salesOrderUpdate = aggregateStatus === 'approved'
          ? { $set: setFields }
          : { $set: setFields, $unset: { approvedBy: 1, approvalDate: 1 } };
        const updatedOrder = await SalesOrder.findOneAndUpdate(
          { _id: current.referenceId, branch: req.branchId, approvalStatus: 'pending' },
          salesOrderUpdate,
          { new: true, runValidators: true, session }
        );
        if (!updatedOrder) throw routeError(409, 'Referenced sales order approval state changed.');
        if (aggregateStatus === 'approved' && updatedOrder.confirmationRequested && updatedOrder.status === 'draft') {
          await reserveSalesOrderInventory(updatedOrder, { session });
          updatedOrder.status = 'confirmed';
          await updatedOrder.save({ session });
          if (updatedOrder.dealer && updatedOrder.grandTotal > 0) {
            await postSubledgerEntry({
              session, branch: req.branchId, partyType: 'dealer', partyId: updatedOrder.dealer,
              amount: updatedOrder.grandTotal, side: 'debit', postingKey: `sales-order:${updatedOrder._id}:confirmed`,
              entryType: 'invoice', entryDate: updatedOrder.orderDate,
              description: `Receivable for Sales Order ${updatedOrder.orderNumber}`,
              referenceNumber: updatedOrder.orderNumber, referenceModel: 'SalesOrder', referenceId: updatedOrder._id, createdBy: req.user._id,
            });
          }
        }
      }

      if (autoActionQuotation) {
        const updatedReasons = (referencedQuotation.approvalReasons || []).map((reason) => ({
          ...reason,
          status: nextStatus,
        }));
        const setFields = {
          status: nextStatus === 'approved' ? 'approved' : 'pending_approval',
          approvalStatus: nextStatus,
          approvalReasons: updatedReasons,
          approvalRemarks: remarks,
        };
        if (nextStatus === 'approved') {
          setFields.approvedBy = req.user._id;
          setFields.approvalDate = actionedAt;
        }
        const quotationUpdate = nextStatus === 'approved'
          ? { $set: setFields }
          : { $set: setFields, $unset: { approvedBy: 1, approvalDate: 1 } };
        const updatedQuotation = await Quotation.findOneAndUpdate(
          {
            _id: current.referenceId,
            branch: req.branchId,
            status: 'pending_approval',
            approvalStatus: 'pending',
          },
          quotationUpdate,
          { new: true, runValidators: true, session }
        );
        if (!updatedQuotation) throw routeError(409, 'Referenced quotation approval state changed.');
      }
    });

    return res.json({
      success: true,
      message: nextStatus === 'approved' ? 'Approved.' : 'Rejected.',
      data: approval,
    });
  } catch (error) {
    return sendRouteError(res, error);
  } finally {
    await session.endSession();
  }
};

// PATCH /api/v1/approvals/:id/approve
router.patch('/:id/approve', (req, res) => actionApproval(req, res, 'approved'));

// PATCH /api/v1/approvals/:id/reject
router.patch('/:id/reject', (req, res) => actionApproval(req, res, 'rejected'));

export default router;
