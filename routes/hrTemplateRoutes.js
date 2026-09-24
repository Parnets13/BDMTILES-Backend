import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import HrDocumentTemplate from '../models/HrDocumentTemplate.js';
import Employee from '../models/Employee.js';
import EmployeeExit from '../models/EmployeeExit.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';
import { hrGeneratedDocumentDirectory } from '../middleware/upload.js';
import { renderTemplate, extractVariables, generateHrDocumentPdf } from '../services/hrDocumentService.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const routeError = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, error) => res.status(error.status || (['CastError', 'ValidationError'].includes(error.name) ? 422 : 500))
  .json({ success: false, message: error.message });
const validObjectId = (id) => mongoose.isValidObjectId(id);

const access = [requirePermission('hr.template.manage')];

// ═══════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════
router.get('/templates', ...access, async (req, res) => {
  try {
    const { search, documentType, isActive } = req.query;
    const filter = { branch: req.branchId };
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ templateName: regex }, { templateCode: regex }];
    }
    if (documentType) filter.documentType = documentType;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    const templates = await HrDocumentTemplate.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: templates });
  } catch (error) { sendError(res, error); }
});

router.get('/templates/:id', ...access, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid template id.');
    const template = await HrDocumentTemplate.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!template) throw routeError(404, 'Template not found.');
    res.json({ success: true, data: template });
  } catch (error) { sendError(res, error); }
});

router.post('/templates', ...access, async (req, res) => {
  try {
    const { templateName, documentType, content } = req.body;
    if (!templateName || !documentType || !content) throw routeError(422, 'Template name, document type, and content are required.');
    const last = await HrDocumentTemplate.findOne({ branch: req.branchId }).sort({ createdAt: -1 }).select('templateCode').lean();
    const num = last?.templateCode ? parseInt(last.templateCode.replace(/\D/g, '')) || 0 : 0;
    const templateCode = `TPL${String(num + 1).padStart(4, '0')}`;
    const template = await HrDocumentTemplate.create({
      branch: req.branchId, templateCode, templateName, documentType, content,
      variables: extractVariables(content), createdBy: req.user._id,
    });
    res.status(201).json({ success: true, message: 'Template created.', data: template });
  } catch (error) { sendError(res, error); }
});

router.put('/templates/:id', ...access, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid template id.');
    const { templateName, documentType, content, isActive } = req.body;
    const updates = {};
    if (templateName !== undefined) updates.templateName = templateName;
    if (documentType !== undefined) updates.documentType = documentType;
    if (isActive !== undefined) updates.isActive = isActive;
    if (content !== undefined) {
      updates.content = content;
      updates.variables = extractVariables(content);
    }
    const template = await HrDocumentTemplate.findOneAndUpdate({ _id: req.params.id, branch: req.branchId }, updates, { new: true, runValidators: true });
    if (!template) throw routeError(404, 'Template not found.');
    res.json({ success: true, message: 'Template updated.', data: template });
  } catch (error) { sendError(res, error); }
});

router.delete('/templates/:id', ...access, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid template id.');
    const template = await HrDocumentTemplate.findOneAndDelete({ _id: req.params.id, branch: req.branchId });
    if (!template) throw routeError(404, 'Template not found.');
    res.json({ success: true, message: 'Template deleted.' });
  } catch (error) { sendError(res, error); }
});

// ═══════════════════════════════════════
// EMPLOYEE FIELD MAPPING + GENERATE
// ═══════════════════════════════════════
// Maps template placeholder names to Employee fields / derived values. Keep this
// list in sync with what's exposed in the frontend's "insert field" helper.
const fmtLongDate = (value) => (value
  ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
  : '');

/** "3 years 2 months" — what a relieving or experience letter actually states. */
const describeTenure = (from, to) => {
  if (!from || !to) return '';
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return '';
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  const years = Math.floor(Math.max(0, months) / 12);
  const rest = Math.max(0, months) % 12;
  const parts = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (rest) parts.push(`${rest} month${rest === 1 ? '' : 's'}`);
  return parts.join(' ') || 'less than a month';
};

// The most recent exit case, so relieving and experience letters can be rendered
// from the case that is actually in progress rather than from the bare
// Employee.exitDate (which is only written at the very end of the exit).
const loadLatestExit = (employeeId, branchId) => EmployeeExit
  .findOne({ employee: employeeId, branch: branchId })
  .sort({ createdAt: -1 })
  .lean();

