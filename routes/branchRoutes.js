import { Router } from 'express';
import mongoose from 'mongoose';
import Branch from '../models/Branch.js';
import BranchSettings from '../models/BranchSettings.js';
import BranchSequence from '../models/BranchSequence.js';
import User from '../models/User.js';
import Warehouse from '../models/Warehouse.js';
import { protect, requirePermission } from '../middleware/auth.js';
import {
  branchAccessFilter,
  hasGlobalBranchAccess,
  requireGlobalBranchAccess,
} from '../utils/branchScope.js';

const router = Router();
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const businessCollections = [
  'salesorders', 'quotations', 'invoices', 'purchaseorders', 'grns', 'stocks',
  'expenses', 'dealerpricings', 'payments', 'salesreturns', 'purchasereturns',
  'dealerledgers', 'supplierledgers', 'supplierinvoices', 'picklists',
  'dispatchtrips', 'deliveries',
];

const validBranchId = (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ success: false, message: 'Branch not found.' });
    return false;
  }
  return true;
};

router.use(protect);
router.use(requirePermission('branch.master'));

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, status } = req.query;
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
    const filter = {};
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: regex }, { branchCode: regex }, { city: regex }, { gstin: regex }];
    }
    if (status) filter.status = status;
    if (!hasGlobalBranchAccess(req.user)) {
      filter._id = { $in: (req.user.assignedBranches || []).map((branch) => branch._id || branch) };
    }

    const [branches, total] = await Promise.all([
      Branch.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l)
        .populate('defaultWarehouse', 'warehouseCode name status').lean(),
      Branch.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: branches,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:id/settings', async (req, res) => {
  try {
    if (!validBranchId(req, res)) return undefined;
    const branch = await Branch.findOne(branchAccessFilter(req.user, { _id: req.params.id })).select('_id').lean();
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });
    const settings = await BranchSettings.findOne({ branch: branch._id }).lean();
    if (!settings) return res.status(404).json({ success: false, message: 'Branch settings not found.' });
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!validBranchId(req, res)) return undefined;
    const branch = await Branch.findOne(branchAccessFilter(req.user, { _id: req.params.id }))
      .populate('defaultWarehouse', 'warehouseCode name status').lean();
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });
    const settings = await BranchSettings.findOne({ branch: branch._id }).lean();
    return res.json({ success: true, data: { ...branch, settings } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', requireGlobalBranchAccess, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (req.body.defaultWarehouse) {
      return res.status(422).json({ success: false, message: 'Create the branch before assigning its default warehouse.' });
    }
    let branch;
    await session.withTransaction(async () => {
      const { settings, defaultWarehouse, ...input } = req.body;
      [branch] = await Branch.create([{
        ...input,
        defaultWarehouse: undefined,
        createdBy: req.user._id,
        updatedBy: req.user._id,
      }], { session });
      await BranchSettings.create([{
        ...(settings || {}),
        branch: branch._id,
        createdBy: req.user._id,
        updatedBy: req.user._id,
      }], { session });
      await User.updateMany(
        { role: { $in: ['super_admin', 'owner'] } },
        { $addToSet: { assignedBranches: branch._id } },
        { session }
      );
      await User.updateMany(
        {
          role: { $in: ['super_admin', 'owner'] },
          $or: [{ defaultBranch: { $exists: false } }, { defaultBranch: null }],
        },
        { $set: { defaultBranch: branch._id } },
        { session }
      );
    });
    return res.status(201).json({ success: true, message: 'Branch created.', data: branch });
  } catch (error) {
    const status = error.code === 11000 ? 400 : (error.status || 500);
    return res.status(status).json({ success: false, message: error.code === 11000 ? 'Branch code already exists.' : error.message });
  } finally {
    await session.endSession();
  }
});

