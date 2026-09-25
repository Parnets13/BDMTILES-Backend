#!/usr/bin/env node
/**
 * Find and fix pricing for "Ceramic White and Gold" product
 * Shows what's wrong and fixes it
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import Product from '../models/Product.js';
import Dealer from '../models/Dealer.js';
import DealerPricing from '../models/DealerPricing.js';

await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

console.log(`\n🔍 Finding "Ceramic White and Gold" product...\n`);

// 1. Find the product
const product = await Product.findOne({
  $or: [
    { itemName: /ceramic.*white.*gold/i },
    { itemName: /white.*gold.*ceramic/i },
    { productCode: /ceramic.*white.*gold/i }
  ]
}).lean();

if (!product) {
  console.error(`❌ Product not found. Searching for any ceramic product...`);
  const ceramics = await Product.find({ itemName: /ceramic/i }).select('itemName productCode').limit(10).lean();
  console.log(`\nFound ${ceramics.length} ceramic products:`);
  ceramics.forEach(p => console.log(`  - ${p.itemName} (${p.productCode})`));
  process.exit(1);
}

console.log(`✓ Found product: ${product.itemName}`);
console.log(`  Product Code: ${product.productCode}`);
console.log(`  Status: ${product.status}\n`);

// 2. Show current pricing
console.log(`📊 Current pricing in database:`);
console.log(`  MRP: ₹${product.mrp || 'NOT SET'}`);
console.log(`  Dealer Rate: ₹${product.dealerRate || 'NOT SET'}`);
console.log(`  Distributor Rate: ₹${product.distributorRate || 'NOT SET'}`);
console.log(`  Wholesaler Rate: ₹${product.wholesaleRate || 'NOT SET'}`);
console.log(`  Retailer Rate: ₹${product.retailRate || 'NOT SET'}`);
console.log(`  Builder Rate: ₹${product.builderRate || 'NOT SET'}\n`);

// 3. Check the distributor
const distributor = await Dealer.findOne({ mobile: '9876543212' }).lean();
if (!distributor) {
  console.error(`❌ Distributor 9876543212 not found`);
  process.exit(1);
}

console.log(`👤 Distributor: ${distributor.name}`);
console.log(`  Pricing Tier: ${distributor.pricingTier || 'dealerRate (default)'}\n`);

// 4. Check if there's custom pricing for this dealer+product combo
const customPricing = await DealerPricing.findOne({
  dealer: distributor._id,
  product: product._id,
  isActive: true
}).lean();

if (customPricing) {
  console.log(`⚠️  Custom pricing exists:`);
  console.log(`  Custom Rate: ₹${customPricing.customRate}`);
  console.log(`  Discount: ${customPricing.discountPercent}%`);
  console.log(`  Created: ${customPricing.createdAt}`);
  console.log(`\n  This overrides the product's default pricing!\n`);
}

// 5. Calculate what the app SHOULD show
const pricingTier = distributor.pricingTier || 'dealerRate';
const effectiveRate = customPricing?.customRate 
  || product[pricingTier] 
  || product.dealerRate;

console.log(`📱 What the app is receiving:`);
console.log(`  Effective Rate: ₹${effectiveRate || 'NULL (ERROR!)'}`);
console.log(`  MRP: ₹${product.mrp || 'NULL'}`);

if (!effectiveRate) {
  console.log(`\n❌ PROBLEM: No rate available for distributor!`);
  console.log(`   The ${pricingTier} field is empty/null\n`);
} else if (!product.mrp) {
  console.log(`\n❌ PROBLEM: Product has no MRP!`);
  console.log(`   Without MRP, no discount can be shown\n`);
} else if (effectiveRate >= product.mrp) {
  console.log(`\n⚠️  PROBLEM: Rate (₹${effectiveRate}) >= MRP (₹${product.mrp})`);
  console.log(`   No discount will show (or negative discount)\n`);
} else {
  const discount = Math.round(((product.mrp - effectiveRate) / product.mrp) * 100);
  const saving = product.mrp - effectiveRate;
  console.log(`\n✅ Display shows:`);
  console.log(`   ₹${effectiveRate} (large, bold)`);
  console.log(`   ₹${product.mrp} (strikethrough) ${discount}% off\n`);
}

// 6. Offer to fix
console.log(`\n🔧 To fix, you need to:`);
if (!product.mrp) {
  console.log(`   1. Set the MRP in Product Master`);
}
if (!effectiveRate) {
  console.log(`   2. Set the ${pricingTier} in Product Master`);
  console.log(`      OR set customPricing for this dealer`);
}
if (effectiveRate && product.mrp && effectiveRate >= product.mrp) {
  console.log(`   3. Make sure ${pricingTier} (₹${effectiveRate}) < MRP (₹${product.mrp})`);
}

console.log(`\n💡 Suggested fix:`);
console.log(`   MRP should be: ???  (you decide)`);
console.log(`   ${pricingTier} should be: ???  (less than MRP)\n`);

await mongoose.disconnect();
