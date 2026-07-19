const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const redisService = require('./redis.service');

class SocketService {
  constructor() {
    this.io = null;
    // Local cache (for fast lookups on this instance)
    // IMPORTANT: These are NOT authoritative — use room-based emission for multi-server
    this.userSockets = new Map(); // userId -> socketId (local cache only)
    this.mechanicSockets = new Map(); // mechanicId -> socketId (local cache only)
    this.pendingOffline = new Map(); // userId -> timeoutId (for disconnect grace period)
    this.pubClient = null;
    this.subClient = null;
  }

  /**
   * Initialize Socket.io with HTTP server and Redis adapter for horizontal scaling
   */
  async initialize(httpServer) {
    // Build CORS origin handler — Socket.IO v4 rejects literal '*' when
    // credentials:true. A callback that allows every origin achieves the
    // same thing safely, and also handles mobile clients that send no
    // Origin header at all.
    const corsOriginEnv = process.env.CORS_ORIGIN;
    let corsOriginOpt;
    if (!corsOriginEnv || corsOriginEnv === '*') {
      // Allow any origin (development / mobile)
      corsOriginOpt = (origin, cb) => cb(null, true);
    } else {
      const allowed = corsOriginEnv.split(',').map((o) => o.trim()).filter(Boolean);
      corsOriginOpt = (origin, cb) => {
        if (!origin) return cb(null, true); // non-browser (mobile)
        if (allowed.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin ${origin} not allowed`));
      };
    }

    this.io = new Server(httpServer, {
      cors: {
        origin: corsOriginOpt,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      // Allow both transports — mobile clients behind ngrok may fall back
      transports: ['polling', 'websocket'],
      allowUpgrades: true,
      // Engine.IO v3 compat (some older socket_io_client packages)
      allowEIO3: true,
      // Generous timeouts for tunneled / mobile connections
      pingTimeout: 120000,
      pingInterval: 25000,
      // Larger upgrade timeout for slow mobile → tunnel → server path
      upgradeTimeout: 30000,
      // Prevent ngrok from closing idle connections prematurely
      httpCompression: false,
    });

    // Setup Redis adapter for horizontal scaling (multiple server instances)
    await this.setupRedisAdapter();
    
    this.setupMiddleware();
    this.setupEventHandlers();

    console.log('✅ Socket.io initialized');
    return this.io;
  }

  /**
   * Setup Redis adapter for Socket.IO clustering
   */
  async setupRedisAdapter() {
    try {
      if (process.env.REDIS_HOST) {
        const redisConfig = {
          username: process.env.REDIS_USERNAME || 'default',
          password: process.env.REDIS_PASSWORD,
          socket: {
            host: process.env.REDIS_HOST,
            port: parseInt(process.env.REDIS_PORT) || 6379,
          },
        };

        this.pubClient = createClient(redisConfig);
        this.subClient = this.pubClient.duplicate();

        await Promise.all([
          this.pubClient.connect(),
          this.subClient.connect()
        ]);

        this.io.adapter(createAdapter(this.pubClient, this.subClient));
        console.log('✅ Socket.io Redis adapter connected - ready for horizontal scaling');
      } else {
        console.warn('⚠️ Redis not configured - Socket.io running in single-server mode');
      }
    } catch (error) {
      console.error('❌ Failed to setup Redis adapter:', error.message);
      console.warn('⚠️ Continuing without Redis adapter - horizontal scaling disabled');
    }
  }

  /**
   * Setup authentication middleware
   */
  setupMiddleware() {
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        const userType = socket.handshake.auth.userType; // 'USER' or 'MECHANIC'

        if (!token) {
          return next(new Error('Authentication token required'));
        }

        // Verify token (simplified - use your token service in production)
        const tokenService = require('./token.service');
        const result = tokenService.verifyAccessToken(token);

        if (!result.valid) {
          return next(new Error('Invalid authentication token'));
        }

        socket.userId = result.decoded.id;
        socket.userType = userType || result.decoded.role;
        socket.userRole = result.decoded.role;

        next();
      } catch (error) {
        next(new Error('Authentication failed'));
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`📱 ${socket.userType} connected: ${socket.userId}`);

      // Clear any pending offline timeout (user/mechanic reconnected)
      if (this.pendingOffline.has(socket.userId)) {
        clearTimeout(this.pendingOffline.get(socket.userId));
        this.pendingOffline.delete(socket.userId);
        console.log(`🔄 Cleared pending offline for ${socket.userId} (reconnected)`);
      }

      // Store socket mapping (local cache)
      if (socket.userType === 'MECHANIC') {
        this.mechanicSockets.set(socket.userId, socket.id);
        socket.join(`mechanic:${socket.userId}`);
      } else {
        this.userSockets.set(socket.userId, socket.id);
        socket.join(`user:${socket.userId}`);
      }

      // Join user's personal room
      socket.join(socket.userId);

      // Handle mechanic location updates
      socket.on('mechanic:location', async (data) => {
        await this.handleMechanicLocation(socket, data);
      });

      // Handle mechanic online status
      socket.on('mechanic:status', async (data) => {
        await this.handleMechanicStatus(socket, data);
      });

      // Handle booking events
      socket.on('booking:accept', async (data) => {
        await this.handleBookingAccept(socket, data);
      });

      socket.on('booking:reject', async (data) => {
        await this.handleBookingReject(socket, data);
      });

      socket.on('booking:status', async (data) => {
        await this.handleBookingStatusUpdate(socket, data);
      });

      // Handle user tracking request
      socket.on('user:track', async (data) => {
        await this.handleUserTracking(socket, data);
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });

      // Error handling
      socket.on('error', (error) => {
        console.error('Socket error:', error);
      });
    });
  }

  /**
   * Handle mechanic location update
   */
  async handleMechanicLocation(socket, data) {
    const { latitude, longitude, heading, speed } = data;
    const mechanicId = socket.userId;

    try {
      // Store in Redis for geospatial queries
      if (redisService.isConnected) {
        await redisService.updateMechanicLocation(mechanicId, {
          lat: latitude,
          lng: longitude,
          heading,
          speed,
          updatedAt: Date.now(),
        });
      }

      // Update MongoDB — write BOTH GeoJSON location AND legacy lastLocation
      const Mechanic = require('../models/Mechanic');
      await Mechanic.findByIdAndUpdate(mechanicId, {
        // GeoJSON for $nearSphere queries
        'location.type': 'Point',
        'location.coordinates': [longitude, latitude], // GeoJSON: [lng, lat]
        // Legacy flat fields (backward compat)
        'lastLocation.lat': latitude,
        'lastLocation.lng': longitude,
        'lastLocation.updatedAt': new Date(),
        // Heartbeat: refresh last active time
        lastActiveAt: new Date(),
      });

      // Refresh Redis presence TTL without overwriting HTTP `setMechanicOnline` JSON payload.
      if (redisService.isConnected) {
        await redisService.refreshMechanicOnlineTtl(mechanicId, 3600);
      }

      // Broadcast to users tracking this mechanic
      this.io.to(`tracking:${mechanicId}`).emit('mechanic:location', {
        mechanicId,
        latitude,
        longitude,
        heading,
        speed,
        timestamp: Date.now(),
      });

    } catch (error) {
      console.error('Error updating mechanic location:', error);
    }
  }

  /**
   * Handle mechanic online/offline status
   */
  async handleMechanicStatus(socket, data) {
    const { isOnline } = data;
    const mechanicId = socket.userId;

    try {
      const Mechanic = require('../models/Mechanic');
      await Mechanic.findByIdAndUpdate(mechanicId, {
        isOnline,
        lastActiveAt: new Date(),
      });

      // Update Redis
      if (redisService.isConnected) {
        if (isOnline) {
          await redisService.set(`mechanic:online:${mechanicId}`, 'true', 3600);
        } else {
          await redisService.delete(`mechanic:online:${mechanicId}`);
        }
      }

      socket.emit('mechanic:status:ack', { success: true, isOnline });
    } catch (error) {
      console.error('Error updating mechanic status:', error);
      socket.emit('mechanic:status:ack', { success: false, error: error.message });
    }
  }

  /**
   * Handle booking acceptance by mechanic
   */
  async handleBookingAccept(socket, data) {
    const { bookingId } = data;
    const mechanicId = socket.userId;

    try {
      // ═══════ DEBT CHECK — Block acceptance if mechanic has active debt ═══════
      const Mechanic = require('../models/Mechanic');
      const mechanic = await Mechanic.findById(mechanicId).select('hasActiveDebt');
      if (mechanic?.hasActiveDebt) {
        const MechanicDebt = require('../models/MechanicDebt');
        const totalDebt = await MechanicDebt.getTotalActiveDebt(mechanicId);
        if (totalDebt > 0) {
          return socket.emit('booking:accept:ack', {
            success: false,
            error: `Clear ₹${totalDebt} pending dues before accepting new jobs`,
            isDebtBlocked: true,
            debtAmount: totalDebt,
          });
        } else {
          // Debt was settled but flag wasn't cleared — fix it
          await Mechanic.findByIdAndUpdate(mechanicId, { hasActiveDebt: false });
        }
      }
      // ═══════════════════════════════════════════════════════════════════════════

      // Use queue service for round-robin acceptance
      const bookingQueueService = require('./bookingQueue.service');
      const result = await bookingQueueService.handleMechanicAccept(bookingId, mechanicId);

      if (result.success) {
        socket.emit('booking:accept:ack', { success: true, booking: result.booking });
      } else {
        // Fallback to direct accept if queue not found (legacy or direct assignment)
        const Booking = require('../models/Booking');
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
          },
          { new: true }
        );

        if (!booking) {
          return socket.emit('booking:accept:ack', { success: false, error: 'Booking no longer available' });
        }

        // Notify user
        this.emitToUser(booking.userId.toString(), 'booking:accepted', {
          bookingId: booking._id,
          mechanicId,
          message: 'A mechanic has accepted your request!',
        });

        socket.emit('booking:accept:ack', { success: true, booking });
      }
    } catch (error) {
      console.error('Error accepting booking:', error);
      socket.emit('booking:accept:ack', { success: false, error: error.message });
    }
  }

  /**
   * Handle booking rejection by mechanic
   */
  async handleBookingReject(socket, data) {
    const { bookingId, reason } = data;
    const mechanicId = socket.userId;

    try {
      // Use queue service for round-robin rejection - immediately moves to next mechanic
      const bookingQueueService = require('./bookingQueue.service');
      await bookingQueueService.handleMechanicReject(bookingId, mechanicId, reason);

      // Remove mechanic from booking broadcast room
      socket.leave(`booking:${bookingId}`);

      socket.emit('booking:reject:ack', { success: true });
    } catch (error) {
      console.error('Error rejecting booking:', error);
      socket.emit('booking:reject:ack', { success: false, error: error.message });
    }
  }

  /**
   * Handle booking status update
   * SECURITY: only the assigned mechanic of this booking can update its status.
   */
  async handleBookingStatusUpdate(socket, data) {
    const { bookingId, status, notes } = data;

    try {
      // Only mechanics can transition booking status through this socket event.
      if (socket.userType !== 'MECHANIC') {
        return socket.emit('booking:status:ack', { success: false, error: 'Only mechanics can update booking status' });
      }

      const Booking = require('../models/Booking');
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return socket.emit('booking:status:ack', { success: false, error: 'Booking not found' });
      }

      // Authorization: must be the assigned mechanic.
      if (!booking.mechanicId || booking.mechanicId.toString() !== socket.userId) {
        return socket.emit('booking:status:ack', { success: false, error: 'Not authorized for this booking' });
      }

      // Validate status transition
      const validTransitions = {
        'ACCEPTED': ['EN_ROUTE', 'CANCELLED'],
        'EN_ROUTE': ['ARRIVED', 'CANCELLED'],
        'ARRIVED': ['IN_PROGRESS', 'CANCELLED'],
        'IN_PROGRESS': ['COMPLETED', 'CANCELLED'],
      };

      if (!validTransitions[booking.status]?.includes(status)) {
        return socket.emit('booking:status:ack', { 
          success: false, 
          error: `Cannot transition from ${booking.status} to ${status}` 
        });
      }

      booking.status = status;
      if (status === 'EN_ROUTE') booking.enRouteAt = new Date();
      if (status === 'ARRIVED') booking.arrivedAt = new Date();
      if (status === 'IN_PROGRESS') booking.startedAt = new Date();
      if (status === 'COMPLETED') booking.completedAt = new Date();
      if (notes) booking.mechanicNotes = notes;
      await booking.save();

      this.emitToUser(booking.userId.toString(), 'booking:status', {
        bookingId: booking._id,
        status,
        message: this.getStatusMessage(status),
      });

      if (booking.mechanicId) {
        this.emitToUser(booking.mechanicId.toString(), 'booking:status:update', {
          bookingId: booking._id,
          status,
          completedAt: booking.completedAt,
          earnings: booking.earnings,
          message: this.getStatusMessage(status),
        });
      }

      socket.emit('booking:status:ack', { success: true, status });
    } catch (error) {
      console.error('Error updating booking status:', error.message);
      socket.emit('booking:status:ack', { success: false, error: error.message });
    }
  }

  /**
   * Handle user tracking request
   * SECURITY: only allow tracking a mechanic the user currently has an active
   * booking with — prevents stalking / privacy leak via arbitrary mechanicId.
   */
  async handleUserTracking(socket, data) {
    const { mechanicId, action } = data;

    if (!mechanicId) {
      return socket.emit('user:track:ack', { success: false, error: 'mechanicId is required' });
    }

    if (action === 'start') {
      try {
        const Booking = require('../models/Booking');
        const allowed = await Booking.findOne({
          userId: socket.userId,
          mechanicId,
          status: { $in: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
        }).select('_id').lean();

        if (!allowed) {
          return socket.emit('user:track:ack', { success: false, error: 'Not authorized to track this mechanic' });
        }

        socket.join(`tracking:${mechanicId}`);
        socket.emit('user:track:ack', { success: true, tracking: true });
      } catch (error) {
        socket.emit('user:track:ack', { success: false, error: error.message });
      }
    } else {
      socket.leave(`tracking:${mechanicId}`);
      socket.emit('user:track:ack', { success: true, tracking: false });
    }
  }

  /**
   * Handle socket disconnection
   * PRODUCTION: If mechanic disconnects mid-request, auto-skip to next mechanic
   */
  handleDisconnect(socket) {
    console.log(`📴 ${socket.userType} disconnected: ${socket.userId}`);

    if (socket.userType === 'MECHANIC') {
      this.mechanicSockets.delete(socket.userId);
      
      // Mark mechanic as offline after grace period (30s)
      // They might just be switching networks
      const mechanicId = socket.userId;
      
      const timeoutId = setTimeout(async () => {
        try {
          // Remove from pending map
          this.pendingOffline.delete(mechanicId);
          
          // Check if they reconnected (would have new socket in map)
          if (this.mechanicSockets.has(mechanicId)) {
            return; // They reconnected, don't mark offline
          }

          const Mechanic = require('../models/Mechanic');
          
          // Check if mechanic is in an active booking queue
          const bookingQueueService = require('./bookingQueue.service');
          for (const [bookingId, queueData] of bookingQueueService.activeQueues) {
            const currentMechanic = queueData.mechanics[queueData.currentIndex];
            if (currentMechanic?.id === mechanicId) {
              console.log(`⚡ Mechanic ${mechanicId} disconnected during active queue for booking ${bookingId} — auto-skipping`);
              await bookingQueueService.skipToNextMechanic(bookingId, 'mechanic_disconnected');
              break;
            }
          }

          // Mark offline in DB (but don't touch isBusy — they may have an active job)
          const mechanic = await Mechanic.findById(mechanicId).select('isBusy currentBookingId');
          if (mechanic && !mechanic.isBusy && !mechanic.currentBookingId) {
            await Mechanic.findByIdAndUpdate(mechanicId, { isOnline: false });
          }

          // Remove from Redis presence
          if (redisService.isConnected) {
            await redisService.delete(`mechanic:online:${mechanicId}`);
          }
        } catch (error) {
          console.error('Error handling mechanic disconnect:', error.message);
        }
      }, 30000); // 30 second grace period
      
      // Store timeout reference so we can cancel on reconnect
      this.pendingOffline.set(mechanicId, timeoutId);
    } else {
      this.userSockets.delete(socket.userId);
    }
  }

  /**
   * Emit event to specific user
   */
  emitToUser(userId, event, data) {
    this.io.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Emit event to specific mechanic
   */
  emitToMechanic(mechanicId, event, data) {
    this.io.to(`mechanic:${mechanicId}`).emit(event, data);
  }

  /**
   * Live socket presence check. Returns true only if this server currently
   * holds an open socket for the mechanic. This is the SOURCE OF TRUTH for
   * "can we actually reach this mechanic right now?" — far more reliable
   * than the persisted `isOnline` DB flag which can flip-flop or go stale
   * when an app is killed/crashes.
   *
   * Multi-server note: this checks only the local Map. If you scale beyond
   * one node, use Redis presence (`mechanic:online:<id>` key) as fallback.
   */
  isMechanicConnected(mechanicId) {
    if (!mechanicId) return false;
    return this.mechanicSockets.has(String(mechanicId));
  }

  /**
   * Returns true if the mechanic is connected here OR has a Redis presence key.
   *
   * IMPORTANT: `redisService.setMechanicOnline()` stores a JSON object at
   * `mechanic:online:<id>`, while `handleMechanicStatus` may store the string
   * `'true'`. A naive `get() === 'true'` check therefore rejected every HTTP
   * heartbeat-only mechanic and broke matching entirely.
   */
  async isMechanicReachable(mechanicId) {
    if (!mechanicId) return false;
    if (this.isMechanicConnected(mechanicId)) return true;

    // If Redis is down, fail-open: DB + queue dispatch still decide availability.
    if (!redisService.isConnected || !redisService.client) return true;

    try {
      const key = `mechanic:online:${mechanicId}`;
      if (await redisService.exists(key)) return true;
      return false;
    } catch (_) {
      return true;
    }
  }

  /**
   * Broadcast new booking to nearby mechanics
   * PRODUCTION: Uses room-based emission which works across multiple server instances
   */
  async broadcastNewBooking(booking, nearbyMechanics) {
    console.log(`📢 Broadcasting booking to ${nearbyMechanics.length} mechanics`);
    
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
    };

    for (const mechanic of nearbyMechanics) {
      const mechanicId = mechanic._id?.toString() || mechanic.toString();
      
      // Add distance for this mechanic
      const dataWithDistance = {
        ...bookingData,
        distance: mechanic.distance || null,
      };
      
      // ALWAYS use room-based emission — works across multiple server instances
      // The mechanic joins room `mechanic:${mechanicId}` on connect, which is synced via Redis adapter
      this.io.to(`mechanic:${mechanicId}`).emit('booking:new', dataWithDistance);
      console.log(`📤 Sent booking:new to mechanic:${mechanicId} via room`);
    }
  }

  /**
   * Send notification to user/mechanic
   */
  sendNotification(userId, userType, notification) {
    const room = userType === 'MECHANIC' ? `mechanic:${userId}` : `user:${userId}`;
    this.io.to(room).emit('notification', notification);
  }

  /**
   * Notify mechanic of payment received
   * PRODUCTION: Uses room-based emission which works across multiple server instances
   */
  notifyPaymentReceived(mechanicId, data) {
    if (!mechanicId) return;
    
    // Always use room-based emission — works across multiple server instances
    this.io.to(`mechanic:${mechanicId}`).emit('payment:received', data);
    console.log(`💰 Payment notification sent to mechanic ${mechanicId}`);
  }

  /**
   * Get status message for user
   */
  getStatusMessage(status) {
    const messages = {
      'ACCEPTED': 'Your booking has been accepted!',
      'EN_ROUTE': 'Mechanic is on the way to your location',
      'ARRIVED': 'Mechanic has arrived at your location',
      'IN_PROGRESS': 'Work has started on your vehicle',
      'COMPLETED': 'Service completed successfully!',
      'CANCELLED': 'Booking has been cancelled',
    };
    return messages[status] || 'Booking status updated';
  }

  /**
   * Get Socket.io instance
   */
  getIO() {
    return this.io;
  }
}

module.exports = new SocketService();
