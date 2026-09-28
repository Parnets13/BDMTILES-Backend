import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bdmtiles';

async function testProductDetailPricing() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✓ Connected to MongoDB\n');

    const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }), 'products');
    const Dealer = mongoose.model('Dealer', new mongoose.Schema({}, { strict: false }), 'dealers');

    // Test with distributor 9876543212 (if exists)
    const dealer = await Dealer.findOne({ 
      $or: [
        { mobile: '9876543212' },
        { mobile: '+919876543212' },
        { ownerMobile: '9876543212' }
      ]
    }).lean();
    
    if (dealer) {
      console.log('=== DEALER INFO ===');
      console.log('Business Name:', dealer.businessName);
      console.log('Mobile:', dealer.mobile);
      console.log('Dealer Type:', dealer.dealerType);
      console.log('');
    } else {
      console.log('⚠️  Dealer 9876543212 not found in database');
      console.log('   (This is OK - checking product pricing only)\n');
    }

    // Test with Ceramic White and Gold product
    const product = await Product.findOne({ 
      $or: [
        { productCode: 'BDM000001' },
        { itemName: /ceramic.*white.*gold/i }
      ]
    }).lean();
    if (!product) {
      console.log('❌ Product BDM000001 not found');
      return;
    }

    console.log('=== PRODUCT INFO ===');
    console.log('Product:', product.itemName);
    console.log('Product Code:', product.productCode);
    console.log('');

    console.log('=== PRICING TIERS ===');
    console.log('MRP:', product.mrp ? '₹' + product.mrp : 'Not set');
    console.log('Dealer Rate:', product.dealerRate ? '₹' + product.dealerRate : 'Not set');
    console.log('Distributor Rate:', product.distributorRate ? '₹' + product.distributorRate : 'Not set');
    console.log('Retailer Rate:', product.retailRate ? '₹' + product.retailRate : 'Not set');
    console.log('');

    // Simulate what the API will return
    console.log('=== API RESPONSE SIMULATION ===');
    console.log('For catalogue detail endpoint:');
    console.log('pricing.dealerRate (shown in app):', product.dealerRate ? '₹' + product.dealerRate : 'Not set');
    console.log('pricing.effectiveRate (applied in cart):', '₹' + (product.dealerRate || 0) + ' (after discount mapping if any)');
    console.log('');
    
    console.log('=== EXPECTED BEHAVIOR ===');
    console.log('1. Product Detail Screen should show:', product.dealerRate ? '₹' + product.dealerRate : 'Not set');
    console.log('2. MRP should show with strikethrough:', product.mrp ? '₹' + product.mrp : 'Not set');
    if (product.mrp && product.dealerRate && product.dealerRate < product.mrp) {
      const discount = Math.round(((product.mrp - product.dealerRate) / product.mrp) * 100);
      console.log('3. Discount badge should show:', discount + '%');
      console.log('4. Savings per unit:', '₹' + (product.mrp - product.dealerRate));
    } else {
      console.log('3. ⚠️  No discount shown (dealerRate >= MRP or missing)');
    }
    console.log('5. When added to cart, discount mapping will be applied');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
  }
}

testProductDetailPricing();
