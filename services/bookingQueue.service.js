/**
 * Booking Queue Service — Production Grade
 * 
 * Implements Round-Robin mechanic dispatch with:
 * - Redis distributed locking (prevents double-accept race conditions)
 * - Atomic isBusy + currentBookingId management
 * - Redis-persisted queue state (survives server restart)
 * - Per-mechanic timeout (10s) + total search timeout (90s)
 * - FCM push + Socket.io for reliable delivery
 * - Fresh mechanic availability check before each send
 * 
 * Flow:
 * 1. User creates booking → queue starts with sorted nearby mechanics
 * 2. System sends request to FIRST mechanic only (round-robin, not fan-out)
 * 3. Mechanic has 10s to respond
 * 4. If timeout/reject → auto-skip to next mechanic
 * 5. If accept → Redis lock → atomic MongoDB update → isBusy=true → queue cleared
 * 6. If all exhausted → notify user "no mechanics available"
 */

const redisService = require('./redis.service');
const socketService = require('./socket.service');
const Booking = require('../models/Booking');
const Mechanic = require('../models/Mechanic');
const RedisLock = require('../utils/redisLock');

class BookingQueueService {
  constructor() {
    this.activeQueues = new Map(); // In-memory cache, Redis is source of truth
    this.TIMEOUT_SECONDS = 10; // Per mechanic timeout
    this.MAX_TOTAL_TIMEOUT_SECONDS = 90; // Total search timeout
  }

  /**
   * Start booking queue for a new booking
   */
  async startQueue(booking, nearbyMechanics) {
    const bookingId = booking._id.toString();
    
    if (nearbyMechanics.length === 0) {
      await this.handleNoMechanicsAvailable(booking);
      return;
    }

    const queueData = {
      bookingId,
      booking,
      mechanics: nearbyMechanics.map(m => ({
        id: m._id?.toString() || m.toString(),
        distance: m.distance || null,
        name: m.fullName || 'Mechanic',
        fcmToken: m.fcmToken || null,
      })),
      currentIndex: 0,
      startedAt: Date.now(),
      timer: null,
      totalTimer: null,
      rejections: 0,
      timeouts: 0,
    };

    this.activeQueues.set(bookingId, queueData);
    await this.saveQueueToRedis(bookingId, queueData);

    console.log(`🎯 Starting queue for booking ${bookingId} with ${nearbyMechanics.length} mechanics`);
    
    this.startTotalTimeout(bookingId);
    await this.sendToNextMechanic(bookingId);

    this.notifyUserQueueStatus(booking.userId.toString(), {
      bookingId,
      status: 'SEARCHING',
      totalMechanics: nearbyMechanics.length,
      currentPosition: 1,
      message: 'Finding the best mechanic for you...',
    });
  }

