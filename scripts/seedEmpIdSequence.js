/**
 * One-time script: seeds the MasterSequence 'empId' counter to the
 * highest empId number already in the employees collection so the new
 * atomic generateEmpId() never re-issues an existing ID.
 *
 * Run once after deploying the Employee.js / attendanceRoutes.js fix:
 *   node --experimental-vm-modules scripts/seedEmpIdSequence.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import Employee from '../models/Employee.js';
import MasterSequence from '../models/MasterSequence.js';

await mongoose.connect(process.env.MONGODB_URI);

// Find the numerically highest empId already assigned
const employees = await Employee.find({ empId: { $exists: true, $ne: '' } })
  .select('empId')
  .lean();

let maxNum = 0;
for (const emp of employees) {
  const n = parseInt((emp.empId || '').replace(/\D/g, ''), 10);
  if (!isNaN(n) && n > maxNum) maxNum = n;
}

console.log(`Found ${employees.length} employees. Highest empId number: ${maxNum}`);

// Upsert the sequence so the next call to generateEmpId() returns maxNum+1
const seq = await MasterSequence.findOneAndUpdate(
  { key: 'empId' },
  { $max: { value: maxNum } },   // only raises the counter, never lowers it
  { upsert: true, new: true },
);

console.log(`MasterSequence 'empId' counter set to ${seq.value}. Next empId will be EMP${String(seq.value + 1).padStart(4, '0')}.`);

await mongoose.disconnect();
console.log('Done.');
