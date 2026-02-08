/**
 * Booking Queue Service
 * Implements Round-Robin mechanic assignment with timeout
 * 
 * Flow:
 * 1. User creates booking -> added to queue with sorted nearby mechanics
 * 2. System sends request to first mechanic in queue
 * 3. If mechanic doesn't respond in 10 seconds -> auto-skip to next
 * 4. If mechanic rejects -> immediately skip to next
 * 5. If mechanic accepts -> booking assigned, queue cleared
 * 6. If all mechanics exhausted -> notify user no mechanics available
 */

const redisService = require('./redis.service');
const socketService = require('./socket.service');
const Booking = require('../models/Booking');
const Mechanic = require('../models/Mechanic');

class BookingQueueService {
  constructor() {
    this.activeQueues = new Map(); // bookingId -> { mechanics, currentIndex, timer }
    this.TIMEOUT_SECONDS = 10;
  }

  /**
   * Start booking queue for a new booking
   * @param {Object} booking - The booking document
   * @param {Array} nearbyMechanics - Sorted list of nearby mechanics by distance
   */
  async startQueue(booking, nearbyMechanics) {
    const bookingId = booking._id.toString();
    
    if (nearbyMechanics.length === 0) {
      console.log(`📭 No mechanics available for booking ${bookingId}`);
      await this.handleNoMechanicsAvailable(booking);
      return;
    }

    // Store queue data
    const queueData = {
      bookingId,
      booking,
      mechanics: nearbyMechanics.map(m => ({
        id: m._id?.toString() || m.toString(),
        distance: m.distance || null,
        name: m.fullName || 'Mechanic',
      })),
      currentIndex: 0,
      startedAt: Date.now(),
      timer: null,
    };

    this.activeQueues.set(bookingId, queueData);

    // Store in Redis for persistence
    await this.saveQueueToRedis(bookingId, queueData);

    console.log(`🎯 Starting queue for booking ${bookingId} with ${nearbyMechanics.length} mechanics`);
    
    // Send to first mechanic
    await this.sendToNextMechanic(bookingId);

    // Notify user about queue status
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
    if (!queueData) {
      console.log(`Queue not found for booking ${bookingId}`);
      return;
    }

    const { mechanics, currentIndex, booking } = queueData;

    // Check if we've exhausted all mechanics
    if (currentIndex >= mechanics.length) {
      console.log(`📭 All mechanics exhausted for booking ${bookingId}`);
      await this.handleNoMechanicsAvailable(booking);
      return;
    }

    const currentMechanic = mechanics[currentIndex];
    console.log(`📤 Sending booking ${bookingId} to mechanic ${currentMechanic.id} (${currentIndex + 1}/${mechanics.length})`);

    // Prepare booking data for mechanic
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
      // Queue info for UI
      queueInfo: {
        timeout: this.TIMEOUT_SECONDS,
        isExclusive: true, // Only this mechanic is receiving right now
      },
    };

    // Send to specific mechanic only (not broadcast)
    socketService.emitToMechanic(currentMechanic.id, 'booking:new', bookingData);

    // Store current mechanic in Redis (for timeout tracking across servers)
    await redisService.set(`booking:queue:current:${bookingId}`, {
      mechanicId: currentMechanic.id,
      sentAt: Date.now(),
      expiresAt: Date.now() + (this.TIMEOUT_SECONDS * 1000),
    }, this.TIMEOUT_SECONDS + 5);

    // Set timeout for auto-skip
    this.startTimeout(bookingId);

