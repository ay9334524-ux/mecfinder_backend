'use strict';

/**
 * Minimum mechanic wallet withdrawal / payout (INR).
 * Set MIN_PAYOUT_INR=5 in .env for local testing; omit or use 200 in production.
 */
function getMinPayoutInr() {
  const raw = process.env.MIN_PAYOUT_INR;
  if (raw === undefined || raw === '') return 200;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 200;
  return Math.min(1_000_000, Math.floor(n));
}

module.exports = { getMinPayoutInr };
