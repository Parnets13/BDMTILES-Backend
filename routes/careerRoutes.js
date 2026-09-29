import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { logActivity } from '../middleware/activityLogger.js';
import { candidateResumeDirectory, uploadPublicApplicationResume } from '../middleware/upload.js';
import Branch from '../models/Branch.js';
import Candidate from '../models/Candidate.js';
import JobOpening from '../models/JobOpening.js';
import { scoreCandidate } from '../services/atsScoring.js';

/**
 * Public careers API (BDM Tiles website). Mounted at /api/v1/careers.
 *
 * This router is the ONLY recruitment surface reachable without a staff JWT, so the
 * design rule throughout is: expose the minimum that a job seeker legitimately needs,
 * and never echo anything back that reveals internal state.
 *
 * Specifically NOT exposed here:
 *   - candidateCount / applicant volume per opening (competitive info)
 *   - any candidate record, list, or search
 *   - resume download (permission-gated elsewhere)
 *   - branch ids, createdBy, internal notes
 * A submission returns only a receipt code and a success flag.
 */
const router = Router();

const numberFromEnv = (key, fallback) => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Application spam is the realistic abuse case: the endpoint is anonymous and each
// submission writes a row and a file to disk. Limits are tighter than a login because
// a genuine applicant applies once or twice, not twenty times.
const applyLimiter = rateLimit({
  windowMs: numberFromEnv('CAREERS_APPLY_RATE_LIMIT_WINDOW_MINUTES', 60) * 60 * 1000,
  limit: numberFromEnv('CAREERS_APPLY_RATE_LIMIT_MAX', 5),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    message: 'Too many applications submitted from this connection. Please try again later.',
  }),
});

const listLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: numberFromEnv('CAREERS_LIST_RATE_LIMIT_MAX', 300),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    message: 'Too many requests. Please try again shortly.',
  }),
});

const sendError = (res, error) => {
  const status = error?.status || 500;
  // Never leak a stack trace or a raw Mongoose message to an anonymous caller.
  res.status(status).json({
    success: false,
    message: status >= 500 ? 'Something went wrong. Please try again.' : error.message,
  });
};

const routeError = (status, message) => Object.assign(new Error(message), { status });

const normalizeMobile = (value) => String(value || '').replace(/[^\d]/g, '');
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

/**
 * Strip an opening down to what is safe and useful on a public web page.
 *
 * `salaryRange` is formatted here rather than on the client so the website, a future
 * mobile careers screen and any partner feed all render the same figure.
 */
const toPublicJob = (job) => {
  const { min = 0, max = 0, period = 'year' } = job.salaryRange || {};
  const lakh = (n) => (n / 100000).toFixed(1).replace(/\.0$/, '');
  let salary = '';
  if (min && max) salary = period === 'month' ? `₹${min.toLocaleString('en-IN')} – ₹${max.toLocaleString('en-IN')} / month` : `₹${lakh(min)}L – ₹${lakh(max)}L / year`;
  else if (min) salary = period === 'month' ? `From ₹${min.toLocaleString('en-IN')} / month` : `From ₹${lakh(min)}L / year`;

  return {
    code: job.jobCode,
    title: job.title,
    department: job.department,
    designation: job.designation,
    location: job.location || job.branch || '',
    employmentType: job.employmentType,
    jobMode: job.jobMode,
    experienceRequired: job.experienceRequired,
    positions: job.positions,
    description: job.description,
    requirements: job.requirements,
    tags: job.tags || [],
    salaryRange: { min, max, period },
    salaryLabel: salary,
    postedDate: job.postedDate,
    closingDate: job.closingDate || null,
  };
};

// ── GET /careers/jobs — public listings ──────────────────────────────────────
router.get('/jobs', listLimiter, async (req, res) => {
  try {
    const { search, department, mode } = req.query;
    const filter = JobOpening.publicFilter();

    if (department) filter.department = department;
    if (mode) filter.jobMode = mode;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = [...(filter.$and || []), { $or: [{ title: rx }, { department: rx }, { tags: rx }] }];
    }

    // Newest first — a candidate should not have to hunt for what was just published.
    const jobs = await JobOpening.find(filter).sort({ postedDate: -1, createdAt: -1 }).limit(200).lean();

    // Departments drive the public filter chips, so derive them from what is actually
    // published rather than from a hardcoded list that would drift.
    const departments = Array.from(new Set(jobs.map((j) => j.department).filter(Boolean))).sort();

    res.json({
      success: true,
      data: { jobs: jobs.map(toPublicJob), departments, total: jobs.length },
    });
  } catch (error) { sendError(res, error); }
});

// ── GET /careers/jobs/:code — one opening ────────────────────────────────────
router.get('/jobs/:code', listLimiter, async (req, res) => {
  try {
    const job = await JobOpening.findOne({
      ...JobOpening.publicFilter(),
      jobCode: String(req.params.code).trim().toUpperCase(),
    }).lean();
    if (!job) throw routeError(404, 'That job is no longer available.');
    res.json({ success: true, data: toPublicJob(job) });
  } catch (error) { sendError(res, error); }
});