const buildEmployeeContext = (employee, exitCase = null) => ({
  employeeName: employee.name || '',
  empId: employee.empId || '',
  designation: employee.designation || '',
  department: employee.department || '',
  joiningDate: employee.dateOfJoining ? new Date(employee.dateOfJoining).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '',
  salary: employee.netSalary ? Number(employee.netSalary).toLocaleString('en-IN') : '',
  grossSalary: employee.grossSalary ? Number(employee.grossSalary).toLocaleString('en-IN') : '',
  basicSalary: employee.basicSalary ? Number(employee.basicSalary).toLocaleString('en-IN') : '',
  employeeMobile: employee.mobile || '',
  employeeEmail: employee.email || '',
  employeeAddress: employee.address || '',
  reportingManager: employee.reportingManager || '',
  workLocation: employee.workLocation || '',
  employmentType: employee.employmentType || '',
  companyName: 'BDM GRANIMARMO PRIVATE LIMITED',
  today: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),

  // ── Exit context (Relieving Letter / Experience Certificate) ──────────
  // Prefers the open exit case, falls back to the Employee record once the exit
  // has been completed. Empty when the employee is not exiting, which leaves the
  // placeholder visible in the output rather than rendering a misleading blank date.
  lastWorkingDay: fmtLongDate(exitCase?.approvedLastWorkingDay
    || exitCase?.requestedLastWorkingDay
    || employee.exitDate),
  exitDate: fmtLongDate(employee.exitDate || exitCase?.approvedLastWorkingDay),
  exitReason: exitCase?.reason || employee.exitReason || '',
  exitType: exitCase?.exitType || '',
  resignationDate: fmtLongDate(exitCase?.resignationDate),
  tenure: describeTenure(
    employee.dateOfJoining,
    exitCase?.approvedLastWorkingDay || exitCase?.requestedLastWorkingDay || employee.exitDate
  ),
  settlementNetPayable: exitCase?.settlement?.netPayable
    ? Number(exitCase.settlement.netPayable).toLocaleString('en-IN')
    : '',
});

router.get('/field-map', ...access, (req, res) => {
  res.json({
    success: true,
    data: Object.keys(buildEmployeeContext({}, {})).map((key) => ({ variable: `{{${key}}}`, key })),
  });
});

// Preview: returns the rendered plain text without generating a PDF or touching the employee record.
router.post('/templates/:id/preview', ...access, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid template id.');
    if (!validObjectId(req.body.employeeId)) throw routeError(422, 'A valid employeeId is required.');
    const template = await HrDocumentTemplate.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!template) throw routeError(404, 'Template not found.');
    const employee = await Employee.findOne({ _id: req.body.employeeId, branchId: req.branchId }).lean();
    if (!employee) throw routeError(404, 'Employee not found in the active branch.');
    const exitCase = await loadLatestExit(employee._id, req.branchId);
    const context = buildEmployeeContext(employee, exitCase);
    res.json({ success: true, data: { rendered: renderTemplate(template.content, context), context } });
  } catch (error) { sendError(res, error); }
});

// Generate: renders the template, writes a PDF into private-uploads/hr-documents,
// and pushes it into Employee.documents so it shows up in the employee's file.
router.post('/templates/:id/generate', ...access, async (req, res) => {
  try {
    if (!validObjectId(req.params.id)) throw routeError(400, 'Invalid template id.');
    if (!validObjectId(req.body.employeeId)) throw routeError(422, 'A valid employeeId is required.');
    const template = await HrDocumentTemplate.findOne({ _id: req.params.id, branch: req.branchId }).lean();
    if (!template) throw routeError(404, 'Template not found.');
    const employee = await Employee.findOne({ _id: req.body.employeeId, branchId: req.branchId });
    if (!employee) throw routeError(404, 'Employee not found in the active branch.');

    const exitCase = await loadLatestExit(employee._id, req.branchId);
    const context = buildEmployeeContext(employee, exitCase);
    const rendered = renderTemplate(template.content, context);
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
    const filePath = path.join(hrGeneratedDocumentDirectory, fileName);
    await generateHrDocumentPdf({ filePath, title: template.documentType, renderedContent: rendered });

    const docName = `${template.documentType} - ${employee.name}`;
    employee.documents.push({ name: docName, url: fileName, uploadDate: new Date() });
    await employee.save();

    // Mirror exit letters onto the open exit case so the case shows what the
    // employee actually walked away with.
    if (exitCase && ['Relieving Letter', 'Experience Certificate'].includes(template.documentType)) {
      await EmployeeExit.updateOne(
        { _id: exitCase._id },
        {
          $push: {
            documentsIssued: {
              documentType: template.documentType,
              fileName,
              issuedAt: new Date(),
              issuedBy: req.user._id,
            },
          },
        }
      );
    }

    res.status(201).json({
      success: true,
      message: `${template.documentType} generated and saved to employee documents.`,
      data: { fileName, docName, employeeId: employee._id },
    });
  } catch (error) { sendError(res, error); }
});

// Authenticated download for a generated HR document (private-uploads, not statically served).
router.get('/documents/:fileName', ...access, async (req, res) => {
  try {
    const storedName = path.basename(req.params.fileName);
    if (storedName !== req.params.fileName) throw routeError(400, 'Invalid file reference.');
    const filePath = path.join(hrGeneratedDocumentDirectory, storedName);
    const content = await fs.promises.readFile(filePath);
    res.type('application/pdf');
    res.attachment(storedName);
    res.send(content);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ success: false, message: 'Document not found.' });
    sendError(res, error);
  }
});

export default router;
