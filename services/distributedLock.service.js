const redisService = require('./redis.service');
const { logger } = require('./logger.service');

const DEFAULT_LOCK_TTL_MS = 10000;
const RETRY_DELAY_MS = 50;
const MAX_RETRIES = 20;

class DistributedLock {
  async acquire(lockKey, ttlMs = DEFAULT_LOCK_TTL_MS) {
    if (!redisService.client || !redisService.isConnected) {
      return { acquired: true, token: 'no-redis-fallback' };
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `lock:${lockKey}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await redisService.client.set(key, token, {
        NX: true,
        PX: ttlMs,
      });

      if (result === 'OK') {
        return { acquired: true, token, key };
      }

      await new Promise(r => setTimeout(r, RETRY_DELAY_MS + Math.random() * 30));
    }

    logger.warn(`[lock] Failed to acquire lock: ${lockKey} after ${MAX_RETRIES} retries`);
    return { acquired: false, token: null };
  }

  async release(lockKey, token) {
    if (!redisService.client || !redisService.isConnected || token === 'no-redis-fallback') {
      return true;
    }

    const key = `lock:${lockKey}`;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      const result = await redisService.client.eval(script, {
        keys: [key],
        arguments: [token],
      });
      return result === 1;
    } catch (err) {
      logger.error(`[lock] Release failed: ${lockKey}`, { error: err.message });
      return false;
    }
  }

  async withLock(lockKey, fn, ttlMs = DEFAULT_LOCK_TTL_MS) {
    const { acquired, token } = await this.acquire(lockKey, ttlMs);
    if (!acquired) {
      throw new Error(`Could not acquire lock: ${lockKey}`);
    }

    try {
      return await fn();
    } finally {
      await this.release(lockKey, token);
    }
  }
}

module.exports = new DistributedLock();
