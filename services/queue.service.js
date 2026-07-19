/**
 * Job Queue Service using Bull
 * Handles background tasks like notifications, emails, and heavy processing
 */
const Queue = require('bull');

// Redis configuration for Bull
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
  username: process.env.REDIS_USERNAME || 'default',
};

// Only create queues if Redis is configured
const createQueue = (name) => {
  if (!process.env.REDIS_HOST) {
    console.warn(`⚠️ Queue "${name}" running in mock mode - Redis not configured`);
    return null;
  }
  
  const queue = new Queue(name, { redis: redisConfig });
  
  queue.on('error', (error) => {
    console.error(`Queue ${name} error:`, error);
  });
  
  queue.on('failed', (job, err) => {
    console.error(`Job ${job.id} in ${name} failed:`, err.message);
  });
  
  return queue;
};

// Create queues for different job types
const notificationQueue = createQueue('notifications');
const emailQueue = createQueue('emails');
const paymentQueue = createQueue('payments');
const bookingQueue = createQueue('bookings');

/**
 * Queue a notification to be sent
 */
const queueNotification = async (data) => {
  if (!notificationQueue) {
    // Fallback: execute immediately if queue not available
    console.log('📱 Sending notification (sync):', data.title);
    return { id: 'sync-' + Date.now() };
  }
  
  const job = await notificationQueue.add(data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 50,      // Keep last 50 failed jobs
  });
  
  return { id: job.id };
};

/**
 * Queue an email to be sent
 */
const queueEmail = async (data) => {
  if (!emailQueue) {
    console.log('📧 Sending email (sync):', data.to);
    return { id: 'sync-' + Date.now() };
  }
  
  const job = await emailQueue.add(data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 3000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  
  return { id: job.id };
};

/**
 * Queue a payment processing job
 */
const queuePaymentProcess = async (data) => {
  if (!paymentQueue) {
    console.log('💰 Processing payment (sync):', data.bookingId);
    return { id: 'sync-' + Date.now() };
  }
  
  const job = await paymentQueue.add(data, {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 200,
    removeOnFail: 100,
  });
  
  return { id: job.id };
};

/**
 * Queue a booking broadcast to nearby mechanics
 */
const queueBookingBroadcast = async (data) => {
  if (!bookingQueue) {
    console.log('📍 Broadcasting booking (sync):', data.bookingId);
    return { id: 'sync-' + Date.now() };
  }
  
  const job = await bookingQueue.add('broadcast', data, {
    attempts: 3,
    backoff: {
      type: 'fixed',
      delay: 1000,
    },
    removeOnComplete: 50,
  });
  
  return { id: job.id };
};

/**
 * Process notification jobs
 */
const processNotifications = (processor) => {
  if (!notificationQueue) return;
  
  notificationQueue.process(async (job) => {
    console.log(`📱 Processing notification job ${job.id}`);
    await processor(job.data);
  });
};

/**
 * Process email jobs
 */
const processEmails = (processor) => {
  if (!emailQueue) return;
  
  emailQueue.process(async (job) => {
    console.log(`📧 Processing email job ${job.id}`);
    await processor(job.data);
  });
};

/**
 * Process payment jobs
 */
const processPayments = (processor) => {
  if (!paymentQueue) return;
  
  paymentQueue.process(async (job) => {
    console.log(`💰 Processing payment job ${job.id}`);
    await processor(job.data);
  });
};

/**
 * Process booking jobs
 */
const processBookings = (processor) => {
  if (!bookingQueue) return;
  
  bookingQueue.process('broadcast', async (job) => {
    console.log(`📍 Processing booking broadcast job ${job.id}`);
    await processor(job.data);
  });
};

/**
 * Get queue health stats
 */
const getQueueStats = async () => {
  const stats = {};
  
  const queues = [
    { name: 'notifications', queue: notificationQueue },
    { name: 'emails', queue: emailQueue },
    { name: 'payments', queue: paymentQueue },
    { name: 'bookings', queue: bookingQueue },
  ];
  
  for (const { name, queue } of queues) {
    if (queue) {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
      ]);
      
      stats[name] = { waiting, active, completed, failed };
    } else {
      stats[name] = { status: 'disabled' };
    }
  }
  
  return stats;
};

/**
 * Graceful shutdown
 */
const closeQueues = async () => {
  const queues = [notificationQueue, emailQueue, paymentQueue, bookingQueue];
  await Promise.all(
    queues.filter(q => q).map(q => q.close())
  );
  console.log('✅ All queues closed');
};

module.exports = {
  queueNotification,
  queueEmail,
  queuePaymentProcess,
  queueBookingBroadcast,
  processNotifications,
  processEmails,
  processPayments,
  processBookings,
  getQueueStats,
  closeQueues,
};
