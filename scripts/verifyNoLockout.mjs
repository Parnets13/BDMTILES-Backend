#!/usr/bin/env node --use-system-ca
/**
 * Live lockout check: verifies that every user in the database can still resolve
 * the permissions enforced by the newly-gated routes.
 *
 * This is the real safety check — validatePermissionEnforcement.mjs proved the
 * aliases and defaults are correct in theory, but this confirms no actual account
 * gets a 403 they didn't have before.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import User from '../models/User.js';
import { userHasPermission } from '../middleware/auth.js';

await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

const users = await User.find({ status: 'Active' })
  .select('name role permissions permissionMode')
  .lean();

console.log(`\n=== Live lockout check (${users.length} active users) ===\n`);

// The routes that now demand granular permissions. For each, check whether the user
// could have reached it before (via the old aggregate) and can still reach it now
// (via the alias or an explicitly-granted granular id).
const checks = [
  { route: 'POST /products', old: 'product.master', new: 'products.create' },
  { route: 'PUT /products/:id', old: 'product.master', new: 'products.update' },
  { route: 'DELETE /products/:id', old: 'product.master', new: 'products.delete' },
  { route: 'POST /quotations (retail)', old: 'quotation.management', new: 'quotation.retail' },
  { route: 'POST /quotations (dealer)', old: 'quotation.management', new: 'quotation.dealer' },
  { route: 'POST /quotations/:id/convert (retail)', old: 'sales.order.create', new: 'sales.order.retail' },
  { route: 'GET /recycle-bin', old: 'users.manage', new: 'recycle.bin.view' },
  { route: 'POST /recycle-bin/:id/restore', old: 'users.manage', new: 'recycle.bin.restore' },
  { route: 'DELETE /recycle-bin/:id', old: 'users.manage', new: 'recycle.bin.purge' },
  { route: 'POST /schemes/supplier', old: 'scheme.entry', new: 'supplier.scheme' },
  { route: 'POST /schemes/dealer', old: 'scheme.entry', new: 'dealer.scheme' },
];

const lockouts = [];
for (const user of users) {
  for (const { route, old, new: granular } of checks) {
    const hadAccessBefore = userHasPermission(user, old);
    const hasAccessNow = userHasPermission(user, granular);
    if (hadAccessBefore && !hasAccessNow) {
      lockouts.push({ user: user.name, role: user.role, route, old, new: granular });
    }
  }
}

if (lockouts.length) {
  console.error('❌ LOCKOUTS DETECTED — these users lose access they had:\n');
  for (const { user, role, route, old, new: granular } of lockouts) {
    console.error(`  ${user} (${role}): ${route}`);
    console.error(`    had ${old}, needs ${granular}\n`);
  }
  console.error(`\n=== FAIL (${lockouts.length} lockouts across ${new Set(lockouts.map(l => l.user)).size} users) ===`);
  process.exit(1);
}

console.log('✓ No lockouts — every user who could reach a route before can still reach it now.\n');

// Additional safety: flag users holding permissions that don't exist in the catalogue.
// These are grants that will silently fail (the permission check will always deny).
const { AVAILABLE_PERMISSIONS } = await import('../config/permissions.js');
const catalogue = new Set(
  Object.values(AVAILABLE_PERMISSIONS).flat().map((p) => p.id)
);

const phantom = [];
for (const user of users) {
  for (const perm of user.permissions || []) {
    if (perm !== '*' && !catalogue.has(perm)) {
      phantom.push({ user: user.name, role: user.role, permission: perm });
    }
  }
}

if (phantom.length) {
  console.warn(`\n⚠ ${phantom.length} phantom permission(s) granted but not in catalogue:\n`);
  for (const { user, role, permission } of phantom.slice(0, 10)) {
    console.warn(`  ${user} (${role}): ${permission}`);
  }
  if (phantom.length > 10) console.warn(`  ... and ${phantom.length - 10} more`);
  console.warn('\nThese grants do nothing — the permission check will always deny them.');
}

console.log('\n=== PASS ===');
await mongoose.disconnect();
