const Queue = require('bull');
const { logger } = require('./logger.service');
const { fulfillMechanicPayout } = require('./payoutExecution.service');

/** Default 24 hours */
const DEFAULT_DELAY_MS = 24 * 60 * 60 * 1000;

let payoutQueue = null;

function redisOptions() {
  if (!process.env.REDIS_HOST) return null;
  return {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    username: process.env.REDIS_USERNAME || undefined,
  };
}

/**
 * Initialise Bull worker (requires Redis). Safe to call once on server boot.
 */
function initPayoutQueue() {
  const redis = redisOptions();
  if (!redis) {
    logger.warn(
      '[payout-queue] REDIS_HOST not set — auto payouts use in-process timers only (not durable across restarts).',
    );
    return;
  }

  payoutQueue = new Queue('mechanic-payout-fulfillment', { redis });

  payoutQueue.on('error', (err) => {
    logger.error('[payout-queue] queue error', { error: err.message });
  });

  payoutQueue.process(async (job) => {
    const payoutId = job.data?.payoutId;
    if (!payoutId) return;
    try {
      const result = await fulfillMechanicPayout(payoutId, { source: 'AUTO_QUEUE' });
      if (result.skipped) {
        logger.info(`[payout-queue] job skipped payout=${payoutId} reason=${result.reason}`);
      } else if (result.ok) {
        logger.info(`[payout-queue] fulfilled payout=${payoutId} status=${result.razorpayStatus}`);
      } else {
        logger.warn(`[payout-queue] fulfill failed payout=${payoutId} err=${result.error}`);
      }
    } catch (e) {
      logger.error(`[payout-queue] job crash payout=${payoutId}`, { error: e.message });
    }
  });

  logger.info('✅ Mechanic payout Bull queue initialised');
}

/**
 * Schedule automatic fulfillment after [delayMs] (default 24h).
 * Uses Bull + Redis when available; otherwise setTimeout in-process.
 */
async function schedulePayoutExecution(payoutId, delayMs = DEFAULT_DELAY_MS) {
  const id = String(payoutId);
  const resolved = Number(delayMs) || DEFAULT_DELAY_MS;
  /** Production: at least 60s. Development: allow 1s+ for solo testing (see PAYOUT_AUTO_DELAY_MS). */
  const minDelayMs =
    process.env.NODE_ENV === 'production'
      ? 60_000
      : Math.max(0, parseInt(process.env.PAYOUT_MIN_SCHEDULE_MS, 10) || 0);
  const delay = Math.max(minDelayMs, resolved);

  if (payoutQueue) {
    await payoutQueue.add(
      { payoutId: id },
      {
        delay,
        jobId: `payout-${id}`,
        removeOnComplete: true,
        attempts: 2,
        backoff: { type: 'fixed', delay: 3600_000 },
      },
    );
    logger.info(`[payout-queue] scheduled Bull job payout=${id} delayMs=${delay}`);
    return;
  }

  setTimeout(() => {
    fulfillMechanicPayout(id, { source: 'AUTO_QUEUE' }).catch((e) => {
      logger.error(`[payout-queue] in-process fulfill failed payout=${id}`, { error: e.message });
    });
  }, delay).unref?.();

  logger.info(`[payout-queue] scheduled in-process timer payout=${id} delayMs=${delay}`);
}

async function cancelScheduledPayout(payoutId) {
  const id = String(payoutId);
  if (!payoutQueue) return;
  try {
    const job = await payoutQueue.getJob(`payout-${id}`);
    if (job) {
      await job.remove();
      logger.info(`[payout-queue] removed scheduled job payout=${id}`);
    }
  } catch (e) {
    logger.warn(`[payout-queue] cancel job payout=${id}`, { error: e.message });
  }
}

module.exports = {
  initPayoutQueue,
  schedulePayoutExecution,
  cancelScheduledPayout,
  DEFAULT_DELAY_MS,
};
