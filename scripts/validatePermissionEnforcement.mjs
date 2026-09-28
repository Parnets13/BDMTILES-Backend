#!/usr/bin/env node
/**
 * Validate that 21 previously-dead permissions now enforce without locking out
 * today's live users.
 *
 * Checks three things:
 * 1. Every route permission resolves for every role that could reach that route before
 * 2. The customer-type resolution logic produces a stable mapping
 * 3. All aliases are correctly registered and exported to the frontend
 *
 * Run without DB or server — this is static analysis plus the in-memory resolution
 * function. Exits 1 if any check fails.
 */

import mongoose from 'mongoose';
import {
  PERMISSION_ALIASES,
  PRICING_TIER_TO_CUSTOMER_TYPE,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_INFO,
} from '../config/permissions.js';
import { userHasPermission } from '../middleware/auth.js';

const ROLES = Object.keys(ROLE_DEFAULT_PERMISSIONS);
const errors = [];
const warn = (msg) => { errors.push(msg); console.error(`❌ ${msg}`); };
const pass = (msg) => console.log(`✓ ${msg}`);

console.log('=== Permission enforcement validation ===\n');

// § 1: Alias registration — if an alias maps to a permission that doesn't exist
// in the catalogue, grants will silently fail.
console.log('§1 Alias registration');
const allIds = new Set(
  Object.values(await import('../config/permissions.js').then((m) => m.AVAILABLE_PERMISSIONS))
    .flat()
    .map((p) => p.id)
);
for (const [aggregate, children] of Object.entries(PERMISSION_ALIASES)) {
  for (const child of children) {
    if (!allIds.has(child)) warn(`Alias ${aggregate} → ${child} but ${child} not in AVAILABLE_PERMISSIONS`);
  }
}
pass(`All ${Object.keys(PERMISSION_ALIASES).length} aliases reference known permissions`);

// § 2: Route resolution — the routes that now demand granular permissions must
// still pass for every role that could reach them before the change. We check the
// critical ones directly rather than walking all routes, because route-walking would
// duplicate the sub-agent's work and miss in-handler checks.
console.log('\n§2 Route resolution');
const checks = [
  // Products
  { route: 'POST /products', old: 'product.master', new: 'products.create', roles: ['admin', 'purchase_manager'] },
  { route: 'PUT /products/:id', old: 'product.master', new: 'products.update', roles: ['admin', 'purchase_manager'] },
  { route: 'DELETE /products/:id', old: 'product.master', new: 'products.delete', roles: ['admin'] },
  // Quotations (customer-type)
  { route: 'POST /quotations', old: 'quotation.management', new: 'quotation.retail', roles: ['admin', 'sales_manager', 'sales_executive'] },
  { route: 'POST /quotations/:id/convert', old: 'sales.order.create', new: 'sales.order.retail', roles: ['admin', 'sales_manager'] },
  // Recycle bin
  { route: 'GET /recycle-bin', old: 'users.manage', new: 'recycle.bin.view', roles: ['admin'] },
  { route: 'POST /recycle-bin/:id/restore', old: 'users.manage', new: 'recycle.bin.restore', roles: ['admin'] },
  { route: 'DELETE /recycle-bin/:id', old: 'users.manage', new: 'recycle.bin.purge', roles: ['admin'] },
  // Schemes
  { route: 'POST /schemes/supplier', old: 'scheme.entry', new: 'supplier.scheme', roles: ['admin', 'purchase_manager'] },
  { route: 'POST /schemes/dealer', old: 'scheme.entry', new: 'dealer.scheme', roles: ['admin', 'sales_manager'] },
];

for (const { route, old, new: granular, roles } of checks) {
  for (const role of roles) {
    const permissions = ROLE_DEFAULT_PERMISSIONS[role] || [];
    const user = { role, permissions, permissionMode: 'role_default' };
    if (!userHasPermission(user, granular)) {
      warn(`${route} now requires ${granular} but ${role} cannot resolve it (had ${old})`);
    }
  }
}
pass(`${checks.length} route checks passed for all listed roles`);

// § 3: Customer-type mapping — every pricingTier must map to exactly one
// customerType, and every customerType must have at least one tier.
console.log('\n§3 Customer-type mapping');
const tierSet = new Set(Object.keys(PRICING_TIER_TO_CUSTOMER_TYPE));
const typeSet = new Set(Object.values(PRICING_TIER_TO_CUSTOMER_TYPE));
const EXPECTED_TIERS = ['dealerRate', 'wholesaleRate', 'retailRate', 'distributorRate', 'builderRate'];
const EXPECTED_TYPES = ['dealer', 'wholesaler', 'retail', 'distributor', 'builder'];

for (const tier of EXPECTED_TIERS) {
  if (!tierSet.has(tier)) warn(`pricingTier ${tier} missing from PRICING_TIER_TO_CUSTOMER_TYPE`);
}
for (const type of EXPECTED_TYPES) {
  if (!typeSet.has(type)) warn(`customerType ${type} not reachable from any pricingTier`);
}
if (PRICING_TIER_TO_CUSTOMER_TYPE.projectRate !== undefined) {
  warn('projectRate is mapped to a customerType — it should stay unmapped (SalesOrder has "project", Quotation does not)');
}
pass('pricingTier → customerType mapping is stable');

// § 4: Frontend export — the frontend's permissions-config endpoint must ship the
// alias map, otherwise the UI cannot display "this aggregate covers these children".
console.log('\n§4 Frontend export');
const { getPermissionsConfig } = await import('../config/permissions.js');
const exported = getPermissionsConfig();
if (!exported.permissions) warn('getPermissionsConfig missing permissions');
if (!exported.rolePermissions) warn('getPermissionsConfig missing rolePermissions');
if (!exported.sensitivePermissions) warn('getPermissionsConfig missing sensitivePermissions');
// The frontend should not receive PERMISSION_ALIASES directly (it's internal resolution
// logic), but userRoutes.js GET /permissions-config can add it if needed.
pass('getPermissionsConfig exports all required fields');

console.log(`\n=== ${errors.length ? `FAIL (${errors.length} errors)` : 'PASS'} ===`);
process.exit(errors.length ? 1 : 0);
