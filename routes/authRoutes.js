const express = require('express');
const router = express.Router();
const authController = require('../controller/auth.controller');
const { authenticateToken } = require('../middleware/jwt.middleware');
const { authLimiter, otpLimiter } = require('../middleware/rateLimiter.middleware');

// Public routes (no auth required) - with rate limiting
router.post('/send-otp', otpLimiter, authController.sendOtp);
router.post('/verify-otp', authLimiter, authController.verifyOtp);
router.post('/register-user', authLimiter, authController.registerUser);
router.post('/register-mechanic', authLimiter, authController.registerMechanic);
router.post('/refresh', authLimiter, authController.refreshToken);

// Protected routes (auth required)
router.post('/logout', authenticateToken, authController.logout);
router.get('/me', authenticateToken, authController.getMe);

module.exports = router;
