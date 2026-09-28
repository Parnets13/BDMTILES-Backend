import Dealer, { normalizeDealerMobile } from '../models/Dealer.js';
import DealerEmployee from '../models/DealerEmployee.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';

/**
 * Mobile-number identity guard.
 *
 * A mobile number is the login key for the Dealer App, and staff sign in with
 * one too. Until now each collection enforced uniqueness only against itself:
 *
 *   Dealer.mobileNormalized   unique (dealer app login)
 *   User.phoneNormalized      unique (staff login)
 *   Employee.mobile           NOT unique, and not normalized at all
 *
 * So a dealer employee's number could silently collide with an existing dealer,
 * a BDMTILES staff user, or an HRMS employee. The Dealer App login screen takes a
 * bare mobile number and must resolve it to exactly one principal, so any such
 * collision is unrecoverable at sign-in: two accounts would fight over one
 * number and the wrong party could end up authenticated.
 *
 * This module is the single guard for that. Every place a mobile number is
 * created or changed must call `assertMobileAvailable`:
 *
 *   - Dealer create / update            (routes/masterRoutes.js)
 *   - DealerEmployee create / update    (routes/dealerEmployeeRoutes.js)
 *
 * It is intentionally advisory-safe for legacy data: an existing duplicate in the
 * database does not break reads, it only blocks new writes that would add one.
 */

/** Where a mobile number is already in use. */
export const MOBILE_OWNER_TYPE = {
  DEALER: 'dealer',
  DEALER_EMPLOYEE: 'dealer_employee',
  STAFF_USER: 'staff_user',
  HRMS_EMPLOYEE: 'hrms_employee',
};

/**
 * The one message a user ever sees when a mobile number is taken.
 *
 * It deliberately says nothing about WHO holds the number.
 *
 * Naming the owner would turn the add-employee form into an enumeration tool: a
 * dealer could type numbers until one came back as "used by <name>, an employee
 * on the dealer account <business>", and walk away with a competitor's staff
 * list. Worse, a number held by a BDMTILES user would expose that the number is
 * internal. That is not a validation error, it is a data leak delivered one
 * request at a time — and the person filling in the form has no legitimate need
 * to know who else holds the number.
 *
 * Kept short on purpose: it is a one-line form error, and the long version was
 * more explanation than the person reading it needs.
 *
 * The detail is not lost. `findMobileOwner` still returns it and every caller
 * logs it server-side, so support can answer "why was this rejected?" without the
 * answer being readable from the app.
 */
export const MOBILE_IN_USE_MESSAGE = 'This mobile number is already registered.';

/**
 * The canonical identity key for a mobile number.
 *
 * Delegates to the dealer normalizer so the key used for the uniqueness check is
 * byte-for-byte the key the Dealer App login queries with. If these two ever
 * diverged, the guard would pass a number that login could not resolve.
 *
 * Indian mobiles are 10 digits and the rest of the system already assumes that
 * (both the dealer validator and `canonicalPhone` reduce to 10 digits for any
 * +91 / 0-prefixed input), so last-10 is the right reduction here.
 */
export const identityKey = (value) => normalizeDealerMobile(value);

/**
 * Match a mobile number stored in a raw, un-normalized column.
 *
 * `Employee.mobile` predates normalization and is stored as typed, so it may be
 * "98765 43210" or "+91 98765 43210". This builds a regex that tolerates any
 * non-digit separators between the digits, then the caller re-checks the exact
 * identity key so a coincidental substring match cannot produce a false clash.
 */
const digitsTolerantRegex = (key) => new RegExp(key.split('').join('[^0-9]*'));

const clashError = (status, code, message) =>
  Object.assign(new Error(message), { status, code });

const isSameRecord = (exclude, type, id) =>
  Boolean(exclude && exclude.type === type && exclude.id && String(exclude.id) === String(id));

/**
 * Find who already owns a mobile number, or null when it is free.
 *
 * @param {string} rawMobile            The number as typed by the user.
 * @param {object} [options]
 * @param {{type: string, id: string}} [options.exclude]  Record being updated.
 * @returns {Promise<null | {type: string, id: any, label: string, detail: string}>}
 *   `detail` is a human-readable phrase naming the holder. It exists for SERVER
 *   LOGS ONLY — never put it in a response. See MOBILE_IN_USE_MESSAGE.
 */
