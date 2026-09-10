import { Router } from 'express';
import HeroSection from '../../models/webContent/HeroSection.js';
import HomeBanner from '../../models/webContent/HomeBanner.js';
import HomeCategory from '../../models/webContent/HomeCategory.js';
import Testimonial from '../../models/webContent/Testimonial.js';
import MarqueeItem from '../../models/webContent/MarqueeItem.js';
import SiteSettings from '../../models/webContent/SiteSettings.js';
import DeliveryPincode from '../../models/webContent/DeliveryPincode.js';
import TileRoom from '../../models/webContent/TileRoom.js';
import TileTypeItem from '../../models/webContent/TileTypeItem.js';
import TileSizeItem from '../../models/webContent/TileSizeItem.js';

const router = Router();

// GET /api/v1/shop/content/pincode/:pincode — is this pincode serviceable?
// Public, no auth. Used by the storefront "Deliver To" checker.
router.get('/pincode/:pincode', async (req, res) => {
  try {
    const pincode = String(req.params.pincode || '').trim();
    const entry = await DeliveryPincode.findOne({ pincode, status: 'active' }).lean();
    if (!entry) {
      return res.json({ success: true, data: { serviceable: false, pincode } });
    }
    res.json({
      success: true,
      data: {
        serviceable: true,
        pincode: entry.pincode,
        area: entry.area || '',
        city: entry.city || '',
        deliveryDays: entry.deliveryDays ?? null,
        codAvailable: entry.codAvailable !== false,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const ACTIVE = { status: 'active' };
const bySort = { sortOrder: 1, createdAt: -1 };

// GET /api/v1/shop/content — all active storefront home content in one call.
// Public, no auth, no branch. Consumed by the bdm-tiles-web home page.
router.get('/', async (_req, res) => {
  try {
    const [hero, banners, categories, testimonials, marquee, settings, tileRooms, tileTypes, tileSizes] = await Promise.all([
      HeroSection.find(ACTIVE).sort(bySort).lean(),
      HomeBanner.find(ACTIVE).sort(bySort).lean(),
      HomeCategory.find(ACTIVE).sort(bySort).lean(),
      Testimonial.find(ACTIVE).sort(bySort).lean(),
      MarqueeItem.find(ACTIVE).sort(bySort).lean(),
      SiteSettings.findOne({ key: 'default' }).lean(),
      TileRoom.find(ACTIVE).sort(bySort).lean(),
      TileTypeItem.find(ACTIVE).sort(bySort).lean(),
      TileSizeItem.find(ACTIVE).sort(bySort).lean(),
    ]);

    res.json({
      success: true,
      data: {
        siteSettings: {
          logo: settings?.logo || '',
          brandName: settings?.brandName || 'BDM TILES',
          brandTagline: settings?.brandTagline || 'BISHNOI CERAMICS',
          phoneNumber: settings?.phoneNumber || '',
          phoneLabel: settings?.phoneLabel || 'Call us',
        },
        marquee: marquee.map((m) => ({
          id: m._id,
          icon: m.icon || 'fa-circle-check',
          title: m.title,
          subtitle: m.subtitle || '',
        })),
        hero: hero.map((h) => ({
          id: h._id,
          title: h.title,
          subtitle: h.subtitle || '',
          image: h.image || '',
          ctaLabel: h.ctaLabel || '',
          ctaLink: h.ctaLink || '',
        })),
        banners: banners.map((b) => ({
          id: b._id,
          eyebrow: b.eyebrow || '',
          title: b.title,
          subtitle: b.subtitle || '',
          image: b.image || '',
          ctaLabel: b.ctaLabel || 'Shop Now',
          bgColor: b.bgColor || '',
          bgOpacity: b.bgOpacity ?? 1,
          textColor: b.textColor || '',
          size: b.size || 'small',
          overlayStyle: b.overlayStyle || 'gradient',
          gradientDirection: b.gradientDirection || 'to right',
          link: b.link || '',
        })),
        categories: categories.map((c) => ({
          id: c._id,
          name: c.name,
          slug: c.slug || '',
          image: c.image || '',
          badge: c.badge || '',
        })),
        testimonials: testimonials.map((t) => ({
          id: t._id,
          name: t.name,
          image: t.image || '',
          badge: t.badge || '',
          quote: t.quote,
          caption: t.caption || '',
          rating: t.rating ?? 5,
        })),
        tileRooms: tileRooms.map((r) => ({
          id: r._id,
          name: r.name,
          icon: r.icon || 'fa-couch',
          image: r.image || '',
          query: r.query || '',
        })),
        tileTypes: tileTypes.map((t) => ({
          id: t._id,
          name: t.name,
          desc: t.desc || '',
          image: t.image || '',
          query: t.query || '',
          badge: t.badge || '',
        })),
        tileSizes: tileSizes.map((s) => ({
          id: s._id,
          label: s.label,
          sub: s.sub || 'mm',
          image: s.image || '',
          query: s.query || '',
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