    // Notify user about progress
    this.notifyUserQueueStatus(booking.userId.toString(), {
      bookingId,
      status: 'REQUESTING',
      totalMechanics: mechanics.length,
      currentPosition: currentIndex + 1,
      mechanicName: currentMechanic.name,
      timeoutSeconds: this.TIMEOUT_SECONDS,
      message: `Requesting mechanic ${currentIndex + 1} of ${mechanics.length}...`,
    });
  }

  /**
   * Start timeout timer for current mechanic
   */
  startTimeout(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return;

    // Clear existing timer if any
    if (queueData.timer) {
      clearTimeout(queueData.timer);
    }

    // Set new timeout
    queueData.timer = setTimeout(async () => {
      console.log(`⏰ Timeout for booking ${bookingId} - moving to next mechanic`);
      await this.skipToNextMechanic(bookingId, 'timeout');
    }, this.TIMEOUT_SECONDS * 1000);

    this.activeQueues.set(bookingId, queueData);
  }

  /**
   * Handle mechanic rejection - immediately skip to next
   */
  async handleMechanicReject(bookingId, mechanicId, reason = 'rejected') {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) {
      console.log(`Queue not found for booking ${bookingId}`);
      return;
    }

    const currentMechanic = queueData.mechanics[queueData.currentIndex];
    if (currentMechanic?.id !== mechanicId) {
      console.log(`Rejection from non-current mechanic ${mechanicId} for booking ${bookingId}`);
      return;
    }

    console.log(`❌ Mechanic ${mechanicId} rejected booking ${bookingId}: ${reason}`);
    
    // Store rejection in Redis for analytics
    await redisService.set(`booking:reject:${bookingId}:${mechanicId}`, {
      reason,
      rejectedAt: Date.now(),
    }, 3600);

    await this.skipToNextMechanic(bookingId, reason);
  }

  /**
   * Skip to next mechanic in queue
   */
  async skipToNextMechanic(bookingId, reason) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return;

    // Clear existing timer
    if (queueData.timer) {
      clearTimeout(queueData.timer);
      queueData.timer = null;
    }

    // Notify current mechanic that opportunity passed
    const currentMechanic = queueData.mechanics[queueData.currentIndex];
    if (currentMechanic) {
      socketService.emitToMechanic(currentMechanic.id, 'booking:timeout', {
        bookingId,
        reason: reason === 'timeout' ? 'Time expired' : 'Moved to next mechanic',
      });
    }

    // Move to next mechanic
    queueData.currentIndex++;
    this.activeQueues.set(bookingId, queueData);

    // Update Redis
    await this.saveQueueToRedis(bookingId, queueData);

    // Send to next mechanic
    await this.sendToNextMechanic(bookingId);
  }

  /**
   * Handle mechanic acceptance
   */
  async handleMechanicAccept(bookingId, mechanicId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) {
      console.log(`Queue not found for booking ${bookingId}`);
      return { success: false, error: 'Queue not found' };
    }

    // Verify this is the current mechanic
    const currentMechanic = queueData.mechanics[queueData.currentIndex];
    if (currentMechanic?.id !== mechanicId) {
      console.log(`Accept from non-current mechanic ${mechanicId} for booking ${bookingId}`);
      return { success: false, error: 'Not your turn to accept' };
    }

    // Clear timer
    if (queueData.timer) {
      clearTimeout(queueData.timer);
    }

    // Atomic update to prevent race condition
    const booking = await Booking.findOneAndUpdate(
      {
        _id: bookingId,
        status: { $in: ['PENDING', 'SEARCHING'] },
        mechanicId: { $eq: null },
      },
      {
        $set: {
          mechanicId: mechanicId,
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
        $push: {
          statusHistory: {
            status: 'ACCEPTED',
            timestamp: new Date(),
            note: `Accepted by mechanic via queue (position ${queueData.currentIndex + 1}/${queueData.mechanics.length})`,
          },
        },
      },
      { new: true }
    );

    if (!booking) {
      return { success: false, error: 'Booking no longer available' };
    }

    console.log(`✅ Mechanic ${mechanicId} accepted booking ${bookingId}`);

    // Notify user
    socketService.emitToUser(queueData.booking.userId.toString(), 'booking:accepted', {
      bookingId,
      mechanicId,
      message: 'A mechanic has accepted your request!',
    });

    // Notify other mechanics that job is taken
    for (let i = queueData.currentIndex + 1; i < queueData.mechanics.length; i++) {
      socketService.emitToMechanic(queueData.mechanics[i].id, 'booking:cancelled', {
        bookingId,
        reason: 'Accepted by another mechanic',
      });
    }

    // Cleanup queue
    await this.cleanupQueue(bookingId);

    return { success: true, booking };
  }

  /**
   * Handle when no mechanics are available
   */
  async handleNoMechanicsAvailable(booking) {
    const bookingId = booking._id.toString();

    // Update booking status
    await Booking.findByIdAndUpdate(bookingId, {
      $set: {
        status: 'NO_MECHANIC_AVAILABLE',
      },
      $push: {
        statusHistory: {
          status: 'NO_MECHANIC_AVAILABLE',
          timestamp: new Date(),
          note: 'No mechanics available or all declined',
        },
      },
    });

    // Notify user
    socketService.emitToUser(booking.userId.toString(), 'booking:no-mechanic', {
      bookingId,
      message: 'Sorry, no mechanics are available right now. Please try again later.',
    });

    // Cleanup
    await this.cleanupQueue(bookingId);
  }

  /**
   * Cleanup queue after completion or timeout
   */
  async cleanupQueue(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (queueData?.timer) {
      clearTimeout(queueData.timer);
    }

    this.activeQueues.delete(bookingId);
    
    // Remove from Redis
    await redisService.delete(`booking:queue:${bookingId}`);
    await redisService.delete(`booking:queue:current:${bookingId}`);
  }

  /**
   * Notify user about queue status
   */
  notifyUserQueueStatus(userId, data) {
    socketService.emitToUser(userId, 'booking:queue-status', data);
  }

  /**
   * Save queue to Redis for persistence
   */
  async saveQueueToRedis(bookingId, queueData) {
    try {
      await redisService.set(`booking:queue:${bookingId}`, {
        mechanics: queueData.mechanics,
        currentIndex: queueData.currentIndex,
        startedAt: queueData.startedAt,
      }, 600); // 10 minutes TTL
    } catch (error) {
      console.error('Error saving queue to Redis:', error);
    }
  }

  /**
   * Restore queue from Redis (for server restart)
   */
  async restoreQueues() {
    try {
      // Scan for active queues
      let cursor = 0;
      do {
        const result = await redisService.client.scan(cursor, {
          MATCH: 'booking:queue:*',
          COUNT: 100,
        });
        
        cursor = result.cursor;
        
        for (const key of result.keys) {
          if (key.includes(':current:')) continue; // Skip current mechanic keys
          
          const bookingId = key.replace('booking:queue:', '');
          const queueData = await redisService.get(key);
          const booking = await Booking.findById(bookingId);
          
          if (booking && queueData && booking.status === 'SEARCHING') {
            console.log(`🔄 Restoring queue for booking ${bookingId}`);
            this.activeQueues.set(bookingId, {
              ...queueData,
              bookingId,
              booking,
              timer: null,
            });
            
            // Resume from current mechanic
            await this.sendToNextMechanic(bookingId);
          }
        }
      } while (cursor !== 0);
    } catch (error) {
      console.error('Error restoring queues:', error);
    }
  }

  /**
   * Get queue status for a booking
   */
  getQueueStatus(bookingId) {
    const queueData = this.activeQueues.get(bookingId);
    if (!queueData) return null;

    return {
      totalMechanics: queueData.mechanics.length,
      currentPosition: queueData.currentIndex + 1,
      remainingMechanics: queueData.mechanics.length - queueData.currentIndex,
    };
  }
}

// Export singleton
const bookingQueueService = new BookingQueueService();
module.exports = bookingQueueService;