// ── POST /careers/apply — public application ─────────────────────────────────
router.post('/apply', applyLimiter, (req, res) => {
  uploadPublicApplicationResume(req, res, async (uploadError) => {
    // A rejected file type or an oversized upload arrives here as a multer error.
    // The partial file (if any) must be cleaned up or every bot attempt leaks disk.
    if (uploadError) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ success: false, message: uploadError.message });
    }
    if (!req.file) {
      return res.status(422).json({ success: false, message: 'Please attach your resume (PDF or Word).' });
    }

    try {
      const {
        jobCode, name, mobile, email, city, state, address,
        qualification, experience, currentEmployer, expectedSalary, notes,
      } = req.body || {};

      const cleanName = String(name || '').trim();
      const cleanMobile = normalizeMobile(mobile);

      if (!cleanName) throw routeError(422, 'Please enter your full name.');
      // 10 digits is the practical Indian mobile length; loosen only if needed.
      if (cleanMobile.length < 10) throw routeError(422, 'Please enter a valid 10-digit mobile number.');
      if (!isEmail(email)) throw routeError(422, 'Please enter a valid email address.');

      const job = await JobOpening.findOne({
        ...JobOpening.publicFilter(),
        jobCode: String(jobCode || '').trim().toUpperCase(),
      }).lean();
      // Deliberately the same 404 as "not published" — a closed or internal opening
      // must not be distinguishable from one that never existed.
      if (!job) throw routeError(404, 'That job is no longer accepting applications.');

      // Duplicate guard. Same mobile + same opening = one application. Without this a
      // refreshed page or an impatient double-tap silently creates parallel rows, and
      // HR ends up interviewing the same person twice.
      const existing = await Candidate.findOne({
        mobile: cleanMobile,
        jobOpening: job._id,
      }).lean();
      if (existing) {
        // Remove the file just written — this submission adds nothing.
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(409).json({
          success: false,
          message: 'We already have an application from this number for this position.',
        });
      }

      const candidateCode = await Candidate.generateCandidateCode();

      // Branch context: candidates are branch-scoped everywhere else in the system, and
      // a public applicant has no branch. Inherit the opening's branch so the application
      // lands in the same pipeline queue the opening belongs to. If the opening has none
      // (older rows predate branchId), fall back to any active branch rather than writing
      // a null branchId that would make the record invisible to every scoped list.
      // Branch activity is `status: 'active'`, not a boolean — matching branchRoutes.js.
      const branchId = job.branchId
        || (await Branch.findOne({ status: 'active' }).sort({ name: 1 }).select('_id').lean())?._id;

      const candidate = await Candidate.create({
        candidateCode,
        name: cleanName,
        mobile: cleanMobile,
        email: String(email).trim().toLowerCase(),
        address: String(address || '').trim(),
        city: String(city || '').trim(),
        state: String(state || '').trim(),
        qualification: String(qualification || '').trim(),
        experience: String(experience || '').trim(),
        currentEmployer: String(currentEmployer || '').trim(),
        expectedSalary: Number(expectedSalary) || 0,
        // Fixed, because this arrival path has exactly one meaning: they came from the
        // public careers site. Distinguishing source matters in reporting later.
        source: 'job_portal',
        jobOpening: job._id,
        branchId,
        branch: job.branch || '',
        resume: {
          name: req.file.originalname,
          url: req.file.filename,
          uploadDate: new Date(),
        },
        status: 'Applied',
        notes: String(notes || '').trim().slice(0, 2000),
      });

      // Score once at intake and store nothing — scoring is cheap and pure, so keeping a
      // copy on the document would let it drift from the current rules. The admin list
      // recomputes on read; this call exists so the receipt can state the score.
      const result = scoreCandidate(candidate.toObject(), job);

      // Public submissions bypass the autoLog middleware (which only wraps authenticated
      // mutations), so log explicitly. Without this, applications would appear with no
      // trace of where they came from — the one thing HR would want to audit.
      logActivity({
        action: 'create',
        module: 'recruitment',
        recordId: candidate._id,
        recordTitle: `${candidate.name} — ${job.title}`,
        recordModel: 'Candidate',
        description: `Public careers-site application for ${job.jobCode} (${job.title})`,
        metadata: { candidateCode, jobCode: job.jobCode, source: 'careers_site', score: result.score },
        req,
        branchId,
      }).catch(() => {});

      res.status(201).json({
        success: true,
        message: 'Application received. Our HR team will contact you if your profile matches.',
        data: {
          // A receipt the applicant can quote in a follow-up email. The numeric part is
          // the safe public handle — the Mongo id is never exposed.
          reference: candidateCode,
          jobTitle: job.title,
        },
      });
    } catch (error) {
      // Any failure after the file was written leaves an orphan on disk.
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      sendError(res, error);
    }
  });
});

export default router;
