const express = require('express');
const { 
  registerAdmin, 
  loginAdmin, 
  refreshToken,
  logoutAdmin,
  getProfile,
  changePassword
} = require('../controller/auth.admin');
const { authMiddleware, requireSuperAdmin } = require('../middleware/auth.middleware');
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

module.exports = router;
