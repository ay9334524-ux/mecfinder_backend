/**
 * Winston Logger Service
 * Structured logging for production environments
 */
const winston = require('winston');
const path = require('path');

// Log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Colors for console output
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// Determine log level based on environment
const level = () => {
  const env = process.env.NODE_ENV || 'development';
  return env === 'development' ? 'debug' : 'info';
};

// Custom format for structured logging
const structuredFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
    return `${timestamp} ${level}: ${message} ${metaStr}`;
  })
);

// Create transports based on environment
const transports = [];

// Console transport (always enabled)
transports.push(
  new winston.transports.Console({
    format: process.env.NODE_ENV === 'production' ? structuredFormat : consoleFormat,
  })
);

// File transports for production
if (process.env.NODE_ENV === 'production' || process.env.LOG_TO_FILE === 'true') {
  const logDir = process.env.LOG_DIR || 'logs';
  
  // Error log
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: structuredFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );
  
  // Combined log
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      format: structuredFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 10,
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: level(),
  levels,
  transports,
  exitOnError: false,
});

// HTTP request logging middleware for Express
const httpLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const message = `${req.method} ${req.originalUrl}`;
    
    const logData = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      userId: req.user?.id || req.mechanic?.id || req.admin?.id,
    };
    
    if (res.statusCode >= 500) {
      logger.error(message, logData);
    } else if (res.statusCode >= 400) {
      logger.warn(message, logData);
    } else {
      logger.http(message, logData);
    }
  });
  
  next();
};

// Request ID middleware for tracing
let requestCounter = 0;
const requestIdMiddleware = (req, res, next) => {
  req.requestId = req.headers['x-request-id'] || `req-${Date.now()}-${++requestCounter}`;
  res.setHeader('X-Request-ID', req.requestId);
  next();
};

// Child logger with request context
const createRequestLogger = (req) => {
  return logger.child({
    requestId: req.requestId,
    userId: req.user?.id || req.mechanic?.id,
    path: req.originalUrl,
  });
};

// Utility functions
const logError = (error, context = {}) => {
  logger.error(error.message, {
    ...context,
    stack: error.stack,
    name: error.name,
  });
};

const logApiCall = (service, action, data = {}) => {
  logger.info(`API: ${service}.${action}`, data);
};

const logSocketEvent = (event, data = {}) => {
  logger.debug(`Socket: ${event}`, data);
};

const logDatabaseQuery = (collection, operation, duration) => {
  logger.debug(`DB: ${collection}.${operation}`, { duration: `${duration}ms` });
};

module.exports = {
  logger,
  httpLogger,
  requestIdMiddleware,
  createRequestLogger,
  logError,
  logApiCall,
  logSocketEvent,
  logDatabaseQuery,
};
