import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import JobOpening from '../models/JobOpening.js';
import Employee from '../models/Employee.js';
import { protect, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { uploadCandidateResume, candidateResumeDirectory } from '../middleware/upload.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const routeError = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, error) => res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
  .json({ success: false, message: error.message });

const validObjectId = (id) => mongoose.isValidObjectId(id);

// ═══════════════════════════════════════
// JOB OPENINGS
// ═══════════════════════════════════════
const jobAccess = [requireAnyPermission('job.opening.manage', 'candidate.manage')];

router.get('/job-openings', ...jobAccess, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, department } = req.query;
    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const filter = { branchId: req.branchId };
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ title: regex }, { department: regex }, { designation: regex }, { jobCode: regex }];
    }
    if (status) filter.status = status;
    if (department) filter.department = department;
    const [openings, total] = await Promise.all([
      JobOpening.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      JobOpening.countDocuments(filter),
    ]);
    // Applicant counts per opening, so the list can show pipeline volume at a glance.
    const openingIds = openings.map(o => o._id);
    const counts = await Candidate.aggregate([
      { $match: { jobOpening: { $in: openingIds } } },
      { $group: { _id: '$jobOpening', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map(c => [String(c._id), c.count]));
    res.json({
      success: true,
      data: openings.map(o => ({ ...o, candidateCount: countMap.get(String(o._id)) || 0 })),
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { sendError(res, error); }
});

router.get('/job-openings/options', ...jobAccess, async (req, res) => {
  try {
    const openings = await JobOpening.find({ branchId: req.branchId, status: 'open' })
      .select('jobCode title department designation').sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: openings });
  } catch (error) { sendError(res, error); }
});

router.get('/job-openings/stats', ...jobAccess, async (req, res) => {
  try {
    const filter = { branchId: req.branchId };
    const [total, open, onHold, closed] = await Promise.all([
      JobOpening.countDocuments(filter),
      JobOpening.countDocuments({ ...filter, status: 'open' }),
      JobOpening.countDocuments({ ...filter, status: 'on_hold' }),
      JobOpening.countDocuments({ ...filter, status: 'closed' }),
    ]);
    res.json({ success: true, data: { total, open, onHold, closed } });
  } catch (error) { sendError(res, error); }
});

router.post('/job-openings', requirePermission('job.opening.manage'), async (req, res) => {
  try {
    const { title, department, designation, positions, employmentType, experienceRequired, description, requirements, closingDate } = req.body;
    if (!title || !department || !designation) throw routeError(422, 'Title, department, and designation are required.');
    const jobCode = await JobOpening.generateJobCode();
    const opening = await JobOpening.create({
      jobCode, title, department, designation,
      positions: positions || 1, employmentType, experienceRequired,
      description, requirements, closingDate,
      branchId: req.branchId, createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Job opening created.', data: opening });
  } catch (error) { sendError(res, error); }
});

router.put('/job-openings/:id', requirePermission('job.opening.manage'), async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid job opening id.');
    const allowed = ['title', 'department', 'designation', 'positions', 'employmentType', 'experienceRequired', 'description', 'requirements', 'status', 'closingDate'];
    const updates = allowed.reduce((acc, key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) acc[key] = req.body[key];
      return acc;
    }, {});
    const opening = await JobOpening.findOneAndUpdate({ _id: req.params.id, branchId: req.branchId }, updates, { new: true, runValidators: true });
    if (!opening) throw routeError(404, 'Job opening not found.');
    res.json({ success: true, message: 'Job opening updated.', data: opening });
  } catch (error) { sendError(res, error); }
});

router.delete('/job-openings/:id', requirePermission('job.opening.manage'), async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid job opening id.');
    const inUse = await Candidate.countDocuments({ jobOpening: req.params.id });
    if (inUse > 0) throw routeError(409, `Cannot delete: ${inUse} candidate(s) reference this opening. Close it instead.`);
    const opening = await JobOpening.findOneAndDelete({ _id: req.params.id, branchId: req.branchId });
    if (!opening) throw routeError(404, 'Job opening not found.');
    res.json({ success: true, message: 'Job opening deleted.' });
  } catch (error) { sendError(res, error); }
});

