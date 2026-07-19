/**
 * Redis Distributed Lock Utility
 * 
 * Provides atomic locking for:
 * - Mechanic acceptance (prevent double-accept race condition)
 * - Booking creation (prevent duplicate bookings)
 * - isBusy toggle (prevent mechanic assigned to 2 bookings)
 * 
 * Uses Redis SET NX EX pattern (atomic set-if-not-exists with expiry)
 * Production-grade: auto-expiry prevents deadlocks
 */

const redisService = require('../services/redis.service');
const crypto = require('crypto');

class RedisLock {
  /**
   * Acquire a distributed lock
   * @param {string} key - Lock key (e.g., 'lock:booking:accept:bookingId')
   * @param {number} ttlSeconds - Lock TTL in seconds (auto-expires to prevent deadlocks)
   * @returns {{ acquired: boolean, lockValue: string }} 
   */
  static async acquire(key, ttlSeconds = 10) {
    try {
      if (!redisService.client || !redisService.isConnected) {
        // Fallback: if Redis is down, allow operation (rely on MongoDB atomics)
        console.warn(`⚠️ Redis not available for lock ${key}, allowing operation`);
        return { acquired: true, lockValue: 'no-redis-fallback' };
      }

      const lockValue = crypto.randomUUID(); // Unique value for this lock holder
      
      // SET NX EX: atomic set-if-not-exists with expiry
      const result = await redisService.client.set(key, lockValue, {
        NX: true,  // Only set if key doesn't exist
        EX: ttlSeconds, // Auto-expire after TTL seconds
      });

      if (result === 'OK') {
        return { acquired: true, lockValue };
      }

      return { acquired: false, lockValue: null };
    } catch (error) {
      console.error(`❌ Lock acquire error for ${key}:`, error.message);
      // Fail-open: allow operation if Redis errors
      return { acquired: true, lockValue: 'error-fallback' };
    }
  }

  /**
   * Release a distributed lock (only if we own it)
   * Uses Lua script for atomic check-and-delete
   * @param {string} key - Lock key
   * @param {string} lockValue - Value returned from acquire()
   */
  static async release(key, lockValue) {
    try {
      if (!redisService.client || !redisService.isConnected) return;
      if (lockValue === 'no-redis-fallback' || lockValue === 'error-fallback') return;

      // Lua script: atomic check-and-delete (only delete if we own the lock)
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      await redisService.client.eval(luaScript, {
        keys: [key],
        arguments: [lockValue],
      });
    } catch (error) {
      console.error(`❌ Lock release error for ${key}:`, error.message);
    }
  }

  /**
   * Execute a function with a distributed lock
   * Automatically acquires and releases the lock
   * @param {string} key - Lock key
   * @param {Function} fn - Async function to execute while holding lock
   * @param {number} ttlSeconds - Lock TTL
   * @returns {*} Result of fn(), or null if lock not acquired
   */
  static async withLock(key, fn, ttlSeconds = 10) {
    const { acquired, lockValue } = await RedisLock.acquire(key, ttlSeconds);
    
    if (!acquired) {
      return { locked: true, result: null }; // Someone else holds the lock
    }

    try {
      const result = await fn();
      return { locked: false, result };
    } finally {
      await RedisLock.release(key, lockValue);
    }
  }

  // ─── Convenience methods for common lock patterns ───

  /**
   * Lock for booking acceptance (prevent 2 mechanics accepting same booking)
   */
  static async lockBookingAccept(bookingId, ttlSeconds = 10) {
    return RedisLock.acquire(`lock:booking:accept:${bookingId}`, ttlSeconds);
  }

  /**
   * Lock for mechanic busy state (prevent mechanic getting 2 bookings)
   */
  static async lockMechanicAssign(mechanicId, ttlSeconds = 10) {
    return RedisLock.acquire(`lock:mechanic:assign:${mechanicId}`, ttlSeconds);
  }

  /**
   * Lock for user booking creation (prevent double-click / duplicate bookings)
   */
  static async lockUserBooking(userId, ttlSeconds = 30) {
    return RedisLock.acquire(`lock:user:booking:${userId}`, ttlSeconds);
  }
}

module.exports = RedisLock;
