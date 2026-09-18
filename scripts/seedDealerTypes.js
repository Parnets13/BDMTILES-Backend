import mongoose from 'mongoose';
import dotenv from 'dotenv';
import DealerType from '../models/DealerType.js';

dotenv.config();

const DEFAULT_TYPES = [
  { name: 'Dealer', description: 'Regular dealer with dealer pricing', pricingTier: 'dealerRate', isDefault: true },
  { name: 'Wholesaler', description: 'Wholesale buyer with wholesale pricing', pricingTier: 'wholesaleRate', isDefault: true },
  { name: 'Distributor', description: 'Area distributor with distributor pricing', pricingTier: 'distributorRate', isDefault: true },
  { name: 'Retailer', description: 'Retail customer with retail pricing', pricingTier: 'retailRate', isDefault: true },
  { name: 'Builder', description: 'Builder/Architect with project pricing', pricingTier: 'builderRate', isDefault: true },
  { name: 'Sub-Dealer', description: 'Sub-dealer under a dealer', pricingTier: 'dealerRate', isDefault: true },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    for (const type of DEFAULT_TYPES) {
      const exists = await DealerType.findOne({ name: type.name });
      if (!exists) {
        await DealerType.create(type);
        console.log(`✅ Created: ${type.name} → ${type.pricingTier}`);
      } else {
        // Update existing with pricingTier if missing
        if (!exists.pricingTier) {
          exists.pricingTier = type.pricingTier;
          exists.isDefault = true;
          await exists.save();
          console.log(`🔄 Updated: ${type.name} → ${type.pricingTier}`);
        } else {
          console.log(`⏭ Skipped (exists): ${type.name}`);
        }
      }
    }

    console.log('\n✅ Dealer types seeded successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
