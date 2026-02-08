const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const redisService = require('./redis.service');

class SocketService {
  constructor() {
    this.io = null;
    this.userSockets = new Map(); // userId -> socketId (local cache)
    this.mechanicSockets = new Map(); // mechanicId -> socketId (local cache)
    this.pubClient = null;
    this.subClient = null;
  }

  /**
   * Initialize Socket.io with HTTP server and Redis adapter for horizontal scaling
   */
  async initialize(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
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

      // Store socket mapping
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

      // Update MongoDB
      const Mechanic = require('../models/Mechanic');
      await Mechanic.findByIdAndUpdate(mechanicId, {
        'lastLocation.lat': latitude,
        'lastLocation.lng': longitude,
        'lastLocation.updatedAt': new Date(),
      });

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
   */
  async handleBookingStatusUpdate(socket, data) {
    const { bookingId, status, notes } = data;

    try {
      const Booking = require('../models/Booking');
      const booking = await Booking.findById(bookingId);

      if (!booking) {
        return socket.emit('booking:status:ack', { success: false, error: 'Booking not found' });
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

      // Update booking
      booking.status = status;
      if (status === 'EN_ROUTE') booking.enRouteAt = new Date();
      if (status === 'ARRIVED') booking.arrivedAt = new Date();
      if (status === 'IN_PROGRESS') booking.startedAt = new Date();
      if (status === 'COMPLETED') booking.completedAt = new Date();
      if (notes) booking.mechanicNotes = notes;
      await booking.save();

      // Notify user
      this.emitToUser(booking.userId.toString(), 'booking:status', {
        bookingId: booking._id,
        status,
        message: this.getStatusMessage(status),
      });

      socket.emit('booking:status:ack', { success: true, status });
    } catch (error) {
      console.error('Error updating booking status:', error);
      socket.emit('booking:status:ack', { success: false, error: error.message });
    }
  }

  /**
   * Handle user tracking request
   */
  async handleUserTracking(socket, data) {
    const { mechanicId, action } = data;

    if (action === 'start') {
      socket.join(`tracking:${mechanicId}`);
      socket.emit('user:track:ack', { success: true, tracking: true });
    } else {
      socket.leave(`tracking:${mechanicId}`);
      socket.emit('user:track:ack', { success: true, tracking: false });
    }
  }

  /**
   * Handle socket disconnection
   */
  handleDisconnect(socket) {
    console.log(`📴 ${socket.userType} disconnected: ${socket.userId}`);

    if (socket.userType === 'MECHANIC') {
      this.mechanicSockets.delete(socket.userId);
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
   * Broadcast new booking to nearby mechanics
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
      const socketId = this.mechanicSockets.get(mechanicId);
      
      // Add distance for this mechanic
      const dataWithDistance = {
        ...bookingData,
        distance: mechanic.distance || null,
      };
      
      console.log(`📤 Sending to mechanic ${mechanicId}, socketId: ${socketId}`);
      
      if (socketId) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
          socket.join(`booking:${booking._id}`);
          socket.emit('booking:new', dataWithDistance);
          console.log(`✅ Sent booking:new to mechanic ${mechanicId}`);
        } else {
          console.log(`❌ Socket not found for mechanic ${mechanicId}`);
        }
      } else {
        // Try room-based emission
        this.io.to(`mechanic:${mechanicId}`).emit('booking:new', dataWithDistance);
        console.log(`📤 Sent via room to mechanic:${mechanicId}`);
      }
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
   */
  notifyPaymentReceived(mechanicId, data) {
    if (!mechanicId) return;
    
    const socketId = this.mechanicSockets.get(mechanicId);
    if (socketId) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('payment:received', data);
        console.log(`💰 Payment notification sent to mechanic ${mechanicId}`);
      }
    }
    // Also try room-based emission
    this.io.to(`mechanic:${mechanicId}`).emit('payment:received', data);
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
