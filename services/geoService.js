/**
 * Reverse geocoding — the one place a coordinate becomes a street address.
 *
 * Kept behind a single function so the provider can be swapped without touching
 * attendance, visits or collections. The map is only ever the renderer; this is a
 * nicety layered on top of a coordinate that is already captured and stored.
 *
 * With `MAP_PROVIDER=none` (the default) every lookup resolves to `''` and callers
 * store bare coordinates. That is a supported configuration, not a broken one.
 *
 * Two rules this file exists to enforce:
 *   1. It never throws. A geocoder outage must not fail a punch-in — the coordinates
 *      are the part that matters for verification.
 *   2. It never exposes the key. Only the backend calls this, so MAP_SERVER_KEY stays
 *      server-side; the browser gets MAP_BROWSER_KEY, which is restricted by Referer.
 */

const PROVIDER = String(process.env.MAP_PROVIDER || 'none').trim().toLowerCase();
const SERVER_KEY = String(process.env.MAP_SERVER_KEY || '').trim();

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const CACHE_SECONDS = positiveInt(process.env.GEOCODE_CACHE_SECONDS, 3600);
const REQUEST_TIMEOUT_MS = 6000;

/**
 * One entry per supported provider.
 *
 * `build` returns the request URL, `read` pulls the address out of the response.
 * Every `read` is deliberately defensive about the envelope: these APIs have moved
 * fields between versions, and a wrong guess must degrade to "coordinates only"
 * rather than to a broken punch-in.
 *
 * NOTE: the request shapes below follow each provider's published web-service API,
 * but they have not been exercised against a live key from this environment. The
 * first thing to do after setting a key is confirm the response mapping.
 */
const PROVIDERS = {
  tencent: {
    build: ({ lat, lng }, key) =>
      `https://apis.map.qq.com/ws/geocoder/v1/?location=${lat},${lng}&key=${key}&get_poi=0`,
    read: (body) =>
      body?.result?.address
      || body?.result?.formatted_addresses?.recommend
      || '',
  },
  amap: {
    build: ({ lat, lng }, key) =>
      `https://restapi.amap.com/v3/geocode/regeo?location=${lng},${lat}&key=${key}`,
    read: (body) => body?.regeocode?.formatted_address || '',
  },
  baidu: {
    build: ({ lat, lng }, key) =>
      `https://api.map.baidu.com/reverse_geocoding/v3/?ak=${key}&output=json&coordtype=wgs84ll&location=${lat},${lng}`,
    read: (body) => body?.result?.formatted_address || '',
  },
  tianditu: {
    build: ({ lat, lng }, key) =>
      `https://api.tianditu.gov.cn/geocoder?postStr=${encodeURIComponent(
        JSON.stringify({ lon: lng, lat, ver: 1 }),
      )}&type=geocode&tk=${key}`,
    read: (body) => body?.result?.formatted_address || '',
  },
};

const provider = PROVIDERS[PROVIDER] || null;
export const geocodingEnabled = () => Boolean(provider && SERVER_KEY);

/** Rounded to ~11m, so a stationary phone does not burn quota on GPS jitter. */
const cacheKey = ({ lat, lng }) => `${lat.toFixed(4)},${lng.toFixed(4)}`;
const cache = new Map();

const fromCache = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
};

const toCache = (key, value) => {
  if (CACHE_SECONDS <= 0) return;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_SECONDS * 1000 });
  // A long-running process must not grow this without bound. Map preserves insertion
  // order, so the oldest entries are the first to go.
  if (cache.size > 5000) {
    for (const oldest of cache.keys()) {
      cache.delete(oldest);
      if (cache.size <= 4000) break;
    }
  }
};

/**
 * Resolve a coordinate to an address.
 *
 * Always resolves. Returns `''` when geocoding is off, the provider errors, times
 * out, or returns nothing usable — callers store coordinates either way.
 */
export const reverseGeocode = async ({ lat, lng } = {}) => {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  if (!geocodingEnabled()) return '';

  const key = cacheKey({ lat: latitude, lng: longitude });
  const cached = fromCache(key);
  if (cached !== null) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(provider.build({ lat: latitude, lng: longitude }, SERVER_KEY), {
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const body = await response.json();
    const address = String(provider.read(body) || '').trim();
    // Cache misses too — an ungeocodable point is just as expensive to retry.
    toCache(key, address);
    return address;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
};

/** What the monitoring page needs to know about the current configuration. */
export const geocodeStatus = () => ({
  provider: provider ? PROVIDER : 'none',
  enabled: geocodingEnabled(),
  // True when a browser key exists, which is what the map view needs to render.
  mapKeyConfigured: Boolean(String(process.env.MAP_BROWSER_KEY || '').trim()),
});

export default { reverseGeocode, geocodingEnabled, geocodeStatus };
