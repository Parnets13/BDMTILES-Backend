import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadRoot = path.join(__dirname, '..', 'uploads');
const privateUploadRoot = path.join(__dirname, '..', 'private-uploads');
const productUploadDirectory = path.join(uploadRoot, 'products');
const complaintUploadDirectory = path.join(uploadRoot, 'complaints');
const webUploadDirectory = path.join(uploadRoot, 'web');
const webVideoDirectory = path.join(uploadRoot, 'web-videos');
export const legacySupplierCreditNoteDirectory = path.join(uploadRoot, 'supplier-credit-notes');
export const supplierCreditNoteDirectory = path.join(privateUploadRoot, 'supplier-credit-notes');
// Candidate resumes are personal/sensitive — private-uploads, never statically served.
export const candidateResumeDirectory = path.join(privateUploadRoot, 'candidate-resumes');
// Generated HR documents (offer letters, appointment letters, NDAs) — same reasoning.
export const hrGeneratedDocumentDirectory = path.join(privateUploadRoot, 'hr-documents');
fs.mkdirSync(productUploadDirectory, { recursive: true });
fs.mkdirSync(complaintUploadDirectory, { recursive: true });
fs.mkdirSync(webUploadDirectory, { recursive: true });
fs.mkdirSync(webVideoDirectory, { recursive: true });
fs.mkdirSync(supplierCreditNoteDirectory, { recursive: true });
fs.mkdirSync(candidateResumeDirectory, { recursive: true });
fs.mkdirSync(hrGeneratedDocumentDirectory, { recursive: true });

const storageFor = (directory) => multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, directory),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(file.mimetype) || allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported image type: ${file.mimetype} (${ext}). Use JPG, PNG, or WEBP.`), false);
  }
};

export const uploadProductImages = multer({
  storage: storageFor(productUploadDirectory),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
}).array('images', 10); // max 10 images

// Complaint evidence accepts short videos as well as photos (SOW 17.8
// "Image and video upload"). Videos get a larger ceiling than stills.
const complaintEvidenceFilter = (req, file, cb) => {
  const images = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const videos = ['video/mp4', 'video/quicktime', 'video/3gpp', 'video/x-matroska', 'video/webm'];
  if (images.includes(file.mimetype) || videos.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, WEBP images or MP4/MOV/3GP videos are allowed'), false);
  }
};

export const uploadComplaintEvidence = multer({
  storage: storageFor(complaintUploadDirectory),
  fileFilter: complaintEvidenceFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB covers a short clip
}).array('images', 10);

// Web Management (storefront CMS) images — hero, banners, categories, testimonials.
export const uploadWebImages = multer({
  storage: storageFor(webUploadDirectory),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).array('images', 10);

// Web Management — video testimonials (MP4, MOV, WEBM, AVI). Max 100 MB per file.
// We check BOTH mimetype and file extension because browsers/OS sometimes report
// generic mimetypes (application/octet-stream) for video files.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.m4v', '.mkv']);
const VIDEO_MIMETYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/m4v', 'application/octet-stream',
]);

const videoFileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mimeOk = VIDEO_MIMETYPES.has(file.mimetype);
  const extOk = VIDEO_EXTENSIONS.has(ext);
  if (mimeOk || extOk) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported video format. Allowed: MP4, WEBM, MOV, AVI. Got: ${file.mimetype} (${ext})`), false);
  }
};

export const uploadWebVideo = multer({
  storage: storageFor(webVideoDirectory),
  fileFilter: videoFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
}).single('video');

const creditNoteFileFilter = (_req, file, cb) => {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Supplier credit-note evidence must be PDF, JPG, PNG, or WEBP.'), false);
};

export const uploadSupplierCreditNote = multer({
  storage: storageFor(supplierCreditNoteDirectory),
  fileFilter: creditNoteFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 },
}).single('document');

const resumeFileFilter = (_req, file, cb) => {
  const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'];
  const allowedExts = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(file.mimetype) || allowedExts.includes(ext)) cb(null, true);
  else cb(new Error('Resume must be PDF, DOC, DOCX, JPG, or PNG.'), false);
};

export const uploadCandidateResume = multer({
  storage: storageFor(candidateResumeDirectory),
  fileFilter: resumeFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
}).single('resume');

// Generic upload middleware for temporary uploads (e.g., visual search)
const tempUploadDirectory = path.join(uploadRoot, 'temp');
fs.mkdirSync(tempUploadDirectory, { recursive: true });

export const upload = multer({
  storage: storageFor(tempUploadDirectory),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
