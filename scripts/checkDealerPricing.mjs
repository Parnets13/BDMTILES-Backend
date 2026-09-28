#!/usr/bin/env node
/**
 * Check dealer pricing for a specific mobile number
 * Usage: node scripts/checkDealerPricing.mjs 9876543212
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import Dealer from '../models/Dealer.js';
import Product from '../models/Product.js';
import DealerPricing from '../models/DealerPricing.js';

const mobile = process.argv[2] || '9876543212';

await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

console.log(`\n🔍 Checking pricing for dealer: ${mobile}\n`);

// 1. Find the dealer
const dealer = await Dealer.findOne({ mobile }).lean();
if (!dealer) {
  console.error(`❌ No dealer found with mobile: ${mobile}`);
  process.exit(1);
}

console.log(`✓ Dealer found: ${dealer.name}`);
console.log(`  Type: ${dealer.dealerType}`);
console.log(`  Pricing Tier: ${dealer.pricingTier || 'NOT SET'}`);
console.log(`  Custom Pricing: ${dealer.customPricing ? 'YES' : 'NO'}`);
console.log(`  Branch: ${dealer.branch}\n`);

// 2. Check how many products they should see
const activeProducts = await Product.countDocuments({ 
  status: 'active', 
  dealerVisible: { $ne: false } 
});
console.log(`📦 Active products in catalogue: ${activeProducts}\n`);

// 3. Get a sample product and show what pricing would be applied
const sampleProduct = await Product.findOne({ 
  status: 'active', 
  dealerVisible: { $ne: false } 
}).lean();

if (sampleProduct) {
  console.log(`📊 Sample product: ${sampleProduct.itemName}`);
  console.log(`   Product Code: ${sampleProduct.productCode}`);
  console.log(`   MRP: ₹${sampleProduct.mrp || 'NOT SET'}`);
  console.log(`   Dealer Rate (default): ₹${sampleProduct.dealerRate || 'NOT SET'}`);
  console.log(`   Distributor Rate: ₹${sampleProduct.distributorRate || 'NOT SET'}`);
  console.log(`   Wholesaler Rate: ₹${sampleProduct.wholesaleRate || 'NOT SET'}`);
  console.log(`   Retailer Rate: ₹${sampleProduct.retailRate || 'NOT SET'}`);
  console.log(`   Builder Rate: ₹${sampleProduct.builderRate || 'NOT SET'}\n`);

  // 4. Check if there's custom pricing for this dealer
  const customPrice = await DealerPricing.findOne({
    dealer: dealer._id,
    product: sampleProduct._id,
    isActive: true
  }).lean();

  if (customPrice) {
    console.log(`✓ Custom pricing found:`);
    console.log(`   Custom Rate: ₹${customPrice.customRate}`);
    console.log(`   Discount: ${customPrice.discountPercent}%\n`);
  } else {
    console.log(`❌ No custom pricing found\n`);
  }

  // 5. Show what would be sent to the app
  const pricingTier = dealer.pricingTier || 'dealerRate';
  const effectiveRate = customPrice?.customRate 
    || sampleProduct[pricingTier] 
    || sampleProduct.dealerRate;

  console.log(`📱 What the app would receive:`);
  console.log(`   Pricing Tier Used: ${pricingTier}`);
  console.log(`   Effective Rate: ₹${effectiveRate || 'NULL'}`);
  console.log(`   MRP: ₹${sampleProduct.mrp || 'NULL'}`);
  
  if (effectiveRate && sampleProduct.mrp && effectiveRate < sampleProduct.mrp) {
    const discount = Math.round(((sampleProduct.mrp - effectiveRate) / sampleProduct.mrp) * 100);
    const saving = sampleProduct.mrp - effectiveRate;
    console.log(`   Discount: ${discount}% off`);
    console.log(`   Saving: ₹${saving.toFixed(2)}`);
    console.log(`\n✅ Display will show:`);
    console.log(`      ₹${effectiveRate} (big, primary color)`);
    console.log(`      ₹${sampleProduct.mrp} (strikethrough) ${discount}% off (green pill)`);
  } else {
    console.log(`\n⚠️  No discount shown (rate >= MRP or missing)`);
  }
}

// 6. Check if dealer has any custom pricing entries
const customPricingCount = await DealerPricing.countDocuments({
  dealer: dealer._id,
  isActive: true
});

console.log(`\n📋 Custom pricing entries: ${customPricingCount}`);

await mongoose.disconnect();
