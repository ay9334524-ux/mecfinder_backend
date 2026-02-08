const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// SECURITY: JWT secrets MUST be set via environment variables
// In production, generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// Validate secrets on startup (fail fast)
if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be set in production');
    process.exit(1);
  } else {
    // Only allow defaults in development
    console.warn('⚠️ WARNING: Using default JWT secrets - DO NOT use in production!');
  }
}

const getJwtSecret = () => JWT_SECRET || 'dev_jwt_secret_DO_NOT_USE_IN_PRODUCTION';
const getJwtRefreshSecret = () => JWT_REFRESH_SECRET || 'dev_refresh_secret_DO_NOT_USE_IN_PRODUCTION';

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
    return { valid: true, decoded: jwt.verify(token, getJwtSecret()) };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

const verifyRefreshToken = (token) => {
  try {
    return { valid: true, decoded: jwt.verify(token, getJwtRefreshSecret()) };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

const verifyTempToken = (token) => {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.type !== 'temp') {
      return { valid: false, error: 'Invalid token type' };
    }
    return { valid: true, decoded };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const generateTokenPair = (userId, role) => {
  const payload = { id: userId, role };
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
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY
};
