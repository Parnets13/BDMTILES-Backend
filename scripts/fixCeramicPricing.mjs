import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bdmtiles';

async function fixCeramicPricing() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✓ Connected to MongoDB');

    const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }), 'products');

    // Find the ceramic white and gold product
    const product = await Product.findOne({ 
      productCode: 'BDM000001'
    });

    if (!product) {
      console.log('❌ Product BDM000001 not found');
      return;
    }

    console.log('\n=== BEFORE FIX ===');
    console.log('Product:', product.name);
    console.log('Product Code:', product.productCode);
    console.log('MRP:', product.mrp);
    console.log('Dealer Rate:', product.dealerRate);
    console.log('Distributor Rate:', product.distributorRate);

    // Check if dealerRate is >= MRP (this is the problem)
    if (product.dealerRate >= product.mrp) {
      console.log('\n⚠️  ISSUE FOUND: dealerRate (₹' + product.dealerRate + ') >= MRP (₹' + product.mrp + ')');
      
      // Fix: Set dealerRate to 85% of MRP (reasonable discount)
      const newDealerRate = Math.round(product.mrp * 0.85);
      
      product.dealerRate = newDealerRate;
      
      // Also ensure distributorRate is reasonable (80% of MRP)
      if (product.distributorRate >= product.mrp || product.distributorRate >= newDealerRate) {
        product.distributorRate = Math.round(product.mrp * 0.80);
      }
      
      await product.save();
      
      console.log('\n=== AFTER FIX ===');
      console.log('MRP:', product.mrp);
      console.log('Dealer Rate:', product.dealerRate, '→ Discount:', Math.round(((product.mrp - product.dealerRate) / product.mrp) * 100) + '%');
      console.log('Distributor Rate:', product.distributorRate, '→ Discount:', Math.round(((product.mrp - product.distributorRate) / product.mrp) * 100) + '%');
      console.log('\n✓ Pricing fixed successfully!');
    } else {
      console.log('\n✓ Pricing is already correct');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
  }
}

fixCeramicPricing();
