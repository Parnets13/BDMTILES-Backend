import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import { protect } from '../middleware/auth.js';
import { requireBranch } from '../utils/branchScope.js';

const router = Router();
router.use(protect);
router.use(requireBranch);

/**
 * POST /attendance/mark
 * Mark attendance for today
 */
router.post('/mark', async (req, res) => {
  try {
    const userId = req.user._id;
    const branchId = req.branchId;
    
    // Find employee record
    const employee = await Employee.findOne({ user: userId });
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee record not found',
      });
    }

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

    const employee = await Employee.findOne({ user: userId });
    if (!employee) {
      return res.json({
        success: true,
        data: null,
      });
    }

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
    
    const employee = await Employee.findOne({ user: userId });
    if (!employee) {
      return res.json({
        success: true,
        data: {
          records: [],
          stats: {
            present: 0,
            absent: 0,
            late: 0,
            leave: 0,
            percentage: 0,
          },
        },
      });
    }

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
    
    const employee = await Employee.findOne({ user: userId });
    if (!employee) {
      return res.json({
        success: true,
        data: {
          present: 0,
          absent: 0,
          late: 0,
          leave: 0,
          percentage: 0,
        },
      });
    }

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
