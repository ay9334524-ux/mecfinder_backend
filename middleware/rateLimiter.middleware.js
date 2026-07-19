const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const ApiResponse = require('../utils/apiResponse');
const redisService = require('../services/redis.service');

// Local in-memory fallback for the phone OTP limiter when Redis is unreachable.
// In a multi-worker (PM2 cluster) deployment this fallback is per-worker, so
// it should be considered a temporary safety net, not the primary store.
const phoneOtpStoreFallback = new Map();

/**
 * Clean up expired entries from the in-memory phone-OTP fallback store.
 * No-op when Redis is healthy.
 */
const cleanupPhoneOtpStore = () => {
  const now = Date.now();
  for (const [phone, data] of phoneOtpStoreFallback.entries()) {
    if (now > data.resetAt) {
      phoneOtpStoreFallback.delete(phone);
    }
  }
};

setInterval(cleanupPhoneOtpStore, 10 * 60 * 1000);

const PHONE_OTP_MAX = 5;
const PHONE_OTP_WINDOW_SECONDS = 60 * 60; // 1 hour

const phoneOtpRedisKey = (phone) => `rl:phone-otp:${phone}`;

/**
 * Phone-based OTP rate limiter — Redis-backed so it works under PM2 cluster.
 *
 * Pattern: INCR returns new count. If count is 1, we set the TTL. After that
 * the same key auto-expires. If INCR returns >MAX we reject. Falls back to
 * the legacy in-memory map only when Redis is unavailable.
 */
const phoneOtpLimiter = async (req, res, next) => {
  const phone = req.body?.phone;
  if (!phone) return next();

  // Redis path — preferred
  if (redisService.client && redisService.isConnected) {
    try {
      const key = phoneOtpRedisKey(phone);
      const count = await redisService.client.incr(key);
      if (count === 1) {
        await redisService.client.expire(key, PHONE_OTP_WINDOW_SECONDS);
      }

      const ttl = await redisService.client.ttl(key);
      const remainingSeconds = ttl > 0 ? ttl : PHONE_OTP_WINDOW_SECONDS;
      const resetAt = new Date(Date.now() + remainingSeconds * 1000).toISOString();

      res.setHeader('X-RateLimit-Limit', PHONE_OTP_MAX);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, PHONE_OTP_MAX - count));
      res.setHeader('X-RateLimit-Reset', resetAt);

      if (count > PHONE_OTP_MAX) {
        const remainingMinutes = Math.ceil(remainingSeconds / 60);
        res.setHeader('Retry-After', remainingSeconds);
        return ApiResponse.tooManyRequests(
          res,
          `Too many OTP requests. Please try again in ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}.`,
        );
      }

      return next();
    } catch (err) {
      console.warn(`⚠️ Redis OTP limiter failed, falling back to memory: ${err.message}`);
      // Fall through to in-memory path
    }
  }

  // In-memory fallback (single-worker safe; cluster-bypassable)
  const now = Date.now();
  const windowMs = PHONE_OTP_WINDOW_SECONDS * 1000;
  let phoneData = phoneOtpStoreFallback.get(phone);

  if (!phoneData || now > phoneData.resetAt) {
    phoneData = { count: 1, resetAt: now + windowMs };
    phoneOtpStoreFallback.set(phone, phoneData);
    res.setHeader('X-RateLimit-Limit', PHONE_OTP_MAX);
    res.setHeader('X-RateLimit-Remaining', PHONE_OTP_MAX - 1);
    res.setHeader('X-RateLimit-Reset', new Date(phoneData.resetAt).toISOString());
    return next();
  }

  phoneData.count++;
  if (phoneData.count > PHONE_OTP_MAX) {
    const remainingMs = phoneData.resetAt - now;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    res.setHeader('X-RateLimit-Limit', PHONE_OTP_MAX);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.setHeader('X-RateLimit-Reset', new Date(phoneData.resetAt).toISOString());
    res.setHeader('Retry-After', Math.ceil(remainingMs / 1000));
    return ApiResponse.tooManyRequests(
      res,
      `Too many OTP requests. Please try again in ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}.`,
    );
  }

  phoneOtpStoreFallback.set(phone, phoneData);
  res.setHeader('X-RateLimit-Limit', PHONE_OTP_MAX);
  res.setHeader('X-RateLimit-Remaining', PHONE_OTP_MAX - phoneData.count);
  res.setHeader('X-RateLimit-Reset', new Date(phoneData.resetAt).toISOString());
  next();
};

/**
 * Get OTP rate limit status for a phone number (admin / debugging).
 * Reads from Redis if available, falling back to in-memory.
 */
const getPhoneOtpStatus = async (phone) => {
  if (redisService.client && redisService.isConnected) {
    try {
      const key = phoneOtpRedisKey(phone);
      const [countStr, ttl] = await Promise.all([
        redisService.client.get(key),
        redisService.client.ttl(key),
      ]);
      const count = parseInt(countStr || '0', 10);
      const remainingSeconds = ttl > 0 ? ttl : 0;
      return {
        limited: count >= PHONE_OTP_MAX,
        count,
        maxRequests: PHONE_OTP_MAX,
        remainingMinutes: Math.ceil(remainingSeconds / 60),
        resetAt: remainingSeconds > 0
          ? new Date(Date.now() + remainingSeconds * 1000).toISOString()
          : null,
      };
    } catch (err) {
      console.warn(`⚠️ Redis getPhoneOtpStatus failed, using memory: ${err.message}`);
    }
  }

  const data = phoneOtpStoreFallback.get(phone);
  if (!data || Date.now() > data.resetAt) {
    return { limited: false, count: 0, maxRequests: PHONE_OTP_MAX, remainingMinutes: 0 };
  }
  const remainingMs = data.resetAt - Date.now();
  return {
    limited: data.count >= PHONE_OTP_MAX,
    count: data.count,
    maxRequests: PHONE_OTP_MAX,
    remainingMinutes: Math.ceil(remainingMs / 60000),
    resetAt: new Date(data.resetAt).toISOString(),
  };
};

/**
 * Reset OTP rate limit for a phone number (admin function).
 * Clears both Redis and in-memory entries.
 */
const resetPhoneOtpLimit = async (phone) => {
  if (redisService.client && redisService.isConnected) {
    try {
      await redisService.client.del(phoneOtpRedisKey(phone));
    } catch (err) {
      console.warn(`⚠️ Redis resetPhoneOtpLimit failed: ${err.message}`);
    }
  }
  phoneOtpStoreFallback.delete(phone);
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
