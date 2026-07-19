/**
 * Pagination utilities — keep all list endpoints inside safe bounds.
 *
 * Several controllers built `.limit(parseInt(req.query.limit))` without
 * clamping, so a client sending `?limit=100000` would force the server to
 * stream a hundred-thousand-row response — a free DoS. Use `clampLimit` /
 * `parsePagination` everywhere we accept a user-supplied page size.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Coerce an arbitrary limit input (string, number, undefined) to a safe
 * positive integer in [1, max].
 */
function clampLimit(value, { def = DEFAULT_LIMIT, max = MAX_LIMIT } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/**
 * Coerce a page input to a positive integer (>= 1).
 */
function clampPage(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * Parse `req.query` into `{ page, limit, skip }` ready for Mongo paging.
 */
function parsePagination(query = {}, opts = {}) {
  const page = clampPage(query.page);
  const limit = clampLimit(query.limit, opts);
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampLimit,
  clampPage,
  parsePagination,
};