// ═══════════════════════════════════════
// CANDIDATES
// ═══════════════════════════════════════
const candidateAccess = [requirePermission('candidate.manage')];

router.get('/candidates', ...candidateAccess, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status, jobOpening, talentPool } = req.query;
    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const filter = { branchId: req.branchId };
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: regex }, { mobile: regex }, { email: regex }, { candidateCode: regex }, { qualification: regex }, { tags: regex }];
    }
    if (status) filter.status = status;
    if (jobOpening && validObjectId(jobOpening)) filter.jobOpening = jobOpening;
    if (talentPool === 'true') filter.talentPool = true;
    const [candidates, total] = await Promise.all([
      Candidate.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
        .populate('jobOpening', 'jobCode title department').lean(),
      Candidate.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: candidates,
      pagination: { currentPage: p, totalPages: Math.ceil(total / l), totalItems: total, itemsPerPage: l },
    });
  } catch (error) { sendError(res, error); }
});

router.get('/candidates/stats', ...candidateAccess, async (req, res) => {
  try {
    const filter = { branchId: req.branchId };
    const [total, applied, shortlisted, interview, selected, rejected, talentPool] = await Promise.all([
      Candidate.countDocuments(filter),
      Candidate.countDocuments({ ...filter, status: 'Applied' }),
      Candidate.countDocuments({ ...filter, status: 'Shortlisted' }),
      Candidate.countDocuments({ ...filter, status: 'Interview' }),
      Candidate.countDocuments({ ...filter, status: 'Selected' }),
      Candidate.countDocuments({ ...filter, status: 'Rejected' }),
      Candidate.countDocuments({ ...filter, talentPool: true }),
    ]);
    res.json({ success: true, data: { total, applied, shortlisted, interview, selected, rejected, talentPool } });
  } catch (error) { sendError(res, error); }
});

router.get('/candidates/:id', ...candidateAccess, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId })
      .populate('jobOpening', 'jobCode title department designation')
      .populate('convertedToEmployee', 'empId name designation department')
      .lean();
    if (!candidate) throw routeError(404, 'Candidate not found.');
    res.json({ success: true, data: candidate });
  } catch (error) { sendError(res, error); }
});

router.post('/candidates', ...candidateAccess, async (req, res) => {
  try {
    const { name, mobile, email, address, city, state, qualification, experience, currentEmployer, expectedSalary, source, jobOpening, tags, notes } = req.body;
    if (!name || !mobile) throw routeError(422, 'Candidate name and mobile are required.');
    if (jobOpening && !validObjectId(jobOpening)) throw routeError(422, 'Invalid job opening reference.');
    const candidateCode = await Candidate.generateCandidateCode();
    const candidate = await Candidate.create({
      candidateCode, name, mobile, email, address, city, state,
      qualification, experience, currentEmployer, expectedSalary,
      source, jobOpening: jobOpening || undefined,
      tags: Array.isArray(tags) ? tags : [],
      notes, branchId: req.branchId, createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Candidate added.', data: candidate });
  } catch (error) { sendError(res, error); }
});

router.put('/candidates/:id', ...candidateAccess, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const allowed = ['name', 'mobile', 'email', 'address', 'city', 'state', 'qualification', 'experience', 'currentEmployer', 'expectedSalary', 'source', 'jobOpening', 'tags', 'notes', 'talentPool'];
    const updates = allowed.reduce((acc, key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) acc[key] = req.body[key];
      return acc;
    }, {});
    if (updates.jobOpening && !validObjectId(updates.jobOpening)) throw routeError(422, 'Invalid job opening reference.');
    const candidate = await Candidate.findOneAndUpdate({ _id: req.params.id, branchId: req.branchId }, updates, { new: true, runValidators: true });
    if (!candidate) throw routeError(404, 'Candidate not found.');
    res.json({ success: true, message: 'Candidate updated.', data: candidate });
  } catch (error) { sendError(res, error); }
});

