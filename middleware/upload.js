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
export const legacySupplierCreditNoteDirectory = path.join(uploadRoot, 'supplier-credit-notes');
export const supplierCreditNoteDirectory = path.join(privateUploadRoot, 'supplier-credit-notes');
fs.mkdirSync(productUploadDirectory, { recursive: true });
fs.mkdirSync(complaintUploadDirectory, { recursive: true });
fs.mkdirSync(webUploadDirectory, { recursive: true });
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
