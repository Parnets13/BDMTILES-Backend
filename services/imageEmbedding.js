/**
 * Image Embedding Service — ONNX Runtime (local model, no internet required)
 *
 * Uses MobileNetV2-12 from the ONNX Model Zoo, bundled at:
 *   models/onnx/mobilenetv2-12.onnx
 *
 * PREPROCESSING (must match exactly between indexing and search):
 *   1. Resize to 224 × 224 (cover + center-crop via sharp)
 *   2. Convert to float32 RGB, values in [0, 1]
 *   3. Normalize: subtract ImageNet mean, divide by ImageNet std
 *      mean = [0.485, 0.456, 0.406]  (R, G, B)
 *      std  = [0.229, 0.224, 0.225]
 *   4. Arrange as NCHW tensor: [1, 3, 224, 224]
 *
 * OUTPUT:
 *   MobileNetV2-12 final output is [1, 1000] softmax logits.
 *   We take the raw pre-softmax activations from the penultimate layer
 *   (accessed via the "output" node) and L2-normalise them for cosine search.
 *
 * MODEL CONSISTENCY:
 *   The SAME model file, SAME preprocessing pipeline and SAME output layer
 *   are used for both product indexing (scripts/generateProductEmbeddings.js)
 *   and customer image search (POST /shop/products/search-by-image).
 */

import ort from 'onnxruntime-node';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Constants ────────────────────────────────────────────────────────────────
const MODEL_PATH  = path.join(__dirname, '..', 'models', 'onnx', 'mobilenetv2-12.onnx');
const INPUT_SIZE  = 224;       // MobileNetV2 expects 224×224
const EMBED_DIM   = 1000;      // MobileNetV2-12 output is 1000 logits

// ImageNet normalisation
const MEAN = [0.485, 0.456, 0.406];
const STD  = [0.229, 0.224, 0.225];

// ─── Module-level session cache ───────────────────────────────────────────────
let _session = null;

/**
 * Load (and cache) the ONNX inference session.
 * Called once on first use; subsequent calls return instantly.
 */
async function getSession() {
  if (_session) return _session;

  console.log('[ImageEmbedding] Loading ONNX model from:', MODEL_PATH);
  _session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ['cpu'],   // CPU-only; safe on any server
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
  });

  const inputs  = _session.inputNames;
  const outputs = _session.outputNames;
  console.log('[ImageEmbedding] Model loaded. inputs:', inputs, 'outputs:', outputs);
  return _session;
}

/**
 * Preprocess an image from disk (or buffer) into a Float32 NCHW tensor.
 *
 * @param {string|Buffer} source  Path to image file OR raw image Buffer
 * @returns {Promise<ort.Tensor>}
 */
async function preprocessImage(source) {
  // ── 1. Resize to 224×224 (cover crop, center-aligned) ──
  const { data: rawData, info } = await sharp(source)
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'cover', position: 'center' })
    .removeAlpha()            // ensure RGB, no alpha channel
    .raw()                    // get raw pixel bytes
    .toBuffer({ resolveWithObject: true });

  // rawData is a Uint8Array of [R, G, B, R, G, B, …] values 0–255
  const pixels = rawData.length / 3;  // should be 224*224 = 50176

  // ── 2. Build NCHW Float32 tensor [1, 3, 224, 224] ──
  //    Channels are stored plane-by-plane: all R, then all G, then all B
  const tensor = new Float32Array(1 * 3 * INPUT_SIZE * INPUT_SIZE);

  for (let i = 0; i < pixels; i++) {
    const r = rawData[i * 3 + 0] / 255;
    const g = rawData[i * 3 + 1] / 255;
    const b = rawData[i * 3 + 2] / 255;

    // ── 3. ImageNet normalisation ──
    tensor[0 * pixels + i] = (r - MEAN[0]) / STD[0];  // R plane
    tensor[1 * pixels + i] = (g - MEAN[1]) / STD[1];  // G plane
    tensor[2 * pixels + i] = (b - MEAN[2]) / STD[2];  // B plane
  }

  return new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

/**
 * L2-normalise a Float32Array in-place so cosine similarity == dot product.
 *
 * @param {Float32Array} vec
 * @returns {Float32Array}  (same array, modified in-place)
 */
function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-12) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Generate an image embedding vector from a file path or buffer.
 *
 * @param {string|Buffer} source  Path to image file OR raw image Buffer
 * @returns {Promise<number[]>}   1000-dimensional L2-normalised embedding
 */
async function generateEmbedding(source) {
  const session = await getSession();

  // Build input tensor
  const inputTensor = await preprocessImage(source);

  // Run inference
  // MobileNetV2-12 input node is "data" or "input"
  const inputName = session.inputNames[0];
  const feeds = { [inputName]: inputTensor };
  const results = await session.run(feeds);

  // Get output
  const outputName = session.outputNames[0];
  const outputData = results[outputName].data;  // Float32Array, length 1000

  // L2-normalise for cosine similarity
  const embedding = l2Normalize(new Float32Array(outputData));

  return Array.from(embedding);
}

/**
 * Cosine similarity between two embedding vectors.
 * Both vectors must be L2-normalised (as returned by generateEmbedding).
 * With L2-normalised vectors: cosine = dot product.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}  similarity in [-1, 1]; higher = more similar
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Find the top-K most visually similar products.
 *
 * @param {number[]} queryEmbedding
 * @param {Array<{id:string, embedding:number[]}>} candidates
 * @param {number} topK
 * @returns {Array<{id:string, similarity:number}>}
 */
function findSimilarProducts(queryEmbedding, candidates, topK = 20) {
  return candidates
    .filter(c => Array.isArray(c.embedding) && c.embedding.length === queryEmbedding.length)
    .map(c => ({ id: c.id, similarity: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

/**
 * Warm up the model during server startup to eliminate first-request latency.
 * Creates a 1×1 dummy image and runs a full inference pass.
 */
async function warmupModel() {
  try {
    console.log('[ImageEmbedding] Warming up ONNX model...');
    const dummyBuffer = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .png()
      .toBuffer();

    await generateEmbedding(dummyBuffer);
    console.log('[ImageEmbedding] Warmup complete — model ready');
  } catch (err) {
    // Non-fatal: server still starts, first request just takes a bit longer
    console.error('[ImageEmbedding] Warmup failed (non-fatal):', err.message);
  }
}

export {
  generateEmbedding,
  cosineSimilarity,
  findSimilarProducts,
  warmupModel,
};