// Move a candidate through the pipeline. Selected/Rejected are terminal for the
// active pipeline, but a Rejected candidate can still be flagged into the talent
// pool separately via PUT talentPool, and reopened by setting status back explicitly.
const STATUS_FLOW = ['Applied', 'Shortlisted', 'Interview', 'Selected', 'Rejected'];
router.patch('/candidates/:id/status', ...candidateAccess, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const { status, rejectionReason } = req.body;
    if (!STATUS_FLOW.includes(status)) throw routeError(422, `Status must be one of: ${STATUS_FLOW.join(', ')}`);
    const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId });
    if (!candidate) throw routeError(404, 'Candidate not found.');
    if (candidate.convertedToEmployee) throw routeError(409, 'Candidate has already been converted to an employee.');
    candidate.status = status;
    candidate.rejectionReason = status === 'Rejected' ? String(rejectionReason || '').trim() : '';
    await candidate.save();
    res.json({ success: true, message: `Candidate marked ${status}.`, data: candidate });
  } catch (error) { sendError(res, error); }
});

router.patch('/candidates/:id/talent-pool', ...candidateAccess, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const candidate = await Candidate.findOneAndUpdate(
      { _id: req.params.id, branchId: req.branchId },
      { talentPool: Boolean(req.body.talentPool) },
      { new: true }
    );
    if (!candidate) throw routeError(404, 'Candidate not found.');
    res.json({ success: true, message: candidate.talentPool ? 'Added to talent pool.' : 'Removed from talent pool.', data: candidate });
  } catch (error) { sendError(res, error); }
});

router.delete('/candidates/:id', ...candidateAccess, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId });
    if (!candidate) throw routeError(404, 'Candidate not found.');
    if (candidate.convertedToEmployee) throw routeError(409, 'Cannot delete a candidate already converted to an employee.');
    if (candidate.resume?.url) {
      const filePath = path.join(candidateResumeDirectory, path.basename(candidate.resume.url));
      await fs.promises.unlink(filePath).catch(() => {});
    }
    await candidate.deleteOne();
    res.json({ success: true, message: 'Candidate deleted.' });
  } catch (error) { sendError(res, error); }
});

// ── Resume upload / download ────────────────────────────────────────────────
router.post('/candidates/:id/resume', ...candidateAccess, (req, res) => {
  uploadCandidateResume(req, res, async (error) => {
    if (error) return res.status(400).json({ success: false, message: error.message });
    try {
      if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
      if (!req.file) throw routeError(422, 'A resume file is required.');
      const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId });
      if (!candidate) throw routeError(404, 'Candidate not found.');
      // Remove the previous resume file, if any, so uploads don't leak disk space.
      if (candidate.resume?.url) {
        const oldPath = path.join(candidateResumeDirectory, path.basename(candidate.resume.url));
        await fs.promises.unlink(oldPath).catch(() => {});
      }
      candidate.resume = { name: req.file.originalname, url: req.file.filename, uploadDate: new Date() };
      await candidate.save();
      res.json({ success: true, message: 'Resume uploaded.', data: candidate });
    } catch (err) { sendError(res, err); }
  });
});

router.get('/candidates/:id/resume', ...candidateAccess, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId }).select('resume name').lean();
    if (!candidate?.resume?.url) throw routeError(404, 'No resume on file for this candidate.');
    const storedName = path.basename(candidate.resume.url);
    if (storedName !== candidate.resume.url) throw routeError(409, 'Stored resume reference is invalid.');
    const filePath = path.join(candidateResumeDirectory, storedName);
    const content = await fs.promises.readFile(filePath);
    res.attachment(candidate.resume.name || storedName);
    res.send(content);
  } catch (error) { sendError(res, error); }
});

