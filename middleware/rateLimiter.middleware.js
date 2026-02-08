const rateLimit = require('express-rate-limit');
const ApiResponse = require('../utils/apiResponse');

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests, please try again later',
  handler: (req, res) => {
    ApiResponse.tooManyRequests(res);
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// Strict rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: 'Too many authentication attempts, please try again later',
  handler: (req, res) => {
    ApiResponse.tooManyRequests(res, 'Too many authentication attempts, please try again later');
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// OTP rate limiter (very strict)
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 OTPs per hour
  message: 'Too many OTP requests, please try again after an hour',
  handler: (req, res) => {
    ApiResponse.tooManyRequests(res, 'Too many OTP requests, please try again after an hour');
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// Payment rate limiter
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 payment attempts per hour
  message: 'Too many payment attempts, please try again later',
  handler: (req, res) => {
    ApiResponse.tooManyRequests(res, 'Too many payment attempts, please try again later');
  },
  validate: { xForwardedForHeader: false },
});

// Booking rate limiter
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 booking attempts per hour
  message: 'Too many booking attempts, please try again later',
  handler: (req, res) => {
    ApiResponse.tooManyRequests(res, 'Too many booking attempts, please try again later');
  },
  validate: { xForwardedForHeader: false },
});

// Upload rate limiter
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 uploads per hour
  message: 'Too many upload attempts, please try again later',
  handler: (req, res) => {
    ApiResponse.tooManyRequests(res, 'Too many upload attempts, please try again later');
  },
  validate: { xForwardedForHeader: false },
});

module.exports = {
  apiLimiter,
  authLimiter,
  otpLimiter,
  paymentLimiter,
  bookingLimiter,
  uploadLimiter,
};
