const express = require('express');
const { 
  registerAdmin, 
  loginAdmin, 
  refreshToken,
  logoutAdmin,
  getProfile,
  changePassword
} = require('../controller/auth.admin');
const {
  getAllUsers,
  getUserById,
  updateUserStatus,
  getAllMechanics,
  getMechanicById,
  updateMechanicStatus,
  getAllBookings,
  getBookingById,
  updateBookingStatus,
  getDashboardStats,
} = require('../controller/admin.management.controller');
const { authMiddleware, requireSuperAdmin, requireAdmin, requireSupport } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimiter.middleware');

const router = express.Router();

// Check if we're in production - disable public registration
const isProduction = process.env.NODE_ENV === 'production';

// Public routes (no auth required)
// In production, admin registration requires super admin auth
if (isProduction) {
  router.post('/register', authMiddleware, requireSuperAdmin, registerAdmin);
} else {
  router.post('/register', registerAdmin); // Only in development
}

router.post('/login', authLimiter, loginAdmin);
router.post('/refresh-token', authLimiter, refreshToken);

// Protected routes (auth required)
router.post('/logout', authMiddleware, logoutAdmin);
router.get('/profile', authMiddleware, getProfile);
router.post('/change-password', authMiddleware, changePassword);

// Dashboard stats
router.get('/dashboard/stats', authMiddleware, getDashboardStats);

// User management routes (Admin only)
router.get('/users', authMiddleware, requireAdmin, getAllUsers);
router.get('/users/:id', authMiddleware, requireAdmin, getUserById);
router.patch('/users/:id/status', authMiddleware, requireAdmin, updateUserStatus);

// Mechanic management routes (Admin only)
router.get('/mechanics', authMiddleware, requireAdmin, getAllMechanics);
router.get('/mechanics/:id', authMiddleware, requireAdmin, getMechanicById);
router.patch('/mechanics/:id/status', authMiddleware, requireAdmin, updateMechanicStatus);

// Booking management routes (Support and above)
router.get('/bookings', authMiddleware, requireSupport, getAllBookings);
router.get('/bookings/:id', authMiddleware, requireSupport, getBookingById);
router.patch('/bookings/:id/status', authMiddleware, requireAdmin, updateBookingStatus);

module.exports = router;
