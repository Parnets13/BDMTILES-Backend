/**
 * GSTIN helpers.
 *
 * A GSTIN is not an opaque string: its first two digits are the state code and
 * characters 3-12 are the holder's PAN. Deriving them once here means the Company
 * master never stores a PAN that disagrees with the GST number it came from.
 *
 * Format: 2 digits state | 5 letters PAN | 4 digits | 1 letter | 1 alphanumeric | 'Z' | 1 alphanumeric
 */

export const GST_STATES = [
  { code: '01', name: 'Jammu & Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman & Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
  { code: '99', name: 'Centre Jurisdiction' },
];

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const GSTIN_HINT = '15 characters, e.g. 29ABCDE1234F1Z5';

/** Uppercase and strip the spaces/dashes people paste in from letterheads. */
export const normalizeGstin = (value) => String(value || '').toUpperCase().replace(/[\s-]/g, '');

export const gstStateName = (stateCode) => GST_STATES.find((state) => state.code === stateCode)?.name || '';

/** Structural check plus a real state code — '00' is well-formed but not a GST state. */
export const isValidGstin = (value) => {
  const gstin = normalizeGstin(value);
  if (!GSTIN_PATTERN.test(gstin)) return false;
  return GST_STATES.some((state) => state.code === gstin.slice(0, 2));
};

/** PAN is embedded at characters 3-12 of the GSTIN. */
export const derivePan = (value) => {
  const gstin = normalizeGstin(value);
  return gstin.length === 15 ? gstin.slice(2, 12) : '';
};

export const deriveStateCode = (value) => {
  const gstin = normalizeGstin(value);
  return gstin.length >= 2 ? gstin.slice(0, 2) : '';
};
