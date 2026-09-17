const SUPPORTED_PHONE_CHARACTERS = /^[\d\s()+.-]+$/;

/**
 * Convert a supported phone number into its canonical identity key.
 * Indian country/trunk prefixes are removed so local, +91, 0091, and
 * leading-zero forms of the same mobile number compare equally.
 */
export const canonicalPhone = (value) => {
  const input = String(value || '').trim();
  if (!input || !SUPPORTED_PHONE_CHARACTERS.test(input)) return '';

  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('0091') && (digits.length === 14 || digits.length === 15)) {
    digits = digits.slice(4);
  } else if (digits.startsWith('91') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  return /^\d{10,15}$/.test(digits) ? digits : '';
};

export const isSupportedPhoneInput = (value) => canonicalPhone(value) !== '';
