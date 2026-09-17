import Product from '../models/Product.js';

const ALIASES = new Map([
  ['box', 'Box'], ['boxes', 'Box'], ['bx', 'Box'],
  ['piece', 'Piece'], ['pieces', 'Piece'], ['pc', 'Piece'], ['pcs', 'Piece'],
  ['sqft', 'SqFt'], ['sq ft', 'SqFt'], ['square feet', 'SqFt'], ['square foot', 'SqFt'],
  ['kg', 'Kg'], ['kilogram', 'Kg'], ['kilograms', 'Kg'],
  ['meter', 'Meter'], ['metre', 'Meter'], ['meters', 'Meter'], ['metres', 'Meter'],
  ['litre', 'Litre'], ['liter', 'Litre'], ['litres', 'Litre'], ['liters', 'Litre'],
  ['set', 'Set'], ['sets', 'Set'], ['nos', 'Nos'], ['no', 'Nos'], ['unit', 'Unit'], ['units', 'Unit'],
]);

const fail = (status, message) => Object.assign(new Error(message), { status });
const round = (value, precision = 6) => {
  const scale = 10 ** Math.min(6, Math.max(0, Number(precision) || 0));
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
};

export function normalizeUom(value, fallback = 'Unit') {
  const raw = String(value || fallback).trim().replace(/\s+/g, ' ');
  if (!raw) return normalizeUom(fallback, 'Unit');
  return ALIASES.get(raw.toLowerCase()) || raw;
}

export function normalizeProductUomConfig(input = {}, fallbackUnit = 'Unit') {
  const inventoryBaseUom = normalizeUom(input.inventoryBaseUom || input.unit || fallbackUnit);
  const inventoryUomVersion = Number(input.inventoryUomVersion || 1);
  if (!Number.isInteger(inventoryUomVersion) || inventoryUomVersion < 1) {
    throw fail(422, 'inventoryUomVersion must be a positive integer.');
  }
  const supplied = Array.isArray(input.uomConversions) ? input.uomConversions : [];
  const rows = supplied.length ? supplied : [{ uom: inventoryBaseUom, toBaseFactor: 1 }];
  const seen = new Set();
  const uomConversions = rows.map((row, index) => {
    const uom = normalizeUom(row?.uom);
    const toBaseFactor = Number(row?.toBaseFactor);
    const precision = Number(row?.precision ?? 6);
    const version = Number(row?.version || inventoryUomVersion);
    const effectiveFrom = row?.effectiveFrom ? new Date(row.effectiveFrom) : new Date(0);
    if (!uom || seen.has(uom.toLowerCase())) throw fail(422, `uomConversions[${index}] has a duplicate or empty UOM.`);
    if (!Number.isFinite(toBaseFactor) || toBaseFactor <= 0) throw fail(422, `uomConversions[${index}].toBaseFactor must be greater than zero.`);
    if (!Number.isInteger(precision) || precision < 0 || precision > 6) throw fail(422, `uomConversions[${index}].precision must be an integer from 0 to 6.`);
    if (!Number.isInteger(version) || version < 1) throw fail(422, `uomConversions[${index}].version must be a positive integer.`);
    if (Number.isNaN(effectiveFrom.getTime())) throw fail(422, `uomConversions[${index}].effectiveFrom must be a valid date.`);
    seen.add(uom.toLowerCase());
    return { uom, toBaseFactor, precision, allowFraction: row?.allowFraction !== false, version, effectiveFrom };
  });
  const base = uomConversions.find(row => row.uom.toLowerCase() === inventoryBaseUom.toLowerCase());
  if (!base) uomConversions.unshift({ uom: inventoryBaseUom, toBaseFactor: 1, precision: 6, allowFraction: true, version: inventoryUomVersion, effectiveFrom: new Date(0) });
  else if (Math.abs(base.toBaseFactor - 1) > 1e-9) throw fail(422, 'The inventory base UOM conversion factor must be exactly 1.');
  return { inventoryBaseUom, inventoryUomVersion, uomConversions };
}

export function stableUomSnapshot(line = {}, product = null) {
  const enteredUnit = normalizeUom(line.enteredUnit || line.unit || product?.unit || 'Unit');
  const baseUnit = normalizeUom(line.baseUnit || line.inventoryBaseUom || product?.inventoryBaseUom || enteredUnit);
  const conversionFactor = Number(line.conversionFactor ?? line.toBaseFactor ?? 1);
  const uomVersion = Number(line.uomVersion || line.inventoryUomVersion || 1);
  if (!Number.isFinite(conversionFactor) || conversionFactor <= 0 || !Number.isInteger(uomVersion) || uomVersion < 1) {
    throw fail(422, 'A valid factor and UOM version are required.');
  }
  return { enteredUnit, baseUnit, conversionFactor, uomVersion };
}

export async function resolveStockUom({ product, enteredQuantity, enteredUnit, at = new Date(), session = null }) {
  let source = product;
  if (!source || !source.uomConversions) {
    let query = Product.findById(product);
    if (session) query = query.session(session);
    source = await query.lean();
  }
  if (!source) throw fail(404, 'Product was not found for UOM conversion.');
  const quantity = Number(enteredQuantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw fail(422, 'Entered quantity must be finite and nonnegative.');
  const config = normalizeProductUomConfig(source, source.unit || 'Unit');
  const normalizedEnteredUnit = normalizeUom(enteredUnit || source.unit || config.inventoryBaseUom);
  const effectiveAt = new Date(at);
  const candidates = config.uomConversions
    .filter(row => row.uom.toLowerCase() === normalizedEnteredUnit.toLowerCase() && row.effectiveFrom <= effectiveAt)
    .sort((a, b) => b.version - a.version || b.effectiveFrom - a.effectiveFrom);
  const conversion = candidates[0];
  if (!conversion) throw fail(422, `${normalizedEnteredUnit} is not configured for ${source.itemName || source.productCode || 'this product'}.`);
  if (!conversion.allowFraction && Math.abs(quantity - Math.round(quantity)) > 1e-9) {
    throw fail(422, `${normalizedEnteredUnit} does not allow fractional quantities.`);
  }
  return {
    enteredQuantity: round(quantity, conversion.precision),
    enteredUnit: conversion.uom,
    baseQuantity: round(quantity * conversion.toBaseFactor, 6),
    baseUnit: config.inventoryBaseUom,
    conversionFactor: conversion.toBaseFactor,
    uomVersion: conversion.version,
    precision: conversion.precision,
    allowFraction: conversion.allowFraction,
  };
}

export const stockUomError = fail;
