const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const http = require('http');
require('dotenv').config();

const validatePaymentEnv = () => {
  const requiredVars = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
  const missing = requiredVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required payment env vars: ${missing.join(', ')}`);
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const looksLikeUrl = webhookSecret && /^https?:\/\//i.test(webhookSecret);

  if (!webhookSecret || webhookSecret === 'your_webhook_secret_here') {
    if (process.env.NODE_ENV === 'production') {
      // Webhook signature verification is the only thing standing between us
      // and a forged "payment success" webhook. In production, no secret =
      // hard fail — never silently accept unverifiable webhooks.
      throw new Error(
        'RAZORPAY_WEBHOOK_SECRET is required in production. Configure it in your environment from the Razorpay dashboard webhook secret.'
      );
    }
    logger.warn('⚠️ RAZORPAY_WEBHOOK_SECRET not configured. Webhook verification disabled - webhooks will not work.');
  } else if (looksLikeUrl) {
    logger.error('❌ RAZORPAY_WEBHOOK_SECRET appears to be a URL. Set the webhook secret string from Razorpay dashboard, not the webhook URL.');
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Invalid RAZORPAY_WEBHOOK_SECRET for production');
    }
  } else {
    logger.info('✅ RAZORPAY_WEBHOOK_SECRET configured - webhooks enabled');
  }
};

// Import services
const redisService = require('./services/redis.service');
const socketService = require('./services/socket.service');
const { logger } = require('./services/logger.service');

// Import routes
const adminRoutes = require('./routes/adminRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const regionRoutes = require('./routes/regionRoutes');
const pricingRoutes = require('./routes/pricingRoutes');
const supportRoutes = require('./routes/supportRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const walletRoutes = require('./routes/walletRoutes');
const referralRoutes = require('./routes/referralRoutes');
const rewardsRoutes = require('./routes/rewardsRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const helpRoutes = require('./routes/helpRoutes');
const mechanicRoutes = require('./routes/mechanicRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const couponRoutes = require('./routes/couponRoutes');
const complaintRoutes = require('./routes/complaintRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const publicRoutes = require('./routes/publicRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

// Import middleware
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');
const { apiLimiter } = require('./middleware/rateLimiter.middleware');

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration — production must specify an explicit allow-list.
const corsOriginEnv = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === 'production' && (!corsOriginEnv || corsOriginEnv === '*')) {
  throw new Error('CORS_ORIGIN must be set to a comma-separated allow-list in production (wildcard is not allowed)');
}
const corsAllowedOrigins = corsOriginEnv && corsOriginEnv !== '*'
  ? corsOriginEnv.split(',').map((o) => o.trim()).filter(Boolean)
  : null; // null => allow any origin (dev only)

app.use(cors({
  origin: function (origin, cb) {
    // Allow non-browser clients (no Origin header) like mobile apps & curl.
    if (!origin) return cb(null, true);
    if (!corsAllowedOrigins) return cb(null, true);
    if (corsAllowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-id'],
  credentials: true,
}));

// Compression
app.use(compression());

// Request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Webhook routes (raw body required for signature verification)
app.use('/api/webhooks', webhookRoutes);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting (apply to all API routes)
app.use('/api', apiLimiter);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'MecFinder API Server',
    version: '1.2.0',
    timestamp: new Date().toISOString(),
  });
});

// Deep health check — verifies connectivity. Error details are LOGGED, never
// exposed in the response body to prevent information disclosure.
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: 'down',
    redis: 'down',
  };

  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      health.mongodb = 'ok';
    }
  } catch (mongoError) {
    logger.error('Health check Mongo ping failed', { error: mongoError.message });
    health.status = 'degraded';
  }

  try {
    if (redisService.isConnected && redisService.client) {
      const pong = await redisService.client.ping();
      health.redis = pong === 'PONG' ? 'ok' : 'down';
    }
  } catch (redisError) {
    logger.error('Health check Redis ping failed', { error: redisError.message });
    health.status = 'degraded';
  }

  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

// API Routes
app.use('/api/admin', adminRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/auth', authRoutes);

// New routes
app.use('/api/user', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/mechanic', mechanicRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/public', publicRoutes);

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// Create HTTP server for Socket.io
const server = http.createServer(app);

// Inactivity timeout on the HTTP socket. A non-zero value can drop Engine.IO
// long-polling / WebSocket upgrades behind ngrok or slow mobile networks.
// Express still applies its own limits per route where needed.
server.timeout = 0;

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MONGO_URI = process.env.MONGO_URI;

const startServer = async () => {
  try {
    if (!MONGO_URI) {
      throw new Error('MONGO_URI is not set. Configure it in your .env (see .env.example).');
    }
    validatePaymentEnv();

    // Connect to MongoDB with production-ready settings
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 50,
      minPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    logger.info('✅ Connected to MongoDB');

    // Connect to Redis
    try {
      await redisService.connect();
      logger.info('✅ Connected to Redis');
    } catch (redisError) {
      logger.warn('⚠️ Redis connection failed, continuing without Redis:', { error: redisError.message });
    }

    // Initialize Socket.io with Redis adapter
    await socketService.initialize(server);
    logger.info('✅ Socket.io initialized');

    // Restore active booking queues from Redis (survives server restart)
    try {
      const bookingQueueService = require('./services/bookingQueue.service');
      await bookingQueueService.restoreQueues();
      logger.info('✅ Booking queues restored from Redis');
    } catch (queueError) {
      logger.warn('⚠️ Failed to restore booking queues:', { error: queueError.message });
    }

    try {
      const { initPayoutQueue } = require('./services/payoutQueue.service');
      initPayoutQueue();
    } catch (payoutQErr) {
      logger.warn('⚠️ Payout queue init failed:', { error: payoutQErr.message });
    }

    server.listen(PORT, HOST, () => {
      logger.info(`🚀 Server is running on http://${HOST}:${PORT}`);
      logger.info(`📚 API Documentation: http://localhost:${PORT}/api`);
      logger.info(`🔌 WebSocket ready on ws://localhost:${PORT}`);

      // Signal PM2 that the app is ready (for zero-downtime reloads)
      if (process.send) {
        process.send('ready');
      }
    });
  } catch (error) {
    logger.error('❌ Failed to start server:', { error: error.message, stack: error.stack });
    process.exit(1);
  }
};

