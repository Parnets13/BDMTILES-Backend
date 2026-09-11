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
fs.mkdirSync(productUploadDirectory, { recursive: true });
fs.mkdirSync(complaintUploadDirectory, { recursive: true });
fs.mkdirSync(webUploadDirectory, { recursive: true });
fs.mkdirSync(webVideoDirectory, { recursive: true });
fs.mkdirSync(supplierCreditNoteDirectory, { recursive: true });

const storageFor = (directory) => multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, directory),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, WEBP images are allowed'), false);
  }
};

export const uploadProductImages = multer({
  storage: storageFor(productUploadDirectory),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
}).array('images', 10); // max 10 images

export const uploadComplaintEvidence = multer({
  storage: storageFor(complaintUploadDirectory),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
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