  /**
   * Send booking request to next mechanic in queue
   */
  async sendToNextMechanic(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return;

    const { mechanics, currentIndex, booking } = queueData;

    if (currentIndex >= mechanics.length) {
      console.log(`📭 All ${mechanics.length} mechanics exhausted for booking ${bookingId}`);
      await this.handleNoMechanicsAvailable(booking);
      return;
    }

    const currentMechanic = mechanics[currentIndex];

    // Fresh availability check before sending
    try {
      const freshMechanic = await Mechanic.findById(currentMechanic.id)
        .select('isOnline isBusy currentBookingId').lean();
      if (!freshMechanic || !freshMechanic.isOnline || freshMechanic.isBusy || freshMechanic.currentBookingId) {
        console.log(`⏭️ Mechanic ${currentMechanic.name} no longer available, skipping...`);
        queueData.currentIndex++;
        this.activeQueues.set(bookingId, queueData);
        await this.saveQueueToRedis(bookingId, queueData);
        return this.sendToNextMechanic(bookingId);
      }
    } catch (err) {
      console.warn(`⚠️ Availability check failed: ${err.message}`);
    }

    console.log(`📤 Sending booking ${bookingId} to ${currentMechanic.name} (${currentIndex + 1}/${mechanics.length}) [${currentMechanic.distance?.toFixed(1)}km]`);

    const bookingData = {
      _id: booking._id.toString(),
      bookingId: booking.bookingId,
      serviceName: booking.serviceSnapshot?.name || 'Service',
      service: booking.serviceSnapshot,
      location: {
        lat: booking.location?.coordinates?.[1] || booking.location?.lat,
        lng: booking.location?.coordinates?.[0] || booking.location?.lng,
        address: booking.location?.address || 'Location',
      },
      vehicleType: booking.vehicleDetails?.type || 'CAR',
      estimatedPrice: booking.pricing?.totalAmount || booking.pricing?.estimatedTotal,
      price: booking.pricing?.mechanicEarning,
      userId: booking.userId,
      distance: currentMechanic.distance,
      queueInfo: {
        timeout: this.TIMEOUT_SECONDS,
        isExclusive: true,
      },
    };

    socketService.emitToMechanic(currentMechanic.id, 'booking:new', bookingData);

    // FCM push backup
    if (currentMechanic.fcmToken) {
      try {
        const firebaseService = require('./firebase.service');
        await firebaseService.sendNotification(currentMechanic.fcmToken, {
          title: '🔔 New Job Request!',
          body: `${bookingData.serviceName} - ₹${bookingData.price || bookingData.estimatedPrice} (${currentMechanic.distance?.toFixed(1)}km)`,
          data: { type: 'NEW_BOOKING', bookingId, timeout: String(this.TIMEOUT_SECONDS) },
        });
      } catch (fcmError) {
        console.warn(`⚠️ FCM failed for ${currentMechanic.id}:`, fcmError.message);
      }
    }

    await redisService.set(`booking:queue:current:${bookingId}`, {
      mechanicId: currentMechanic.id,
      sentAt: Date.now(),
      expiresAt: Date.now() + (this.TIMEOUT_SECONDS * 1000),
    }, this.TIMEOUT_SECONDS + 5);

    this.startTimeout(bookingId);

    this.notifyUserQueueStatus(booking.userId.toString(), {
      bookingId,
      status: 'REQUESTING',
      totalMechanics: mechanics.length,
      currentPosition: currentIndex + 1,
      mechanicName: currentMechanic.name,
      distance: currentMechanic.distance,
      timeoutSeconds: this.TIMEOUT_SECONDS,
      message: `Requesting mechanic ${currentIndex + 1} of ${mechanics.length}...`,
    });
  }

  startTimeout(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return;
    if (queueData.timer) clearTimeout(queueData.timer);

    queueData.timer = setTimeout(async () => {
      console.log(`⏰ Timeout for booking ${bookingId}`);
      queueData.timeouts++;
      await this.skipToNextMechanic(bookingId, 'timeout');
    }, this.TIMEOUT_SECONDS * 1000);

    this.activeQueues.set(bookingId, queueData);
  }

  startTotalTimeout(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return;

    queueData.totalTimer = setTimeout(async () => {
      console.log(`⏰ TOTAL TIMEOUT for booking ${bookingId}`);
      
      socketService.emitToUser(queueData.booking.userId.toString(), 'booking:search-timeout', {
        bookingId,
        message: 'Could not find an available mechanic. Please try again.',
        canRetry: true,
      });
      
      await Booking.findByIdAndUpdate(bookingId, {
        $set: {
          status: 'NO_MECHANIC_AVAILABLE',
          'dispatchInfo.totalRejections': queueData.rejections,
          'dispatchInfo.totalTimeouts': queueData.timeouts,
        },
        $push: {
          statusHistory: {
            status: 'NO_MECHANIC_AVAILABLE',
            timestamp: new Date(),
            note: `Total timeout after ${this.MAX_TOTAL_TIMEOUT_SECONDS}s. ${queueData.rejections} rejections, ${queueData.timeouts} timeouts.`,
          },
        },
      });
      
      await this.cleanupQueue(bookingId);
    }, this.MAX_TOTAL_TIMEOUT_SECONDS * 1000);

    this.activeQueues.set(bookingId, queueData);
  }

  async handleMechanicReject(bookingId, mechanicId, reason = 'rejected') {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return;

    const currentMechanic = queueData.mechanics[queueData.currentIndex];
    if (currentMechanic?.id !== mechanicId) return;

    console.log(`❌ ${currentMechanic.name} rejected booking ${bookingId}: ${reason}`);
    queueData.rejections++;
    
    await redisService.set(`booking:reject:${bookingId}:${mechanicId}`, {
      reason, rejectedAt: Date.now(),
    }, 3600);

    await this.skipToNextMechanic(bookingId, reason);
  }

  async skipToNextMechanic(bookingId, reason) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return;

    if (queueData.timer) {
      clearTimeout(queueData.timer);
      queueData.timer = null;
    }