/**
 * Graceful shutdown handler — PRODUCTION GRADE
 * Ensures all connections are properly closed before exit
 */
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  
  // Stop accepting new connections
  server.close(async (err) => {
    if (err) {
      logger.error('Error closing HTTP server:', { error: err.message });
    }
    
    try {
      // 1. Clean up active booking queues (clear timers)
      const bookingQueueService = require('./services/bookingQueue.service');
      for (const [bookingId] of bookingQueueService.activeQueues) {
        await bookingQueueService.cleanupQueue(bookingId);
      }
      logger.info('✅ Booking queues cleaned up');
      
      // 2. Close Socket.io connections
      if (socketService.io) {
        socketService.io.close();
        logger.info('✅ Socket.io closed');
      }
      
      // 3. Disconnect Redis
      await redisService.disconnect();
      logger.info('✅ Redis disconnected');
      
      // 4. Close MongoDB connection
      await mongoose.connection.close();
      logger.info('✅ MongoDB disconnected');
      
      logger.info('🛑 Server shut down complete');
      process.exit(0);
    } catch (shutdownError) {
      logger.error('Error during shutdown:', { error: shutdownError.message });
      process.exit(1);
    }
  });
  
  // Force exit after 30 seconds if graceful shutdown fails
  setTimeout(() => {
    logger.error('⚠️ Forced shutdown after 30s timeout');
    process.exit(1);
  }, 30000).unref();
};

// Graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', { reason: reason?.message || reason, promise });
});

startServer();
