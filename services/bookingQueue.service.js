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
const mongoose = require('mongoose');

class BookingQueueService {
  constructor() {
    this.activeQueues = new Map(); // In-memory cache, Redis is source of truth
    this.TIMEOUT_SECONDS = 25;           // Per-mechanic offer window — FCM can take 10-15s
    this.MAX_TOTAL_TIMEOUT_SECONDS = 180; // Max total search duration (3 minutes)

    // NOTE: pending-offer coordination is done via Redis (`pending:offer:<mechanicId>`)
    // rather than an in-memory Map, so multi-worker (PM2 cluster) deployments
    // do not double-offer to the same mechanic.
  }

  // Redis key for the lock that prevents two queues from offering the same
  // mechanic at once. TTL matches per-mechanic offer window + small slack.
  _pendingOfferKey(mechanicId) {
    return `pending:offer:${mechanicId}`;
  }

  /**
   * Reserve a mechanic for this booking's pending offer. Returns false if
   * another booking already holds the lock.
   *
   * Falls back to "allow" if Redis is unavailable so a Redis outage doesn't
   * block all dispatches; the per-booking MongoDB findOneAndUpdate guard
   * still prevents a single mechanic from being assigned to two bookings.
   */
  async _reservePendingOffer(mechanicId, bookingId) {
    try {
      if (!redisService.client || !redisService.isConnected) return true;
      const ttl = this.TIMEOUT_SECONDS + 5;
      const result = await redisService.client.set(
        this._pendingOfferKey(mechanicId),
        bookingId,
        { NX: true, EX: ttl },
      );
      return result === 'OK';
    } catch (err) {
      console.warn(`⚠️ pending-offer reserve failed for ${mechanicId}: ${err.message}`);
      return true; // fail-open
    }
  }

