/**
 * Generate Image Embeddings for Products
 * 
 * This script processes all products with images and generates visual embeddings
 * for image-based product search.
 * 
 * Usage:
 *   node scripts/generateProductEmbeddings.js [options]
 * 
 * Options:
 *   --all          Process all products (default: only products without embeddings)
 *   --limit=N      Process only N products (for testing)
 *   --force        Regenerate embeddings even if they exist
 * 
 * Examples:
 *   node scripts/generateProductEmbeddings.js
 *   node scripts/generateProductEmbeddings.js --all
 *   node scripts/generateProductEmbeddings.js --limit=10
 */

import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Product from '../models/Product.js';
import { generateEmbedding } from '../services/imageEmbedding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  all: args.includes('--all'),
  force: args.includes('--force'),
  limit: args.find(arg => arg.startsWith('--limit='))?.split('=')[1] || null,
};

// Statistics
const stats = {
  total: 0,
  processed: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  errors: [],
};

/**
 * Connect to MongoDB
 */
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
}

/**
 * Resolve a product image path stored in the DB to an absolute filesystem path.
 *
 * DB stores paths in one of these formats:
 *   "uploads/products/filename.jpg"      ← most common
 *   "products/filename.jpg"
 *   "/uploads/products/filename.jpg"
 */
function getImagePath(imagePath) {
  if (!imagePath) return null;

  // Strip any leading slash
  let clean = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;

  // If path already starts with "uploads/", resolve directly from project root
  if (clean.startsWith('uploads/')) {
    return path.join(__dirname, '..', clean);
  }

  // Otherwise assume it's relative to the uploads directory
  return path.join(__dirname, '..', 'uploads', clean);
}

/**
 * Process a single product
 */
async function processProduct(product) {
  try {
    // Check if product has images
    if (!product.images || product.images.length === 0) {
      stats.skipped++;
      console.log(`⊘ ${product.itemName} - No images`);
      return;
    }

    // Skip if embedding exists and force is not set
    if (product.imageEmbedding && product.imageEmbedding.length > 0 && !options.force) {
      stats.skipped++;
      console.log(`⊘ ${product.itemName} - Already has embedding`);
      return;
    }

    // Get the first image path
    const firstImage = product.images[0];
    const imagePath = getImagePath(firstImage);

    if (!imagePath) {
      stats.skipped++;
      console.log(`⊘ ${product.itemName} - Invalid image path`);
      return;
    }

    // Generate embedding
    console.log(`⏳ Processing: ${product.itemName}...`);
    const embedding = await generateEmbedding(imagePath);

    // Update product with embedding
    await Product.updateOne(
      { _id: product._id },
      {
        $set: {
          imageEmbedding: embedding,
          imageEmbeddingVersion: 1,
          imageEmbeddingUpdatedAt: new Date(),
        },
      }
    );

    stats.success++;
    console.log(`✅ ${product.itemName} - Embedding generated (${embedding.length} dimensions)`);
  } catch (error) {
    stats.failed++;
    const errorMsg = `${product.itemName}: ${error.message}`;
    stats.errors.push(errorMsg);
    console.error(`❌ ${product.itemName} - Failed:`, error.message);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('\n🚀 Product Image Embedding Generator\n');
  console.log('Options:', options, '\n');

  // Connect to database
  await connectDB();

  try {
    // Build query filter
    const filter = { status: 'active', onlineVisible: true };
    
    if (!options.all && !options.force) {
      // Only process products without embeddings
      filter.$or = [
        { imageEmbedding: { $exists: false } },
        { imageEmbedding: null },
        { imageEmbedding: { $size: 0 } },
      ];
    }

    // Count total products
    stats.total = await Product.countDocuments(filter);
    console.log(`📊 Found ${stats.total} products to process\n`);

    if (stats.total === 0) {
      console.log('✅ No products need processing');
      await mongoose.connection.close();
      process.exit(0);
    }

    // Apply limit if specified
    const limit = options.limit ? parseInt(options.limit, 10) : null;
    if (limit) {
      console.log(`⚠️  Limiting to ${limit} products\n`);
    }

    // Fetch products
    const query = Product.find(filter)
      .select('_id itemName images imageEmbedding imageEmbeddingVersion')
      .lean();
    
    if (limit) {
      query.limit(limit);
    }

    const products = await query;

    // Process each product
    for (let i = 0; i < products.length; i++) {
      stats.processed++;
      const product = products[i];
      
      console.log(`\n[${stats.processed}/${products.length}]`);
      await processProduct(product);
      
      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Summary');
    console.log('='.repeat(60));
    console.log(`Total products:     ${stats.total}`);
    console.log(`Processed:          ${stats.processed}`);
    console.log(`✅ Success:         ${stats.success}`);
    console.log(`❌ Failed:          ${stats.failed}`);
    console.log(`⊘ Skipped:          ${stats.skipped}`);
    console.log('='.repeat(60));

    if (stats.errors.length > 0) {
      console.log('\n❌ Errors:');
      stats.errors.forEach(err => console.log(`  - ${err}`));
    }

    console.log('\n✅ Processing complete!\n');
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('👋 Database connection closed\n');
  }
}

// Run the script
main().catch(error => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});