// ── Interviews ───────────────────────────────────────────────────────────
router.post('/candidates/:id/interviews', requireAnyPermission('candidate.interview', 'candidate.manage'), async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const { scheduledAt, mode, location, interviewer, round } = req.body;
    if (!scheduledAt) throw routeError(422, 'Interview date/time is required.');
    const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId });
    if (!candidate) throw routeError(404, 'Candidate not found.');
    candidate.interviews.push({
      scheduledAt: new Date(scheduledAt), mode, location, interviewer,
      round: round || `Round ${candidate.interviews.length + 1}`,
      scheduledBy: req.user._id,
    });
    // Scheduling an interview naturally advances the pipeline unless already further along.
    if (['Applied', 'Shortlisted'].includes(candidate.status)) candidate.status = 'Interview';
    await candidate.save();
    res.status(201).json({ success: true, message: 'Interview scheduled.', data: candidate });
  } catch (error) { sendError(res, error); }
});

router.patch('/candidates/:id/interviews/:interviewId', requireAnyPermission('candidate.interview', 'candidate.manage'), async (req, res) => {
  try {
    if (!validObjectId(req.params.id) || !validObjectId(req.params.interviewId)) throw routeError(400, 'Invalid identifier.');
    const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId });
    if (!candidate) throw routeError(404, 'Candidate not found.');
    const interview = candidate.interviews.id(req.params.interviewId);
    if (!interview) throw routeError(404, 'Interview not found.');
    const allowed = ['scheduledAt', 'mode', 'location', 'interviewer', 'round', 'status', 'feedback', 'rating'];
    allowed.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) interview[key] = req.body[key];
    });
    await candidate.save();
    res.json({ success: true, message: 'Interview updated.', data: candidate });
  } catch (error) { sendError(res, error); }
});

// ═══════════════════════════════════════
// CANDIDATE → EMPLOYEE CONVERSION
// ═══════════════════════════════════════
router.post('/candidates/:id/convert', requirePermission('candidate.convert'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid candidate id.');
    const { designation, department, dateOfJoining, employmentType, basicSalary, workLocation, reportingManager } = req.body;
    if (!designation || !department || !dateOfJoining) {
      throw routeError(422, 'Designation, department, and date of joining are required to convert a candidate.');
    }

    let employee;
    await session.withTransaction(async () => {
      const candidate = await Candidate.findOne({ _id: req.params.id, branchId: req.branchId }).session(session);
      if (!candidate) throw routeError(404, 'Candidate not found.');
      if (candidate.convertedToEmployee) throw routeError(409, 'Candidate has already been converted to an employee.');
      if (candidate.status !== 'Selected') throw routeError(409, 'Only candidates marked Selected can be converted to an employee.');

      const last = await Employee.findOne().sort({ createdAt: -1 }).select('empId').session(session).lean();
      const num = last?.empId ? parseInt(last.empId.replace(/\D/g, '')) || 0 : 0;
      const empId = `EMP${String(num + 1).padStart(4, '0')}`;

      const [createdEmployee] = await Employee.create([{
        empId,
        name: candidate.name,
        mobile: candidate.mobile,
        email: candidate.email,
        address: candidate.address,
        city: candidate.city,
        state: candidate.state,
        designation, department,
        dateOfJoining: new Date(dateOfJoining),
        employmentType: employmentType || 'Full Time',
        basicSalary: basicSalary || 0,
        workLocation: workLocation || '',
        reportingManager: reportingManager || '',
        branchId: req.branchId,
        // Carry the resume forward as the employee's first document.
        documents: candidate.resume?.url
          ? [{ name: candidate.resume.name || 'Resume', url: candidate.resume.url, uploadDate: candidate.resume.uploadDate || new Date() }]
          : [],
        createdBy: req.user._id,
      }], { session });

      candidate.convertedToEmployee = createdEmployee._id;
      candidate.convertedAt = new Date();
      await candidate.save({ session });
      employee = createdEmployee;
    });

    res.status(201).json({
      success: true,
      message: `Candidate converted to employee ${employee.empId}.`,
      data: employee,
    });
  } catch (error) { sendError(res, error); }
  finally { await session.endSession(); }
});

export default router;