    const currentMechanic = queueData.mechanics[queueData.currentIndex];
    if (currentMechanic) {
      socketService.emitToMechanic(currentMechanic.id, 'booking:timeout', {
        bookingId,
        reason: reason === 'timeout' ? 'Time expired' : 'Moved to next mechanic',
      });
    }

    queueData.currentIndex++;
    this.activeQueues.set(bookingId, queueData);
    await this.saveQueueToRedis(bookingId, queueData);
    await this.sendToNextMechanic(bookingId);
  }

  /**
   * Handle mechanic acceptance — PRODUCTION GRADE
   * 
   * Triple lock:
   * 1. Redis lock on bookingId (prevents double-accept across servers)
   * 2. Redis lock on mechanicId (prevents mechanic accepting 2 bookings)
   * 3. MongoDB findOneAndUpdate with status guard (atomic DB write)
   */
  async handleMechanicAccept(bookingId, mechanicId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) {
      return { success: false, error: 'Queue not found' };
    }

    const currentMechanic = queueData.mechanics[queueData.currentIndex];
    if (currentMechanic?.id !== mechanicId) {
      return { success: false, error: 'Not your turn to accept' };
    }

    // 🔒 LOCK 1: Booking acceptance lock
    const bookingLock = await RedisLock.lockBookingAccept(bookingId, 10);
    if (!bookingLock.acquired) {
      return { success: false, error: 'Accept already being processed' };
    }

    // 🔒 LOCK 2: Mechanic assignment lock
    const mechanicLock = await RedisLock.lockMechanicAssign(mechanicId, 10);
    if (!mechanicLock.acquired) {
      await RedisLock.release(`lock:booking:accept:${bookingId}`, bookingLock.lockValue);
      return { success: false, error: 'You are being assigned to another booking' };
    }

    try {
      if (queueData.timer) clearTimeout(queueData.timer);

      // 🔒 ATOMIC DB: Only succeeds if booking is still unassigned
      const booking = await Booking.findOneAndUpdate(
        {
          _id: bookingId,
          status: { $in: ['PENDING', 'SEARCHING'] },
          mechanicId: { $eq: null },
        },
        {
          $set: {
            mechanicId,
            status: 'ACCEPTED',
            acceptedAt: new Date(),
            'dispatchInfo.assignedFromPosition': queueData.currentIndex + 1,
            'dispatchInfo.totalRejections': queueData.rejections,
            'dispatchInfo.totalTimeouts': queueData.timeouts,
          },
          $push: {
            statusHistory: {
              status: 'ACCEPTED',
              timestamp: new Date(),
              mechanicId,
              note: `Accepted by mechanic (position ${queueData.currentIndex + 1}/${queueData.mechanics.length}, ${currentMechanic.distance?.toFixed(1)}km)`,
            },
          },
        },
        { new: true }
      );

      if (!booking) {
        return { success: false, error: 'Booking no longer available' };
      }

      // Set mechanic as busy atomically
      await Mechanic.findByIdAndUpdate(mechanicId, {
        $set: {
          isBusy: true,
          currentBookingId: booking._id,
          lastActiveAt: new Date(),
        },
      });

      console.log(`✅ ${currentMechanic.name} accepted booking ${bookingId} (pos ${queueData.currentIndex + 1}/${queueData.mechanics.length})`);

      // Notify user
      socketService.emitToUser(queueData.booking.userId.toString(), 'booking:accepted', {
        bookingId,
        mechanicId,
        mechanicName: currentMechanic.name,
        distance: currentMechanic.distance,
        message: 'A mechanic has accepted your request!',
      });

      // Cancel for remaining mechanics
      for (let i = queueData.currentIndex + 1; i < queueData.mechanics.length; i++) {
        socketService.emitToMechanic(queueData.mechanics[i].id, 'booking:cancelled', {
          bookingId,
          reason: 'Accepted by another mechanic',
        });
      }

      await this.cleanupQueue(bookingId);
      return { success: true, booking };
    } finally {
      await RedisLock.release(`lock:booking:accept:${bookingId}`, bookingLock.lockValue);
      await RedisLock.release(`lock:mechanic:assign:${mechanicId}`, mechanicLock.lockValue);
    }
  }

  async handleNoMechanicsAvailable(booking) {
    const bookingId = booking._id.toString();

    await Booking.findByIdAndUpdate(bookingId, {
      $set: { status: 'NO_MECHANIC_AVAILABLE' },
      $push: {
        statusHistory: {
          status: 'NO_MECHANIC_AVAILABLE',
          timestamp: new Date(),
          note: 'No mechanics available or all declined',
        },
      },
    });

    socketService.emitToUser(booking.userId.toString(), 'booking:no-mechanic', {
      bookingId,
      message: 'Sorry, no mechanics are available right now. Please try again later.',
      canRetry: true,
    });

    await this.cleanupQueue(bookingId);
  }

  async cleanupQueue(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (queueData?.timer) clearTimeout(queueData.timer);
    if (queueData?.totalTimer) clearTimeout(queueData.totalTimer);
    this.activeQueues.delete(bookingId);
    
    try {
      await redisService.delete(`booking:queue:${bookingId}`);
      await redisService.delete(`booking:queue:current:${bookingId}`);
    } catch (err) {
      console.warn(`⚠️ Redis cleanup failed for ${bookingId}:`, err.message);
    }
  }

  notifyUserQueueStatus(userId, data) {
    socketService.emitToUser(userId, 'booking:queue-status', data);
  }

  async saveQueueToRedis(bookingId, queueData) {
    try {
      await redisService.set(`booking:queue:${bookingId}`, {
        mechanics: queueData.mechanics,
        currentIndex: queueData.currentIndex,
        startedAt: queueData.startedAt,
        rejections: queueData.rejections || 0,
        timeouts: queueData.timeouts || 0,
      }, 600);
    } catch (error) {
      console.error('Error saving queue to Redis:', error.message);
    }
  }

  /**
   * Restore queues from Redis after server restart
   */
  async restoreQueues() {
    try {
      if (!redisService.isConnected || !redisService.client) {
        console.log('⚠️ Redis not available, skipping queue restore');
        return;
      }

      let restoredCount = 0;
      
      // Use scanIterator for compatibility with redis v4+
      try {
        const keys = [];
        for await (const key of redisService.client.scanIterator({
          MATCH: 'booking:queue:*',
          COUNT: 100,
        })) {
          const keyStr = typeof key === 'string' ? key : String(key);
          if (!keyStr.includes(':current:')) {
            keys.push(keyStr);
          }
        }

        for (const key of keys) {
          const bookingId = key.replace('booking:queue:', '');
          
          // Skip invalid/empty bookingIds and clean up stale keys
          if (!bookingId || bookingId.trim() === '' || !/^[a-fA-F0-9]{24}$/.test(bookingId)) {
            await redisService.delete(key).catch(() => {});
            continue;
          }

          try {
            const queueData = await redisService.get(key);
            const booking = await Booking.findById(bookingId);
            
            if (booking && queueData && booking.status === 'SEARCHING') {
              console.log(`🔄 Restoring queue for booking ${bookingId}`);
              this.activeQueues.set(bookingId, {
                ...queueData,
                bookingId,
                booking,
                timer: null,
                totalTimer: null,
              });
              this.startTotalTimeout(bookingId);
              await this.sendToNextMechanic(bookingId);
              restoredCount++;
            } else if (booking && booking.status !== 'SEARCHING') {
              await redisService.delete(key);
            }
          } catch (err) {
            console.error(`❌ Failed to restore queue ${bookingId}:`, err.message);
          }
        }
      } catch (scanErr) {
        console.warn(`⚠️ Redis scan failed: ${scanErr.message}, trying legacy scan...`);
        // Fallback: just skip, queues will expire via Redis TTL
      }

      console.log(restoredCount > 0 
        ? `✅ Restored ${restoredCount} active booking queues`
        : `ℹ️ No active booking queues to restore`);
    } catch (error) {
      console.error('❌ Error restoring queues:', error.message);
    }
  }

  /**
   * Release mechanic when booking completes/cancels
   */
  async releaseMechanic(mechanicId) {
    if (!mechanicId) return;
    try {
      await Mechanic.findByIdAndUpdate(mechanicId, {
        $set: { isBusy: false, currentBookingId: null },
      });
      console.log(`🔓 Mechanic ${mechanicId} released`);
    } catch (err) {
      console.error(`❌ Failed to release mechanic ${mechanicId}:`, err.message);
    }
  }

  getQueueStatus(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return null;
    return {
      totalMechanics: queueData.mechanics.length,
      currentPosition: queueData.currentIndex + 1,
      remainingMechanics: queueData.mechanics.length - queueData.currentIndex,
      rejections: queueData.rejections,
      timeouts: queueData.timeouts,
      elapsedSeconds: Math.round((Date.now() - queueData.startedAt) / 1000),
    };
  }
}

const bookingQueueService = new BookingQueueService();
module.exports = bookingQueueService;