export const findMobileOwner = async (rawMobile, { exclude = null } = {}) => {
  const key = identityKey(rawMobile);
  if (!key || key.length < 10) return null;

  const [dealer, dealerEmployee, staffUser] = await Promise.all([
    Dealer.findOne({ mobileNormalized: key })
      .select('_id businessName')
      .lean(),
    DealerEmployee.findOne({ mobileNormalized: key })
      .select('_id name dealer')
      .populate('dealer', 'businessName')
      .lean(),
    User.findOne({ phoneNormalized: key })
      .select('_id name role')
      .lean(),
  ]);

  if (dealer && !isSameRecord(exclude, MOBILE_OWNER_TYPE.DEALER, dealer._id)) {
    return {
      type: MOBILE_OWNER_TYPE.DEALER,
      id: dealer._id,
      label: dealer.businessName || 'a dealer',
      detail: `dealer "${dealer.businessName}"`,
    };
  }

  if (dealerEmployee && !isSameRecord(exclude, MOBILE_OWNER_TYPE.DEALER_EMPLOYEE, dealerEmployee._id)) {
    const business = dealerEmployee.dealer?.businessName;
    return {
      type: MOBILE_OWNER_TYPE.DEALER_EMPLOYEE,
      id: dealerEmployee._id,
      label: dealerEmployee.name || 'a dealer employee',
      detail: business
        ? `"${dealerEmployee.name}", an employee on the dealer account "${business}"`
        : `dealer employee "${dealerEmployee.name}"`,
    };
  }

  if (staffUser && !isSameRecord(exclude, MOBILE_OWNER_TYPE.STAFF_USER, staffUser._id)) {
    return {
      type: MOBILE_OWNER_TYPE.STAFF_USER,
      id: staffUser._id,
      label: staffUser.name || 'a BDMTILES user',
      detail: `BDMTILES staff user "${staffUser.name}"`,
    };
  }

  // HRMS Employee has no normalized column, so narrow by a tolerant regex first
  // and then confirm the exact identity key.
  const candidates = await Employee.find({ mobile: { $regex: digitsTolerantRegex(key) } })
    .select('_id name empId mobile')
    .limit(25)
    .lean();

  const hrmsMatch = candidates.find((candidate) => identityKey(candidate.mobile) === key);
  if (hrmsMatch && !isSameRecord(exclude, MOBILE_OWNER_TYPE.HRMS_EMPLOYEE, hrmsMatch._id)) {
    return {
      type: MOBILE_OWNER_TYPE.HRMS_EMPLOYEE,
      id: hrmsMatch._id,
      label: hrmsMatch.name || 'a BDMTILES employee',
      detail: `BDMTILES employee "${hrmsMatch.name}" (${hrmsMatch.empId || 'no code'})`,
    };
  }

  return null;
};

/**
 * Throw a 409 unless the mobile number is free.
 *
 * The response never names the current holder — see MOBILE_IN_USE_MESSAGE. The
 * detail is written to the server log instead, where support can reach it.
 *
 * @param {string} rawMobile
 * @param {object} [options]
 * @param {{type: string, id: string}} [options.exclude]
 * @param {string} [options.field]  Field label used in the message, e.g. 'mobile'.
 * @param {number} [options.status] Defaults to 409.
 */
export const assertMobileAvailable = async (rawMobile, { exclude = null, field = 'mobile', status = 409 } = {}) => {
  const key = identityKey(rawMobile);
  if (!key || key.length < 10) {
    throw clashError(422, 'INVALID_MOBILE', `Enter a valid 10-digit ${field} number.`);
  }

  const owner = await findMobileOwner(rawMobile, { exclude });
  if (!owner) return key;

  // Server-side only. This is the line that tells support who actually holds it.
  console.warn(
    `[mobile-identity] rejected ${key}: already held by ${owner.type} ${owner.id} (${owner.detail})`,
  );

  throw clashError(status, 'MOBILE_ALREADY_IN_USE', MOBILE_IN_USE_MESSAGE);
};

/**
 * Availability probe for the UI, so a form can warn before the user submits
 * rather than only failing at save time.
 *
 * Returns the same generic message as a save would, for the same reason: a probe
 * that named the holder would be an even easier enumeration route than the form.
 */
export const checkMobileAvailability = async (rawMobile, { exclude = null } = {}) => {
  const key = identityKey(rawMobile);
  if (!key || key.length < 10) {
    return { available: false, reason: 'INVALID', message: 'Enter a valid 10-digit mobile number.' };
  }
  const owner = await findMobileOwner(rawMobile, { exclude });
  if (!owner) return { available: true, reason: null, message: 'This number is available.' };

  console.warn(
    `[mobile-identity] availability probe ${key}: already held by ${owner.type} ${owner.id} (${owner.detail})`,
  );
  return { available: false, reason: 'IN_USE', message: MOBILE_IN_USE_MESSAGE };
};

export default {
  identityKey,
  findMobileOwner,
  assertMobileAvailable,
  checkMobileAvailability,
  MOBILE_OWNER_TYPE,
  MOBILE_IN_USE_MESSAGE,
};
