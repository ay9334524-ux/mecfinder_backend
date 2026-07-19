const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * JWT payloads must carry a plain string id. jsonwebtoken + BSON ObjectId
 * can otherwise round-trip as `{ $oid: '...' }` or a Buffer-like object,
 * which breaks `Mechanic.findById` / `new mongoose.Types.ObjectId(id)` and
 * triggers "Class constructor ObjectId cannot be invoked without 'new'".
 */
function normalizeUserId(userId) {
  if (userId == null || userId === '') return userId;
  if (typeof userId === 'string') return userId;
  if (typeof userId === 'number') return String(userId);
  if (typeof userId === 'object') {
    if (typeof userId.$oid === 'string') return userId.$oid;
    if (typeof userId.toHexString === 'function') return userId.toHexString();
    if (userId._id != null) return normalizeUserId(userId._id);
  }
  return String(userId);
}

function normalizeDecodedUser(decoded) {
  if (!decoded || decoded.id == null) return decoded;
  return { ...decoded, id: normalizeUserId(decoded.id) };
}

// ════════════════════════════════════════════════════════════════════════
// JWT secrets — with graceful rotation.
//
// All NEW tokens are signed with `JWT_SECRET` / `JWT_REFRESH_SECRET`.
// Verification ALSO accepts `JWT_SECRET_PREVIOUS` / `JWT_REFRESH_SECRET_PREVIOUS`
// if set, so a rotated secret doesn't force every active session to sign in
// again. Rotation flow:
//   1. Set `*_PREVIOUS = <current secret>`, set `*_SECRET = <new secret>`, deploy.
//   2. Wait at least the longest token lifetime (30d for refresh tokens).
//   3. Remove `*_PREVIOUS` and redeploy. Old tokens are now permanently invalid.
//
// In production both primary secrets are required; the previous secrets are
// optional and only used during a rotation window.
// ════════════════════════════════════════════════════════════════════════
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS;
const JWT_REFRESH_SECRET_PREVIOUS = process.env.JWT_REFRESH_SECRET_PREVIOUS;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be set in production');
    process.exit(1);
  } else {
    console.warn('⚠️ WARNING: Using default JWT secrets - DO NOT use in production!');
  }
}

if (JWT_SECRET_PREVIOUS && JWT_SECRET_PREVIOUS === JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET_PREVIOUS equals JWT_SECRET — rotation has no effect. Unset _PREVIOUS once the rotation window has elapsed.');
}
if (JWT_REFRESH_SECRET_PREVIOUS && JWT_REFRESH_SECRET_PREVIOUS === JWT_REFRESH_SECRET) {
  console.warn('⚠️ JWT_REFRESH_SECRET_PREVIOUS equals JWT_REFRESH_SECRET — rotation has no effect.');
}

const getJwtSecret = () => JWT_SECRET || 'dev_jwt_secret_DO_NOT_USE_IN_PRODUCTION';
const getJwtRefreshSecret = () => JWT_REFRESH_SECRET || 'dev_refresh_secret_DO_NOT_USE_IN_PRODUCTION';

// Verification keys, in order: current first (most tokens), then previous.
const accessVerifyKeys = () => [getJwtSecret(), JWT_SECRET_PREVIOUS].filter(Boolean);
const refreshVerifyKeys = () => [getJwtRefreshSecret(), JWT_REFRESH_SECRET_PREVIOUS].filter(Boolean);

/**
 * Try each key in turn. Returns the decoded payload on first success,
 * or throws the error from the LAST attempt (typically "invalid signature"
 * which is the most useful caller-facing message).
 */
function verifyWithRotation(token, keys, options = {}) {
  let lastError;
  for (const key of keys) {
    try {
      return jwt.verify(token, key, options);
    } catch (err) {
      lastError = err;
      // Only retry on signature mismatch — expiry / malformed should fail fast.
      if (err.name !== 'JsonWebTokenError' || err.message !== 'invalid signature') {
        throw err;
      }
    }
  }
  throw lastError || new Error('No JWT keys configured');
}

const ACCESS_TOKEN_EXPIRY = '1h'; // 1 hour (was 15m)
const REFRESH_TOKEN_EXPIRY = '30d';
const TEMP_TOKEN_EXPIRY = '10m';

const generateAccessToken = (payload) => {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: ACCESS_TOKEN_EXPIRY });
};

const generateRefreshToken = (payload) => {
  return jwt.sign(payload, getJwtRefreshSecret(), { expiresIn: REFRESH_TOKEN_EXPIRY });
};

const generateTempToken = (phone, role) => {
  return jwt.sign(
    { phone, role, type: 'temp' },
    getJwtSecret(),
    { expiresIn: TEMP_TOKEN_EXPIRY }
  );
};

const verifyAccessToken = (token) => {
  try {
    const decoded = verifyWithRotation(token, accessVerifyKeys());
    return { valid: true, decoded: normalizeDecodedUser(decoded) };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

const verifyRefreshToken = (token) => {
  try {
    const decoded = verifyWithRotation(token, refreshVerifyKeys());
    return { valid: true, decoded: normalizeDecodedUser(decoded) };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

const verifyTempToken = (token) => {
  try {
    const decoded = verifyWithRotation(token, accessVerifyKeys());
    if (decoded.type !== 'temp') {
      return { valid: false, error: 'Invalid token type' };
    }
    return { valid: true, decoded: normalizeDecodedUser(decoded) };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const generateTokenPair = (userId, role) => {
  const id = normalizeUserId(userId);
  const payload = { id, role };
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload)
  };
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTempToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyTempToken,
  hashToken,
  generateTokenPair,
  normalizeUserId,
  // Exposed for admin auth & other ad-hoc verify paths that need raw control
  // (e.g. ignoreExpiration). Both helpers honor the rotating verify keys.
  verifyAccessJwt: (token, options) => verifyWithRotation(token, accessVerifyKeys(), options),
  verifyRefreshJwt: (token, options) => verifyWithRotation(token, refreshVerifyKeys(), options),
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY
};
