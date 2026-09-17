import { Router } from 'express';
import HeroSection from '../models/webContent/HeroSection.js';
import HomeBanner from '../models/webContent/HomeBanner.js';
import HomeCategory from '../models/webContent/HomeCategory.js';
import Testimonial from '../models/webContent/Testimonial.js';
import MarqueeItem from '../models/webContent/MarqueeItem.js';
import SiteSettings from '../models/webContent/SiteSettings.js';
import DeliveryPincode from '../models/webContent/DeliveryPincode.js';
import TileRoom from '../models/webContent/TileRoom.js';
import TileTypeItem from '../models/webContent/TileTypeItem.js';
import TileSizeItem from '../models/webContent/TileSizeItem.js';
import VideoTestimonial from '../models/webContent/VideoTestimonial.js';
import PincodeRequest from '../models/webContent/PincodeRequest.js';
import { protect, requirePermission } from '../middleware/auth.js';
import { uploadWebImages, uploadWebVideo } from '../middleware/upload.js';

const router = Router();
router.use(protect);
router.use(requirePermission('webmanagement.manage'));

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * Register standard CRUD routes for a web-content model under `basePath`.
 * All content is global (no branch scoping).
 */
function registerCrud(basePath, Model, { beforeSave } = {}) {
  // LIST
  router.get(basePath, async (req, res) => {
    try {
      const { search, status } = req.query;
      const filter = {};
      if (status) filter.status = status;
      if (search) filter.$or = [
        { title: new RegExp(search, 'i') },
        { name: new RegExp(search, 'i') },
        { pincode: new RegExp(search, 'i') },
        { area: new RegExp(search, 'i') },
        { city: new RegExp(search, 'i') },
      ];
      const items = await Model.find(filter).sort({ sortOrder: 1, createdAt: -1 }).lean();
      res.json({
        success: true,
        data: items,
        pagination: { currentPage: 1, totalPages: 1, totalItems: items.length, itemsPerPage: items.length },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // CREATE
  router.post(basePath, async (req, res) => {
    try {
      const data = { ...req.body, createdBy: req.user._id };
      if (beforeSave) beforeSave(data);
      const item = await Model.create(data);
      res.status(201).json({ success: true, message: 'Created.', data: item });
    } catch (error) {
      if (error.code === 11000) return res.status(400).json({ success: false, message: 'This entry already exists.' });
      res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
    }
  });

  // UPDATE
  router.put(`${basePath}/:id`, async (req, res) => {
    try {
      const data = { ...req.body };
      delete data.createdBy;
      if (beforeSave) beforeSave(data);
      const item = await Model.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
      if (!item) return res.status(404).json({ success: false, message: 'Not found.' });
      res.json({ success: true, message: 'Updated.', data: item });
    } catch (error) {
      if (error.code === 11000) return res.status(400).json({ success: false, message: 'This entry already exists.' });
      res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
    }
  });

  // DELETE (hard delete — CMS content is not part of the RecycleBin workflow)
  router.delete(`${basePath}/:id`, async (req, res) => {
    try {
      const item = await Model.findByIdAndDelete(req.params.id);
      if (!item) return res.status(404).json({ success: false, message: 'Not found.' });
      res.json({ success: true, message: 'Deleted.' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

// Image upload for CMS content (hero/banner/category/testimonial images).
router.post('/upload-images', (req, res) => {
  uploadWebImages(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }
    const urls = req.files.map((f) => `/uploads/web/${f.filename}`);
    res.json({ success: true, message: `${urls.length} image(s) uploaded.`, data: urls });
  });
});

// Video upload for video testimonials. Field name: 'video'. Returns a single URL.
router.post('/upload-video', (req, res) => {
  uploadWebVideo(req, res, (err) => {
    if (err) {
      console.error('[upload-video] multer error:', err.message, '| mimetype:', req.headers['content-type']);
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      console.error('[upload-video] no file received — check field name is "video" and Content-Type is multipart/form-data');
      return res.status(400).json({ success: false, message: 'No video uploaded. Make sure the file field is named "video".' });
    }
    console.log('[upload-video] saved:', req.file.filename, req.file.mimetype, req.file.size, 'bytes');
    res.json({
      success: true,
      message: 'Video uploaded.',
      data: `/uploads/web-videos/${req.file.filename}`,
    });
  });
});

// ── Site settings (singleton: header logo, brand text, phone number) ──
router.get('/site-settings', async (_req, res) => {
  try {
    let settings = await SiteSettings.findOne({ key: 'default' }).lean();
    if (!settings) settings = (await SiteSettings.create({ key: 'default' })).toObject();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/site-settings', async (req, res) => {
  try {
    const editable = ['logo', 'brandName', 'brandTagline', 'phoneNumber', 'phoneLabel'];
    const update = { updatedBy: req.user._id };
    for (const key of editable) {
      if (req.body?.[key] !== undefined) update[key] = String(req.body[key]);
    }
    const settings = await SiteSettings.findOneAndUpdate(
      { key: 'default' },
      { $set: update },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, message: 'Site settings updated.', data: settings });
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 422 : 500).json({ success: false, message: error.message });
  }
});

registerCrud('/hero', HeroSection);
registerCrud('/marquee', MarqueeItem);
registerCrud('/pincodes', DeliveryPincode, {
  beforeSave: (data) => { if (data.pincode) data.pincode = String(data.pincode).trim(); },
});
registerCrud('/banners', HomeBanner);
registerCrud('/categories', HomeCategory, {
  beforeSave: (data) => {
    if (!data.slug && data.name) data.slug = slugify(data.name);
    else if (data.slug) data.slug = slugify(data.slug);
  },
});
registerCrud('/testimonials', Testimonial);
registerCrud('/tile-rooms', TileRoom);
registerCrud('/tile-types', TileTypeItem);
registerCrud('/tile-sizes', TileSizeItem);
registerCrud('/video-testimonials', VideoTestimonial);

// Pincode requests (read-only list for CRM staff — customers submit via the website)
router.get('/pincode-requests', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const items = await PincodeRequest.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: items, pagination: { currentPage: 1, totalPages: 1, totalItems: items.length, itemsPerPage: items.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/pincode-requests/:id', async (req, res) => {
  try {
    const allowed = ['pending', 'acknowledged', 'added'];
    const status = req.body?.status;
    if (!allowed.includes(status)) return res.status(422).json({ success: false, message: 'Invalid status.' });
    const item = await PincodeRequest.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Updated.', data: item });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
