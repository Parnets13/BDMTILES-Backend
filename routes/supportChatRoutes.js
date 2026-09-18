import { Router } from 'express';
import mongoose from 'mongoose';
import DealerMessage from '../models/DealerMessage.js';
import Dealer from '../models/Dealer.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

/**
 * Web admin support desk for the dealer ↔ sales executive conversation (SOW 17.8).
 *
 * The executive-side endpoints under /sales-executive/me/messages are scoped to
 * `assignedSalesExecutive`, so back-office staff see nothing there — they have no
 * assigned dealers. These endpoints give admin/support a branch-wide view of the
 * same `DealerMessage` thread the dealer app writes to.
 *
 * Read state is deliberately separate (`readByAdminAt`): support reading a thread
 * must not clear the assigned executive's unread badge.
 */
const router = Router();
router.use(protect);
router.use(requireBranch);
router.use(requirePermission('support.chat'));

function sendError(res, error) {
  const status = error.status || (error.name === 'CastError' ? 422 : 500);
  const message = error.name === 'CastError' ? 'Invalid identifier.' : error.message;
  return res.status(status).json({ success: false, message, code: error.code });
}

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

// GET /api/v1/support-chat/threads — every dealer conversation, newest first.
// Dealers are global in this schema (no `branch` field), and dealer-app messages
// can carry a null branch when the dealer's branch was not resolvable at send
// time. Threads are therefore not branch-filtered — the same choice the
// executive-side endpoint makes, which filters by dealer only.
router.get('/threads', async (req, res) => {
  try {
    const rows = await DealerMessage.aggregate([
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$dealer',
          lastMessage: { $first: '$body' },
          lastSenderRole: { $first: '$senderRole' },
          lastSenderName: { $first: '$senderName' },
          lastAt: { $first: '$createdAt' },
          // Unread for the support desk: dealer messages nobody in the back office
          // has opened yet.
          unread: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$senderRole', 'dealer'] }, { $eq: ['$readByAdminAt', null] }] },
                1, 0,
              ],
            },
          },
          // Shown so support can tell whether the assigned executive is already on it.
          awaitingExecutive: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$senderRole', 'dealer'] }, { $eq: ['$readByExecutiveAt', null] }] },
                1, 0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
      { $sort: { lastAt: -1 } },
      { $lookup: { from: 'dealers', localField: '_id', foreignField: '_id', as: 'dealer' } },
      { $unwind: '$dealer' },
      {
        $lookup: {
          from: 'users',
          localField: 'dealer.assignedSalesExecutive',
          foreignField: '_id',
          as: 'executive',
        },
      },
      {
        $project: {
          _id: 0,
          dealerId: '$_id',
          businessName: '$dealer.businessName',
          dealerCode: '$dealer.dealerCode',
          mobile: '$dealer.mobile',
          city: '$dealer.city',
          assignedExecutive: {
            $let: {
              vars: { se: { $arrayElemAt: ['$executive', 0] } },
              in: {
                $cond: [
                  { $ifNull: ['$$se._id', false] },
                  { _id: '$$se._id', name: '$$se.name', phone: '$$se.phone' },
                  null,
                ],
              },
            },
          },
          lastMessage: 1,
          lastSenderRole: 1,
          lastSenderName: 1,
          lastAt: 1,
          unread: 1,
          awaitingExecutive: 1,
          total: 1,
        },
      },
    ]);

    return res.json({ success: true, data: rows });
  } catch (error) { return sendError(res, error); }
});

// GET /api/v1/support-chat/unread-count — declared before /:dealerId so it is not
// captured as a dealer id.
router.get('/unread-count', async (_req, res) => {
  try {
    const count = await DealerMessage.countDocuments({
      senderRole: 'dealer', readByAdminAt: null,
    });
    return res.json({ success: true, data: { count } });
  } catch (error) { return sendError(res, error); }
});

async function loadDealer(dealerId) {
  if (!mongoose.isValidObjectId(dealerId)) throw fail(422, 'Invalid dealer id.', 'INVALID_DEALER_ID');
  const dealer = await Dealer.findById(dealerId)
    .select('businessName dealerCode mobile city status assignedSalesExecutive')
    .populate('assignedSalesExecutive', 'name phone')
    .lean();
  if (!dealer) throw fail(404, 'Dealer not found.', 'DEALER_NOT_FOUND');
  return dealer;
}

// GET /api/v1/support-chat/:dealerId — full thread; marks it read for support only.
router.get('/:dealerId', async (req, res) => {
  try {
    const dealer = await loadDealer(req.params.dealerId);

    const filter = { dealer: dealer._id };
    if (mongoose.isValidObjectId(req.query.complaint)) filter.complaint = req.query.complaint;

    const data = await DealerMessage.find(filter)
      .sort({ createdAt: 1 }).limit(300)
      .select('senderRole senderName body attachments createdAt readByDealerAt readByExecutiveAt readByAdminAt sentFromSupportDesk complaint')
      .lean();

    // Support's own read marker. readByExecutiveAt is intentionally untouched.
    await DealerMessage.updateMany(
      { dealer: dealer._id, senderRole: 'dealer', readByAdminAt: null },
      { $set: { readByAdminAt: new Date() } },
    );

    return res.json({
      success: true,
      data,
      dealer: {
        _id: dealer._id,
        businessName: dealer.businessName,
        dealerCode: dealer.dealerCode,
        mobile: dealer.mobile,
        city: dealer.city,
        status: dealer.status,
        assignedExecutive: dealer.assignedSalesExecutive || null,
      },
    });
  } catch (error) { return sendError(res, error); }
});

// POST /api/v1/support-chat/:dealerId  { body, complaint? }
router.post('/:dealerId', async (req, res) => {
  try {
    const dealer = await loadDealer(req.params.dealerId);
    const body = String(req.body?.body || '').trim();
    if (!body) throw fail(422, 'Type a message to send.', 'EMPTY_MESSAGE');
    if (body.length > 2000) throw fail(422, 'Message is too long (2000 characters max).', 'MESSAGE_TOO_LONG');

    const message = await DealerMessage.create({
      branch: req.branchId,
      dealer: dealer._id,
      // The dealer app renders anything that is not 'dealer' as the staff side, so
      // a support reply lands in the same bubble stream as the executive's.
      senderRole: 'executive',
      salesExecutive: dealer.assignedSalesExecutive?._id || undefined,
      senderName: req.user.name || 'BDMTILES Support',
      sentFromSupportDesk: true,
      body,
      complaint: mongoose.isValidObjectId(req.body?.complaint) ? req.body.complaint : undefined,
      readByAdminAt: new Date(),
    });

    return res.status(201).json({ success: true, data: message });
  } catch (error) { return sendError(res, error); }
});

export default router;
