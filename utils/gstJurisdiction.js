const GST_JURISDICTIONS = new Map([
  ['01', ['Jammu and Kashmir']],
  ['02', ['Himachal Pradesh']],
  ['03', ['Punjab']],
  ['04', ['Chandigarh']],
  ['05', ['Uttarakhand', 'Uttaranchal']],
  ['06', ['Haryana']],
  ['07', ['Delhi', 'National Capital Territory of Delhi', 'NCT of Delhi']],
  ['08', ['Rajasthan']],
  ['09', ['Uttar Pradesh']],
  ['10', ['Bihar']],
  ['11', ['Sikkim']],
  ['12', ['Arunachal Pradesh']],
  ['13', ['Nagaland']],
  ['14', ['Manipur']],
  ['15', ['Mizoram']],
  ['16', ['Tripura']],
  ['17', ['Meghalaya']],
  ['18', ['Assam']],
  ['19', ['West Bengal']],
  ['20', ['Jharkhand']],
  ['21', ['Odisha', 'Orissa']],
  ['22', ['Chhattisgarh']],
  ['23', ['Madhya Pradesh']],
  ['24', ['Gujarat']],
  ['26', ['Dadra and Nagar Haveli and Daman and Diu', 'Dadra & Nagar Haveli and Daman & Diu']],
  ['27', ['Maharashtra']],
  ['29', ['Karnataka']],
  ['30', ['Goa']],
  ['31', ['Lakshadweep']],
  ['32', ['Kerala']],
  ['33', ['Tamil Nadu']],
  ['34', ['Puducherry', 'Pondicherry']],
  ['35', ['Andaman and Nicobar Islands', 'Andaman & Nicobar Islands']],
  ['36', ['Telangana']],
  ['37', ['Andhra Pradesh']],
  ['38', ['Ladakh']],
  ['97', ['Other Territory']],
  ['99', ['Centre Jurisdiction']],
]);

const normalize = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]/g, '');

export const isKnownGstStateCode = (stateCode) => GST_JURISDICTIONS.has(String(stateCode || '').trim());

export const gstStateMatchesCode = (stateCode, stateName) => {
  const aliases = GST_JURISDICTIONS.get(String(stateCode || '').trim());
  if (!aliases || !String(stateName || '').trim()) return false;
  const normalizedState = normalize(stateName);
  return aliases.some((alias) => normalize(alias) === normalizedState);
};

export const canonicalGstStateName = (stateCode) =>
  GST_JURISDICTIONS.get(String(stateCode || '').trim())?.[0] || '';
