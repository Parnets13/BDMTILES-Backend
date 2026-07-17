import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';

dotenv.config();

const createSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Check if super admin already exists
    const existing = await User.findOne({ role: 'super_admin' });
    if (existing) {
      console.log('⚠️  Super Admin already exists:', existing.email);
      process.exit(0);
    }

    const superAdmin = await User.create({
      name: 'Super Admin',
      username: 'superadmin',
      email: 'superadmin@bdmtiles.com',
      password: 'superadmin123',
      phone: '9999999999',
      role: 'super_admin',
      permissions: ['*'],
      status: 'Active',
    });

    console.log('\n✅ Super Admin created successfully!');
    console.log('   Email:    superadmin@bdmtiles.com');
    console.log('   Username: superadmin');
    console.log('   Password: superadmin123');
    console.log('\n⚠️  CHANGE THIS PASSWORD IMMEDIATELY IN PRODUCTION!\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

createSuperAdmin();
