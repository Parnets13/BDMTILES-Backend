import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Employee from '../models/Employee.js';
import { ensureSrvResolvable } from '../config/db.js';

// Load environment variables
dotenv.config();

async function fixEmployeeEmpIds() {
  try {
    // Connect to MongoDB
    // A network that refuses SRV queries cannot resolve mongodb+srv://, which would
    // stop this script with a confusing ECONNREFUSED. Same fallback the server uses.
    await ensureSrvResolvable(process.env.MONGODB_URI);
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Find all employees with null empId
    const employeesWithNullEmpId = await Employee.find({ empId: null });
    console.log(`Found ${employeesWithNullEmpId.length} employees with null empId`);

    if (employeesWithNullEmpId.length === 0) {
      console.log('No employees with null empId found. Exiting.');
      process.exit(0);
    }

    // Option 1: Delete employees with null empId (recommended if they were auto-created incorrectly)
    console.log('\nDeleting employees with null empId...');
    const deleteResult = await Employee.deleteMany({ empId: null });
    console.log(`Deleted ${deleteResult.deletedCount} employees with null empId`);

    console.log('\n✅ Database cleanup complete!');
    process.exit(0);
  } catch (error) {
    console.error('Error fixing empId:', error);
    process.exit(1);
  }
}

fixEmployeeEmpIds();
