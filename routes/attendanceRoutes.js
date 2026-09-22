import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import { protect } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

/**
 * Find the Employee record linked to a User, creating one atomically if it
 * doesn't exist yet.  Uses findOneAndUpdate with upsert so concurrent requests
 * from the same user (e.g. Dashboard + screen focus firing together) can never
 * both try to insert and collide on the unique empId index.
 *
 * The empId is only generated when a real insert is needed, and the generation
 * itself is wrapped in a retry loop so the tiny window between "read last id"
 * and "insert" is survived without crashing the request.
 */
const findOrCreateEmployee = async (userId, branchId, userData = {}) => {
  // Fast path — employee already exists
  const existing = await Employee.findOne({ userId });
  if (existing) return existing;

  // Slow path — first time this user needs an employee record.
  // Retry up to 5 times in case two concurrent requests generate the same empId.
  const MAX_TRIES = 5;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const empId = await Employee.generateEmpId();
    try {
      const employee = await Employee.findOneAndUpdate(
        { userId },
        {
          $setOnInsert: {
            userId,
            empId,
            name: userData.name || 'Employee',
            mobile: userData.mobile || '0000000000',
            dateOfJoining: new Date(),
            department: 'Warehouse',
            designation: 'Staff',
            branchId,
            status: 'Active',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return employee;
    } catch (err) {
      // E11000 = duplicate key — another concurrent request inserted first.
      // Either it won on empId or on userId; either way just re-read.
      if (err.code === 11000) {
        const found = await Employee.findOne({ userId });
        if (found) return found;
        if (attempt === MAX_TRIES) throw err; // give up after MAX_TRIES
        // else loop and try a fresh empId
      } else {
        throw err;
      }
    }
  }
};

/**
 * POST /attendance/mark
 * Mark attendance for today
 */
router.post('/mark', async (req, res) => {
  try {
    const userId = req.user._id;
    const branchId = req.branchId;

    const employee = await findOrCreateEmployee(userId, branchId, req.user);

    // Get today's date (start of day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check if already marked
    const existing = await Attendance.findOne({
      branch: branchId,
      employee: employee._id,
      date: today,
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Attendance already marked for today',
        data: existing,
      });
    }

    // Create attendance record
    const attendance = await Attendance.create({
      branch: branchId,
      employee: employee._id,
      date: today,
      punchIn: new Date(),
      punchInLocation: req.body.location || undefined,
      status: 'Present',
      source: 'App',
      markedBy: userId,
    });

    return res.json({
      success: true,
      message: 'Attendance marked successfully',
      data: attendance,
    });
  } catch (error) {
    console.error('Mark attendance error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark attendance',
    });
  }
});

/**
 * GET /attendance/today
 * Get today's attendance status
 */
router.get('/today', async (req, res) => {
  try {
    const userId = req.user._id;
    const branchId = req.branchId;

    const employee = await findOrCreateEmployee(userId, branchId, req.user);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const attendance = await Attendance.findOne({
      branch: branchId,
      employee: employee._id,
      date: today,
    });

    return res.json({
      success: true,
      data: attendance,
    });
  } catch (error) {
    console.error('Get today attendance error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * GET /attendance/calendar
 * Get attendance records for a month (calendar view)
 * Query params: year, month (1-12)
 */
router.get('/calendar', async (req, res) => {
  try {
    const userId = req.user._id;
    const branchId = req.branchId;
    
    const employee = await findOrCreateEmployee(userId, branchId, req.user);

    // Parse year and month from query
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    // Get first and last day of month
    const startDate = new Date(year, month - 1, 1);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(year, month, 0);
    endDate.setHours(23, 59, 59, 999);

    // Get all attendance records for the month
    const records = await Attendance.find({
      branch: branchId,
      employee: employee._id,
      date: {
        $gte: startDate,
        $lte: endDate,
      },
    }).sort({ date: 1 });

    // Calculate stats
    const stats = {
      totalDays: records.length,
      present: records.filter(r => r.status === 'Present').length,
      absent: records.filter(r => r.status === 'Absent').length,
      halfDay: records.filter(r => r.status === 'Half Day').length,
      late: records.filter(r => r.status === 'Late').length,
      leave: records.filter(r => r.status === 'Leave').length,
      weekOff: records.filter(r => r.status === 'Week Off').length,
      holiday: records.filter(r => r.status === 'Holiday').length,
    };

    // Calculate attendance percentage
    const workingDays = stats.totalDays - stats.weekOff - stats.holiday;
    const presentDays = stats.present + (stats.halfDay * 0.5);
    stats.percentage = workingDays > 0 
      ? Math.round((presentDays / workingDays) * 100) 
      : 0;

    return res.json({
      success: true,
      data: {
        records,
        stats,
        year,
        month,
      },
    });
  } catch (error) {
    console.error('Get calendar error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * GET /attendance/summary
 * Get attendance summary for current month
 */
router.get('/summary', async (req, res) => {
  try {
    const userId = req.user._id;
    const branchId = req.branchId;
    
    const employee = await findOrCreateEmployee(userId, branchId, req.user);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    startOfMonth.setHours(0, 0, 0, 0);
    
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    endOfMonth.setHours(23, 59, 59, 999);

    const records = await Attendance.find({
      branch: branchId,
      employee: employee._id,
      date: {
        $gte: startOfMonth,
        $lte: endOfMonth,
      },
    });

    const summary = {
      present: records.filter(r => r.status === 'Present').length,
      absent: records.filter(r => r.status === 'Absent').length,
      late: records.filter(r => r.status === 'Late').length,
      leave: records.filter(r => r.status === 'Leave').length,
      halfDay: records.filter(r => r.status === 'Half Day').length,
      totalMarked: records.length,
    };

    // Calculate percentage
    const workingDays = records.filter(r => 
      !['Week Off', 'Holiday'].includes(r.status)
    ).length;
    
    const presentDays = summary.present + (summary.halfDay * 0.5);
    summary.percentage = workingDays > 0
      ? Math.round((presentDays / workingDays) * 100)
      : 0;

    return res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error('Get summary error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;
