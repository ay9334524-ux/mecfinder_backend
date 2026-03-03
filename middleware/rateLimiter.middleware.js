const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const ApiResponse = require('../utils/apiResponse');
const redisService = require('../services/redis.service');

// In-memory store for phone-based OTP rate limiting
const phoneOtpStore = new Map();

/**
 * Clean up expired entries from phone OTP store
 */
const cleanupPhoneOtpStore = () => {
  const now = Date.now();
  for (const [phone, data] of phoneOtpStore.entries()) {
    if (now > data.resetAt) {
      phoneOtpStore.delete(phone);
    }
  }
};

// Run cleanup every 10 minutes
setInterval(cleanupPhoneOtpStore, 10 * 60 * 1000);

/**
 * Phone-based OTP rate limiter middleware
 * Limits OTP requests to 5 per phone number per hour
 */
const phoneOtpLimiter = (req, res, next) => {
  const phone = req.body?.phone;
  
  if (!phone) {
    return next(); // Let the controller handle missing phone
  }

  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxRequests = 5;

  let phoneData = phoneOtpStore.get(phone);

  // If no data exists or window has expired, create new entry
  if (!phoneData || now > phoneData.resetAt) {
    phoneData = {
      count: 1,
      resetAt: now + windowMs,
      firstRequestAt: now
    };
    phoneOtpStore.set(phone, phoneData);
    
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', maxRequests - 1);
    res.setHeader('X-RateLimit-Reset', new Date(phoneData.resetAt).toISOString());
    
    return next();
  }

  // Increment count
  phoneData.count++;

  // Check if limit exceeded
  if (phoneData.count > maxRequests) {
    const remainingMs = phoneData.resetAt - now;
    const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
    
    console.log(`🚫 OTP rate limit exceeded for ${phone}. Count: ${phoneData.count}, Resets in: ${remainingMinutes} minutes`);
    
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.setHeader('X-RateLimit-Reset', new Date(phoneData.resetAt).toISOString());
    res.setHeader('Retry-After', Math.ceil(remainingMs / 1000));
    
    return ApiResponse.tooManyRequests(
      res, 
      `Too many OTP requests. Please try again in ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}.`
    );
  }

  // Update store
  phoneOtpStore.set(phone, phoneData);
  
  // Add rate limit headers
  res.setHeader('X-RateLimit-Limit', maxRequests);
  res.setHeader('X-RateLimit-Remaining', maxRequests - phoneData.count);
  res.setHeader('X-RateLimit-Reset', new Date(phoneData.resetAt).toISOString());
  
  console.log(`📊 OTP request for ${phone}. Count: ${phoneData.count}/${maxRequests}`);
  
  next();
};

/**
 * Get OTP rate limit status for a phone number (for debugging/admin)
 */
const getPhoneOtpStatus = (phone) => {
  const data = phoneOtpStore.get(phone);
  if (!data) {
    return { limited: false, count: 0, maxRequests: 5, remainingMinutes: 0 };
  }
  
  const now = Date.now();
  if (now > data.resetAt) {
    return { limited: false, count: 0, maxRequests: 5, remainingMinutes: 0 };
  }
  
  const remainingMs = data.resetAt - now;
  const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
  
  return {
    limited: data.count >= 5,
    count: data.count,
    maxRequests: 5,
    remainingMinutes,
    resetAt: new Date(data.resetAt).toISOString()
  };
};

/**
 * Reset OTP rate limit for a phone number (admin function)
 */
const resetPhoneOtpLimit = (phone) => {
  phoneOtpStore.delete(phone);
  console.log(`🔄 OTP rate limit reset for ${phone}`);
  return true;
};

/**
 * Create Redis store for rate limiting (works across multiple server instances)
 * Falls back to in-memory if Redis is unavailable
 */
const createRedisStore = (prefix) => {
  try {
    if (redisService.client && redisService.isConnected) {
      return new RedisStore({
        sendCommand: (...args) => redisService.client.sendCommand(args),
        prefix: `rl:${prefix}:`,
      });
    }
  } catch (error) {
    console.warn(`⚠️ Redis store creation failed for ${prefix}, using memory:`, error.message);
  }
  return undefined; // Falls back to in-memory
};

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
  store: createRedisStore('api'),
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
  store: createRedisStore('auth'),
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
  store: createRedisStore('otp'),
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
  store: createRedisStore('payment'),
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
  store: createRedisStore('booking'),
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
  store: createRedisStore('upload'),
});

module.exports = {
  apiLimiter,
  authLimiter,
  otpLimiter,
  phoneOtpLimiter,
  getPhoneOtpStatus,
  resetPhoneOtpLimit,
  paymentLimiter,
  bookingLimiter,
  uploadLimiter,
};