  /** Release the pending-offer lock for this booking. */
  async _releasePendingOffer(mechanicId, bookingId) {
    try {
      if (!redisService.client || !redisService.isConnected) return;
      // Lua: only release if WE own the lock.
      const lua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redisService.client.eval(lua, {
        keys: [this._pendingOfferKey(mechanicId)],
        arguments: [bookingId],
      });
    } catch (err) {
      console.warn(`⚠️ pending-offer release failed for ${mechanicId}: ${err.message}`);
    }
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

    // Fresh availability check before sending:
    //  • Hard blockers (skip): busy / already on another booking / concurrent offer
    //  • Reachability (live socket OR fresh Redis presence) — if the mechanic
    //    is unreachable AND has no FCM token, skip. If they have an FCM
    //    token but no socket we still try (app may be backgrounded and FCM
    //    push can wake the device).
    //
    // Note: we deliberately DO NOT skip purely on `isOnline=false`. That
    // flag is set with a 30s grace on disconnect and can lag a reconnect,
    // which previously caused valid mechanics (like Ramesh) to be
    // false-skipped right after a brief network blip.
    try {
      const freshMechanic = await Mechanic.findById(currentMechanic.id)
        .select('isOnline isBusy currentBookingId fcmToken').lean();

      if (!freshMechanic) {
        console.log(`⏭️ Mechanic ${currentMechanic.name} skipped (not found)`);
        queueData.currentIndex++;
        this.activeQueues.set(bookingId, queueData);
        await this.saveQueueToRedis(bookingId, queueData);
        return this.sendToNextMechanic(bookingId);
      }

      const isBusy = !!(freshMechanic.isBusy || freshMechanic.currentBookingId);
      const isReachable = await socketService.isMechanicReachable(currentMechanic.id);
      const hasFcm = !!freshMechanic.fcmToken;

      let skipReason = null;
      if (isBusy) skipReason = 'busy on another booking';
      else if (!isReachable && !hasFcm) skipReason = 'unreachable (no socket, no FCM)';

      if (skipReason) {
        console.log(`⏭️ Mechanic ${currentMechanic.name} skipped (${skipReason})`);
        queueData.currentIndex++;
        this.activeQueues.set(bookingId, queueData);
        await this.saveQueueToRedis(bookingId, queueData);
        return this.sendToNextMechanic(bookingId);
      }

      // Refresh the cached FCM token in case it changed since scoring.
      currentMechanic.fcmToken = freshMechanic.fcmToken || currentMechanic.fcmToken;
    } catch (err) {
      console.warn(`⚠️ Availability check failed: ${err.message}`);
    }

    // Atomically reserve this mechanic for our offer (Redis SET NX). If
    // another worker / booking already holds the lock, skip — they get the
    // first shot, we move to the next candidate.
    const reserved = await this._reservePendingOffer(currentMechanic.id, bookingId);
    if (!reserved) {
      console.log(`⏭️ Mechanic ${currentMechanic.name} skipped (concurrent offer in flight)`);
      queueData.currentIndex++;
      this.activeQueues.set(bookingId, queueData);
      await this.saveQueueToRedis(bookingId, queueData);
      return this.sendToNextMechanic(bookingId);
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

    // FCM push backup — sendPushNotification(token, {title, body}, data)
    if (currentMechanic.fcmToken) {
      try {
        const firebaseService = require('./firebase.service');
        await firebaseService.sendPushNotification(
          currentMechanic.fcmToken,
          {
            title: '🔔 New Job Request!',
            body: `${bookingData.serviceName} - ₹${bookingData.price || bookingData.estimatedPrice} (${currentMechanic.distance?.toFixed(1)}km away)`,
          },
          { type: 'NEW_BOOKING', bookingId, timeout: String(this.TIMEOUT_SECONDS) },
        );
      } catch (fcmError) {
        if (fcmError.code === 'INVALID_FCM_TOKEN') {
          // Clear the dead token so this mechanic stops being scored
          // as "reachable via FCM" on future bookings.
          console.warn(`🧹 Clearing invalid FCM token for mechanic ${currentMechanic.id}`);
          Mechanic.findByIdAndUpdate(currentMechanic.id, { $unset: { fcmToken: 1 } })
            .catch((e) => console.warn('FCM cleanup failed:', e.message));
          currentMechanic.fcmToken = null;
        } else {
          console.warn(`⚠️ FCM failed for ${currentMechanic.id}:`, fcmError.message);
        }
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

    // Track rejection in acceptance rate stats (only for explicit reject, not timeout)
    if (reason === 'rejected') {
      await Mechanic.findByIdAndUpdate(mechanicId, {
        $inc: { totalOffersReceived: 1 },
      }).catch(() => {});
    }
    
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
      // Release the pending-offer lock so other bookings can now offer to this mechanic
      await this._releasePendingOffer(currentMechanic.id, bookingId);

      // Persist this mechanic in the booking's exclusion list so any re-search
      // (e.g. mechanic cancels later, or stale client retry) doesn't re-offer
      // the same job to someone who already declined / timed out on it.
      try {
        await Booking.findByIdAndUpdate(bookingId, {
          $addToSet: { excludedMechanicIds: currentMechanic.id },
        });
      } catch (err) {
        console.warn(`⚠️ Failed to record exclusion for ${currentMechanic.id}: ${err.message}`);
      }

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

      // Release the concurrent-offer lock immediately on accept
      await this._releasePendingOffer(mechanicId, bookingId);

      // ─────────────────────────────────────────────────────────────────
      // Atomic two-document write: booking assignment + mechanic busy flag.
      //
      // Wrap in a Mongo transaction so that if EITHER write fails, neither
      // is persisted. Without this the previous flow could leave the
      // booking ASSIGNED but the mechanic still `isBusy=false`, allowing
      // them to receive a second offer.
      //
      // Replica-set / Atlas only — falls back to sequential writes on
      // single-node Mongo (where transactions are unsupported).
      // ─────────────────────────────────────────────────────────────────
      let booking = null;
      let usedTransaction = false;
      let session = null;

      try {
        session = await mongoose.startSession();
      } catch (sessionErr) {
        // startSession can throw on standalone mongod — fall through to
        // sequential mode below.
        console.warn(`⚠️ Mongo session unavailable, falling back to sequential accept: ${sessionErr.message}`);
        session = null;
      }

      if (session) {
        try {
          await session.withTransaction(async () => {
            booking = await Booking.findOneAndUpdate(
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
              { new: true, session },
            );

            if (!booking) {
              // Aborts the transaction by throwing — caller catches below.
              const err = new Error('BOOKING_UNAVAILABLE');
              err.code = 'BOOKING_UNAVAILABLE';
              throw err;
            }

            await Mechanic.findByIdAndUpdate(
              mechanicId,
              {
                $set: {
                  isBusy: true,
                  currentBookingId: booking._id,
                  lastActiveAt: new Date(),
                },
                $inc: {
                  totalOffersReceived: 1,
                  totalOffersAccepted: 1,
                },
              },
              { session },
            );
          });
          usedTransaction = true;
        } catch (txErr) {
          if (txErr.code === 'BOOKING_UNAVAILABLE') {
            return { success: false, error: 'Booking no longer available' };
          }
          // Transaction unsupported (e.g., standalone mongod) — fall back
          // to sequential writes outside the session.
          if (txErr.codeName === 'IllegalOperation' ||
              /Transaction numbers are only allowed/i.test(txErr.message || '')) {
            console.warn('⚠️ Mongo transactions unsupported; using sequential accept.');
            session.endSession();
            session = null;
          } else {
            session.endSession();
            throw txErr;
          }
        } finally {
          if (session && usedTransaction) session.endSession();
        }
      }

      if (!usedTransaction) {
        // Sequential fallback. We still attempt a best-effort rollback if
        // the mechanic update fails after the booking was updated.
        booking = await Booking.findOneAndUpdate(
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
          { new: true },
        );

        if (!booking) {
          return { success: false, error: 'Booking no longer available' };
        }

        try {
          await Mechanic.findByIdAndUpdate(mechanicId, {
            $set: {
              isBusy: true,
              currentBookingId: booking._id,
              lastActiveAt: new Date(),
            },
            $inc: {
              totalOffersReceived: 1,
              totalOffersAccepted: 1,
            },
          });
        } catch (mechErr) {
          // Best-effort rollback so a stuck booking doesn't sit with a
          // mechanic who never got marked busy.
          console.error(`❌ Mechanic update failed after booking accept; rolling back booking ${bookingId}: ${mechErr.message}`);
          await Booking.findByIdAndUpdate(bookingId, {
            $set: { status: 'SEARCHING', mechanicId: null, acceptedAt: null },
            $push: {
              statusHistory: {
                status: 'SEARCHING',
                timestamp: new Date(),
                note: 'Auto-rollback: mechanic state update failed',
              },
            },
          }).catch((rbErr) => console.error(`❌ Booking rollback also failed: ${rbErr.message}`));
          return { success: false, error: 'Could not assign mechanic, please try again' };
        }
      }

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

    // Release all pending-offer locks held by this booking
    if (queueData?.mechanics) {
      for (const m of queueData.mechanics) {
        await this._releasePendingOffer(m.id, bookingId);
      }
    }

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
