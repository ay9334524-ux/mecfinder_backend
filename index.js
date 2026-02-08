const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const http = require('http');
require('dotenv').config();

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

// Import middleware
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');
const { apiLimiter } = require('./middleware/rateLimiter.middleware');

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-id'],
}));

// Compression
app.use(compression());

// Request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

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
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    redis: redisService.isConnected ? 'connected' : 'disconnected',
  });
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

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// Create HTTP server for Socket.io
const server = http.createServer(app);

// Start server
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mecfinder';

const startServer = async () => {
  try {
    // Connect to MongoDB with production-ready settings
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 50,          // Maximum connections in pool
      minPoolSize: 10,          // Minimum connections to maintain
      serverSelectionTimeoutMS: 5000, // Timeout for server selection
      socketTimeoutMS: 45000,   // Close sockets after 45 seconds of inactivity
      family: 4,                // Use IPv4
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

    // Start HTTP server - listen on 0.0.0.0 to allow connections from other devices
    const HOST = '0.0.0.0';
    server.listen(PORT, HOST, () => {
      logger.info(`🚀 Server is running on http://${HOST}:${PORT}`);
      logger.info(`📚 API Documentation: http://localhost:${PORT}/api`);
      logger.info(`🔌 WebSocket ready on ws://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error('❌ Failed to start server:', { error: error.message, stack: error.stack });
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  await redisService.disconnect();
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  await redisService.disconnect();
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