router.put('/:id/settings', requireGlobalBranchAccess, async (req, res) => {
  try {
    if (!validBranchId(req, res)) return undefined;
    if (!await Branch.exists({ _id: req.params.id })) {
      return res.status(404).json({ success: false, message: 'Branch not found.' });
    }
    const { branch, createdBy, ...updates } = req.body;
    const settings = await BranchSettings.findOneAndUpdate(
      { branch: req.params.id },
      { $set: { ...updates, branch: req.params.id, updatedBy: req.user._id }, $setOnInsert: { createdBy: req.user._id } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    return res.json({ success: true, message: 'Branch settings updated.', data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id', requireGlobalBranchAccess, async (req, res) => {
  if (!validBranchId(req, res)) return undefined;
  const session = await mongoose.startSession();
  try {
    let updatedBranch;
    await session.withTransaction(async () => {
      const current = await Branch.findById(req.params.id).session(session);
      if (!current) throw Object.assign(new Error('Branch not found.'), { status: 404 });
      const { settings, branch, createdBy, ...updates } = req.body;
      const isDeactivating = current.status === 'active' && updates.status === 'inactive';
      const isReactivating = current.status === 'inactive' && updates.status === 'active';

      if (hasOwn(updates, 'defaultWarehouse')) {
        if (!updates.defaultWarehouse) {
          updates.defaultWarehouse = undefined;
          current.defaultWarehouse = undefined;
        } else {
          const warehouse = await Warehouse.findOne({
            _id: updates.defaultWarehouse,
            branch: current._id,
            status: 'active',
          }).session(session).lean();
          if (!warehouse) throw Object.assign(new Error('Default warehouse must be active and belong to this branch.'), { status: 422 });
        }
      }

      if (isDeactivating) {
        const warehouseIds = await Warehouse.find({ branch: current._id }).session(session).distinct('_id');
        const users = await User.find({
          $or: [{ assignedBranches: current._id }, { defaultBranch: current._id }, { assignedWarehouse: { $in: warehouseIds } }],
        }).session(session).lean();
        const activeBranches = await Branch.find({ _id: { $ne: current._id }, status: 'active' })
          .session(session).select('_id').lean();
        const activeIds = new Set(activeBranches.map((item) => String(item._id)));
        const operations = [];

        for (const user of users) {
          const alternatives = (user.assignedBranches || [])
            .map(String)
            .filter((id) => id !== String(current._id) && activeIds.has(id));
          if (!['super_admin', 'owner'].includes(user.role) && alternatives.length === 0) {
            throw Object.assign(new Error(`Reassign user ${user.name || user.email} before deactivating this branch.`), { status: 409 });
          }
          const update = { $pull: { assignedBranches: current._id } };
          if (String(user.defaultBranch || '') === String(current._id)) {
            if (alternatives[0]) update.$set = { defaultBranch: alternatives[0] };
            else update.$unset = { defaultBranch: 1 };
          }
          if (user.assignedWarehouse && warehouseIds.some((id) => String(id) === String(user.assignedWarehouse))) {
            update.$unset = { ...(update.$unset || {}), assignedWarehouse: 1 };
          }
          operations.push({ updateOne: { filter: { _id: user._id }, update } });
        }
        if (operations.length) await User.bulkWrite(operations, { session });
        current.defaultWarehouse = undefined;
      }

      Object.assign(current, updates, { updatedBy: req.user._id });
      if (isDeactivating) current.defaultWarehouse = undefined;
      await current.save({ session });

      if (isReactivating) {
        await User.updateMany(
          { role: { $in: ['super_admin', 'owner'] } },
          { $addToSet: { assignedBranches: current._id } },
          { session }
        );
        await User.updateMany(
          {
            role: { $in: ['super_admin', 'owner'] },
            $or: [{ defaultBranch: { $exists: false } }, { defaultBranch: null }],
          },
          { $set: { defaultBranch: current._id } },
          { session }
        );
      }

      if (settings) {
        await BranchSettings.findOneAndUpdate(
          { branch: current._id },
          { $set: { ...settings, branch: current._id, updatedBy: req.user._id }, $setOnInsert: { createdBy: req.user._id } },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true, session }
        );
      }
      updatedBranch = current;
    });
    return res.json({ success: true, message: 'Branch updated.', data: updatedBranch });
  } catch (error) {
    const status = error.code === 11000 ? 400 : (error.status || 500);
    return res.status(status).json({ success: false, message: error.code === 11000 ? 'Branch code already exists.' : error.message });
  } finally {
    await session.endSession();
  }
});

router.delete('/:id', requireGlobalBranchAccess, async (req, res) => {
  if (!validBranchId(req, res)) return undefined;
  const session = await mongoose.startSession();
  try {
    const branch = await Branch.findById(req.params.id).lean();
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });
    const [warehouseCount, userCount, defaultCount, sourceTransferCount, destinationTransferCount, ...businessCounts] = await Promise.all([
      Warehouse.countDocuments({ branch: branch._id }),
      User.countDocuments({ assignedBranches: branch._id }),
      User.countDocuments({ defaultBranch: branch._id }),
      mongoose.connection.collection('stocktransfers').countDocuments({ sourceBranch: branch._id }, { limit: 1 }),
      mongoose.connection.collection('stocktransfers').countDocuments({ destinationBranch: branch._id }, { limit: 1 }),
      ...businessCollections.map((name) => mongoose.connection.collection(name).countDocuments({ branch: branch._id }, { limit: 1 })),
    ]);
    if (warehouseCount || userCount || defaultCount || sourceTransferCount || destinationTransferCount || businessCounts.some(Boolean)) {
      return res.status(409).json({
        success: false,
        message: 'Cannot delete a branch that has warehouses, user assignments/defaults, or business records. Deactivate it instead.',
      });
    }

    await session.withTransaction(async () => {
      await Promise.all([
        BranchSettings.deleteOne({ branch: branch._id }, { session }),
        BranchSequence.deleteMany({ branch: branch._id }, { session }),
        Branch.deleteOne({ _id: branch._id }, { session }),
      ]);
    });
    return res.json({ success: true, message: 'Branch deleted.' });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
});

export default router;
