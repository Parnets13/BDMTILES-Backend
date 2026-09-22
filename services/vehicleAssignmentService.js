import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import DispatchTrip from '../models/DispatchTrip.js';

/**
 * Resolving a vehicle for a dispatch assignment.
 *
 * Vehicle Master used to be decorative: dispatch stored a typed registration
 * number and never linked back, so a typo silently invented a vehicle and no
 * report could answer "which trips did this vehicle run". Every assignment now
 * goes through here, which returns the master record or explains why it cannot
 * be used, and callers copy their denormalised fields from that record instead
 * of from whatever the client sent.
 */

const conflict = (status, message, code) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// A trip still holding a vehicle. Once it is completed or cancelled the vehicle
// is free again.
export const OPEN_TRIP_STATUSES = ['planning', 'loading', 'loaded', 'dispatched', 'in_transit'];

const startOfToday = () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
};

const expiryProblems = (vehicle) => {
  const today = startOfToday();
  const problems = [];
  for (const [field, label] of [['fitnessExpiry', 'Fitness certificate'], ['insuranceExpiry', 'Insurance']]) {
    const when = vehicle[field] ? new Date(vehicle[field]) : null;
    if (when && !Number.isNaN(when.getTime()) && when < today) {
      problems.push(`${label} expired on ${when.toLocaleDateString('en-IN')}`);
    }
  }
  return problems;
};

/**
 * Capacity is advisory, not a block. It is stored as free text with a unit, so it
 * is only comparable when it parses as a number: boxes against the box count,
 * tons/kg against the trip weight. Anything unparseable is simply not checked
 * rather than guessed at.
 */
const capacityWarning = (vehicle, { totalBoxes = 0, totalWeight = 0 }) => {
  const capacity = Number.parseFloat(String(vehicle.capacity || '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(capacity) || capacity <= 0) return null;

  if (vehicle.capacityUnit === 'boxes' && totalBoxes > capacity) {
    return `${vehicle.vehicleNumber} is rated for ${capacity} boxes but this trip carries ${totalBoxes}.`;
  }
  if (['tons', 'kg'].includes(vehicle.capacityUnit) && totalWeight > 0) {
    const capacityKg = vehicle.capacityUnit === 'tons' ? capacity * 1000 : capacity;
    if (totalWeight > capacityKg) {
      return `${vehicle.vehicleNumber} is rated for ${vehicle.capacity} ${vehicle.capacityUnit} but this trip weighs about ${Math.round(totalWeight)} kg.`;
    }
  }
  return null;
};

/**
 * @param {object} input
 * @param {string} [input.vehicleId]      Vehicle Master id — the preferred way in.
 * @param {string} [input.vehicleNumber]  Registration, accepted so older clients
 *                                        and imports still resolve to the master.
 * @param {number} [input.totalBoxes]
 * @param {number} [input.totalWeight]
 * @param {string} [input.excludeTripId]  Ignore this trip when checking for a
 *                                        clash, so editing a trip does not
 *                                        collide with itself.
 * @param {boolean} [input.allowBusy]     Skip the double-booking check.
 * @param {string} [input.branchId]       Active branch; validates the optional
 *                                        linked Delivery Executive account.
 * @returns {Promise<{vehicle: object, warnings: string[]}>}
 */
export async function resolveVehicleForAssignment({
  vehicleId,
  vehicleNumber,
  totalBoxes = 0,
  totalWeight = 0,
  excludeTripId = null,
  allowBusy = false,
  branchId = null,
  session = null,
} = {}) {
  const trimmedNumber = String(vehicleNumber || '').trim().toUpperCase();
  if (!vehicleId && !trimmedNumber) {
    throw conflict(422, 'Select a vehicle from Vehicle Master.', 'VEHICLE_REQUIRED');
  }
  if (vehicleId && !mongoose.isValidObjectId(vehicleId)) {
    throw conflict(422, 'vehicle must be a valid Vehicle Master id.', 'VEHICLE_INVALID');
  }

  let query = Vehicle.findOne(vehicleId ? { _id: vehicleId } : { vehicleNumber: trimmedNumber })
    .populate('deliveryExecutive', 'name phone email role status assignedBranches defaultBranch');
  if (session) query = query.session(session);
  const vehicle = await query.lean();

  if (!vehicle) {
    throw conflict(
      404,
      vehicleId
        ? 'That vehicle is no longer in Vehicle Master.'
        : `"${trimmedNumber}" is not in Vehicle Master. Add it there first, then assign it.`,
      'VEHICLE_NOT_IN_MASTER',
    );
  }
  if (vehicle.isActive === false) {
    throw conflict(409, `${vehicle.vehicleNumber} is marked inactive in Vehicle Master.`, 'VEHICLE_INACTIVE');
  }

  if (vehicle.deliveryExecutive) {
    const executive = vehicle.deliveryExecutive;
    const belongsToBranch = !branchId || (executive.assignedBranches || []).some(id => String(id) === String(branchId));
    if (executive.role !== 'delivery_executive' || executive.status !== 'Active' || !belongsToBranch) {
      throw conflict(
        409,
        `${vehicle.vehicleNumber}'s linked Delivery Executive is inactive, has the wrong role, or is not assigned to the active branch. Update Vehicle Master before assigning it.`,
        'VEHICLE_EXECUTIVE_UNAVAILABLE',
      );
    }
  }

  const expired = expiryProblems(vehicle);
  if (expired.length) {
    throw conflict(409, `${vehicle.vehicleNumber} cannot be dispatched. ${expired.join('. ')}.`, 'VEHICLE_DOCUMENTS_EXPIRED');
  }

  if (!allowBusy) {
    const clashFilter = {
      vehicle: vehicle._id,
      status: { $in: OPEN_TRIP_STATUSES },
      ...(excludeTripId ? { _id: { $ne: excludeTripId } } : {}),
    };
    let clashQuery = DispatchTrip.findOne(clashFilter).select('tripNumber status');
    if (session) clashQuery = clashQuery.session(session);
    const clash = await clashQuery.lean();
    if (clash) {
      throw conflict(
        409,
        `${vehicle.vehicleNumber} is already on trip ${clash.tripNumber} (${String(clash.status).replace(/_/g, ' ')}). Complete or cancel that trip first.`,
        'VEHICLE_ALREADY_ON_TRIP',
      );
    }
  }

  const warnings = [capacityWarning(vehicle, { totalBoxes, totalWeight })].filter(Boolean);
  return { vehicle, warnings };
}

/** The fields a trip or delivery should carry, taken from the master, never the client. */
export const vehicleSnapshot = vehicle => ({
  vehicle: vehicle._id,
  vehicleNumber: vehicle.vehicleNumber,
  vehicleType: vehicle.vehicleType || '',
  vehicleCapacity: vehicle.capacity ? `${vehicle.capacity} ${vehicle.capacityUnit || ''}`.trim() : '',
  deliveryExecutive: vehicle.deliveryExecutive?._id || vehicle.deliveryExecutive || undefined,
  deliveryExecutiveName: vehicle.deliveryExecutive?.name || '',
});
