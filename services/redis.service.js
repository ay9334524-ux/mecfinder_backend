const { createClient } = require('redis');

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    if (this.isConnected) return this.client;

    try {
      this.client = createClient({
        username: process.env.REDIS_USERNAME || 'default',
        password: process.env.REDIS_PASSWORD,
        socket: {
          host: process.env.REDIS_HOST,
          port: parseInt(process.env.REDIS_PORT) || 15663,
        },
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        console.log('✅ Redis connected successfully');
        this.isConnected = true;
      });

      this.client.on('disconnect', () => {
        console.log('❌ Redis disconnected');
        this.isConnected = false;
      });

      await this.client.connect();
      return this.client;
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  getClient() {
    return this.client;
  }

  // Cache operations
  async set(key, value, expirySeconds = 3600) {
    if (!this.client) throw new Error('Redis not connected');
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
    await this.client.setEx(key, expirySeconds, stringValue);
  }

  async get(key) {
    if (!this.client) throw new Error('Redis not connected');
    const value = await this.client.get(key);
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  async delete(key) {
    if (!this.client) throw new Error('Redis not connected');
    await this.client.del(key);
  }

  async exists(key) {
    if (!this.client) throw new Error('Redis not connected');
    return await this.client.exists(key);
  }

  // Session/Token management
  async setUserSession(userId, sessionData, expirySeconds = 86400) {
    const key = `session:user:${userId}`;
    await this.set(key, sessionData, expirySeconds);
  }

  async getUserSession(userId) {
    const key = `session:user:${userId}`;
    return await this.get(key);
  }

  async deleteUserSession(userId) {
    const key = `session:user:${userId}`;
    await this.delete(key);
  }

  // Mechanic online status
  async setMechanicOnline(mechanicId, locationData, expirySeconds = 300) {
    const key = `mechanic:online:${mechanicId}`;
    await this.set(key, { ...locationData, lastSeen: Date.now() }, expirySeconds);
  }

  async getMechanicOnline(mechanicId) {
    const key = `mechanic:online:${mechanicId}`;
    return await this.get(key);
  }

  async setMechanicOffline(mechanicId) {
    const key = `mechanic:online:${mechanicId}`;
    await this.delete(key);
  }

  async getOnlineMechanics() {
    // Use SCAN instead of KEYS for production (non-blocking)
    const mechanics = [];
    let cursor = 0;
    
    do {
      const result = await this.client.scan(cursor, {
        MATCH: 'mechanic:online:*',
        COUNT: 100
      });
      
      cursor = result.cursor;
      const keys = result.keys;
      
      if (keys.length > 0) {
        // Use MGET for batch retrieval instead of individual GET calls
        const values = await this.client.mGet(keys);
        
        for (let i = 0; i < keys.length; i++) {
          if (values[i]) {
            try {
              const data = JSON.parse(values[i]);
              const mechanicId = keys[i].split(':')[2];
              mechanics.push({ mechanicId, ...data });
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } while (cursor !== 0);
    
    return mechanics;
  }

  // Rate limiting
  async checkRateLimit(key, limit, windowSeconds) {
    const current = await this.client.incr(key);
    if (current === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return current <= limit;
  }

  // OTP storage
  async setOtp(phone, otp, expirySeconds = 300) {
    const key = `otp:${phone}`;
    await this.set(key, { otp, attempts: 0 }, expirySeconds);
  }

  async getOtp(phone) {
    const key = `otp:${phone}`;
    return await this.get(key);
  }

  async incrementOtpAttempts(phone) {
    const key = `otp:${phone}`;
    const data = await this.get(key);
    if (data) {
      data.attempts = (data.attempts || 0) + 1;
      await this.set(key, data, 300);
    }
    return data?.attempts || 0;
  }

  async deleteOtp(phone) {
    const key = `otp:${phone}`;
    await this.delete(key);
  }

  // Pub/Sub for real-time notifications
  async publish(channel, message) {
    if (!this.client) throw new Error('Redis not connected');
    const stringMessage = typeof message === 'object' ? JSON.stringify(message) : message;
    await this.client.publish(channel, stringMessage);
  }

  async subscribe(channel, callback) {
    const subscriber = this.client.duplicate();
    await subscriber.connect();
    await subscriber.subscribe(channel, (message) => {
      try {
        const parsed = JSON.parse(message);
        callback(parsed);
      } catch {
        callback(message);
      }
    });
    return subscriber;
  }

  // Geospatial operations for nearby mechanics
  async addMechanicLocation(mechanicId, longitude, latitude) {
    await this.client.geoAdd('mechanic:locations', {
      longitude,
      latitude,
      member: mechanicId,
    });
  }

  async removeMechanicLocation(mechanicId) {
    await this.client.zRem('mechanic:locations', mechanicId);
  }

  async getNearbyMechanics(longitude, latitude, radiusKm = 10) {
    const results = await this.client.geoSearch('mechanic:locations', {
      longitude,
      latitude,
    }, {
      radius: radiusKm,
      unit: 'km',
    }, {
      WITHDIST: true,
      WITHCOORD: true,
      SORT: 'ASC',
    });
    return results;
  }

  // Cleanup
  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
      console.log('Redis disconnected');
    }
  }
}

// Export singleton instance
const redisService = new RedisService();
module.exports = redisService;
