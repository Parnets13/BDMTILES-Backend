import Branch from '../models/Branch.js';
import DeliveryPincode from '../models/webContent/DeliveryPincode.js';

/**
 * Delivery serviceability.
 *
 * The storefront used to answer "do you deliver to me?" from a flat whitelist of
 * pincodes, so a customer one street outside a listed pincode was refused while a
 * customer forty kilometres away inside a listed one was accepted. A branch now
 * carries coordinates and a delivery radius, and the check measures the real
 * distance when the customer shares a location.
 *
 * The pincode whitelist is not replaced — it is the fallback. Most visitors type a
 * pincode and never grant location access, and a pincode list is the only thing
 * that can answer them without coordinates. Whichever rule decided the answer is
 * returned as `method`, so the storefront never claims a distance it did not
 * measure.
 */

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * A coordinate is only usable when it is actually present.
 *
 * `Number(null)` is 0 and `Number('')` is 0, both of which pass `isFinite`. Left
 * unchecked, a branch saved without coordinates would be treated as sitting at
 * 0,0 in the Gulf of Guinea, and every distance from it would be nonsense. Absent
 * has to stay absent.
 */
const isCoordinate = (value) =>
  value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value));

const isPoint = (point) =>
  Boolean(point) && isCoordinate(point.latitude) && isCoordinate(point.longitude);

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than a flat-earth approximation: at the scale of a delivery
 * radius the difference is small, but it costs nothing to be right, and the same
 * function is correct for a branch in another state.
 */
export const distanceKm = (from, to) => {
  if (!isPoint(from) || !isPoint(to)) return null;
  const { latitude: lat1, longitude: lon1 } = from;
  const { latitude: lat2, longitude: lon2 } = to;
  const dLat = toRadians(Number(lat2) - Number(lat1));
  const dLon = toRadians(Number(lon2) - Number(lon1));
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(Number(lat1))) * Math.cos(toRadians(Number(lat2))) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_KM * c * 10) / 10;
};

/** A branch can only decide on distance if it has both coordinates and a radius. */
const hasCoverage = (branch) =>
  isPoint(branch?.location) && Number(branch?.deliveryRadiusKm) > 0;

/**
 * Nearest branch that covers a point, or null.
 *
 * Branches whose radius does not reach the point are skipped rather than returned
 * with a distance, so the caller can tell "we do not deliver there" from "we do,
 * and it is 6.2 km".
 */
export const nearestCoveringBranch = (branches, point) => {
  let best = null;
  branches.forEach((branch) => {
    if (!hasCoverage(branch)) return;
    const km = distanceKm(branch.location, point);
    if (km == null) return;
    if (km > Number(branch.deliveryRadiusKm)) return;
    if (!best || km < best.distanceKm) {
      best = {
        branchId: String(branch._id),
        branchCode: branch.branchCode,
        branchName: branch.name,
        city: branch.city || '',
        distanceKm: km,
        deliveryRadiusKm: Number(branch.deliveryRadiusKm),
      };
    }
  });
  return best;
};

/** Closest branch overall, ignoring its radius — used to explain a refusal. */
const closestBranch = (branches, point) => {
  let best = null;
  branches.forEach((branch) => {
    if (!hasCoverage(branch)) return;
    const km = distanceKm(branch.location, point);
    if (km == null) return;
    if (!best || km < best.distanceKm) {
      best = {
        branchCode: branch.branchCode,
        branchName: branch.name,
        distanceKm: km,
        deliveryRadiusKm: Number(branch.deliveryRadiusKm),
      };
    }
  });
  return best;
};

const activeBranches = () =>
  Branch.find({ status: 'active' })
    .select('branchCode name city location deliveryRadiusKm')
    .lean();

/**
 * Resolve serviceability for a pincode and/or a coordinate pair.
 *
 * Order of precedence:
 *   1. coordinates + a branch that covers them  → serviceable, with a distance
 *   2. coordinates but no branch reaches them   → not serviceable by distance
 *   3. no coordinates                           → the pincode whitelist decides
 *
 * A coordinate check that fails does not silently fall back to the whitelist: if
 * we know the customer is 40 km out, saying yes because their pincode is listed
 * would be a promise the branch cannot keep.
 */
export const resolveServiceability = async ({ pincode, latitude, longitude } = {}) => {
  const cleanPincode = String(pincode || '').trim();
  const point = (isCoordinate(latitude) && isCoordinate(longitude))
    ? { latitude: Number(latitude), longitude: Number(longitude) }
    : null;

  const whitelistEntry = cleanPincode
    ? await DeliveryPincode.findOne({ pincode: cleanPincode, status: 'active' }).lean()
    : null;

  if (point) {
    const branches = await activeBranches();
    const covered = nearestCoveringBranch(branches, point);
    if (covered) {
      return {
        serviceable: true,
        method: 'distance',
        pincode: cleanPincode || null,
        area: whitelistEntry?.area || '',
        city: whitelistEntry?.city || covered.city,
        deliveryDays: whitelistEntry?.deliveryDays ?? null,
        codAvailable: whitelistEntry ? whitelistEntry.codAvailable !== false : null,
        distanceKm: covered.distanceKm,
        deliveryRadiusKm: covered.deliveryRadiusKm,
        branch: { branchCode: covered.branchCode, branchName: covered.branchName },
      };
    }
    const closest = closestBranch(branches, point);
    return {
      serviceable: false,
      method: 'distance',
      pincode: cleanPincode || null,
      reason: closest
        ? `Nearest branch is ${closest.distanceKm} km away, outside its ${closest.deliveryRadiusKm} km delivery radius.`
        : 'No branch has a delivery area configured yet.',
      distanceKm: closest?.distanceKm ?? null,
      deliveryRadiusKm: closest?.deliveryRadiusKm ?? null,
      branch: closest ? { branchCode: closest.branchCode, branchName: closest.branchName } : null,
    };
  }

  if (!whitelistEntry) {
    return {
      serviceable: false,
      method: 'pincode',
      pincode: cleanPincode || null,
      reason: cleanPincode ? 'This pincode is not in our delivery list yet.' : 'Enter a pincode or share your location.',
    };
  }

  return {
    serviceable: true,
    method: 'pincode',
    pincode: whitelistEntry.pincode,
    area: whitelistEntry.area || '',
    city: whitelistEntry.city || '',
    deliveryDays: whitelistEntry.deliveryDays ?? null,
    codAvailable: whitelistEntry.codAvailable !== false,
  };
};
