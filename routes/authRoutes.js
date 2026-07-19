const express = require('express');
const router = express.Router();
const Joi = require('joi');
const authController = require('../controller/auth.controller');
const { authenticateToken } = require('../middleware/jwt.middleware');
const { authLimiter, phoneOtpLimiter } = require('../middleware/rateLimiter.middleware');
const { validate, authValidations } = require('../utils/validation');

const refreshSchema = Joi.object({
  refreshToken: Joi.string().min(20).required(),
});

// Public routes (no auth required) - with rate limiting
// /send-otp is a no-op stub (Firebase SDK sends OTPs from the client), but we
// still apply phoneOtpLimiter to prevent abuse / phone-number enumeration.
router.post('/send-otp', phoneOtpLimiter, validate(authValidations.sendOtp), authController.sendOtp);
// /verify-otp now accepts a Firebase ID token (firebaseIdToken) instead of an OTP code.
router.post('/verify-otp', authLimiter, validate(authValidations.verifyOtp), authController.verifyOtp);
router.post('/register-user', authLimiter, validate(authValidations.registerUser), authController.registerUser);
router.post('/register-mechanic', authLimiter, validate(authValidations.registerMechanic), authController.registerMechanic);
router.post('/refresh', authLimiter, validate(refreshSchema), authController.refreshToken);

// Protected routes (auth required)
router.post('/logout', authenticateToken, authController.logout);
router.get('/me', authenticateToken, authController.getMe);

module.exports = router;
