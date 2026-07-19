const Admin = require('../models/Admin');
const crypto = require('crypto');
const redisService = require('../services/redis.service');
const tokenService = require('../services/token.service');

/**
 * Admin authentication middleware using JWT
 * SECURITY: Only JWT Bearer tokens are accepted; revoked tokens are blocked
 * via Redis blocklist (set on logout). Verification accepts the previous
 * JWT secret too (graceful rotation) — see services/token.service.js.
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authentication required. Please provide a valid Bearer token.' });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = tokenService.verifyAccessJwt(token);

      // Accept both 'admin' and 'admin_access' token types
      if (decoded.type !== 'admin' && decoded.type !== 'admin_access') {
        return res.status(401).json({ message: 'Invalid token type.' });
      }

      // Reject blocklisted tokens (admin logout sets these).
      try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        if (await redisService.isTokenBlocklisted(tokenHash)) {
          return res.status(401).json({ message: 'Token revoked.', code: 'TOKEN_REVOKED' });
        }
      } catch (_) { /* Redis offline — fail open */ }

      // Support both 'id' and 'adminId' in token payload
      const adminId = decoded.id || decoded.adminId;
      const admin = await Admin.findById(adminId);

      if (!admin || admin.status !== 'ACTIVE') {
        return res.status(401).json({ message: 'Invalid or disabled admin.' });
      }

      req.admin = {
        id: admin._id.toString(),
        name: admin.name,
        email: admin.email,
        role: admin.role,
      };
      req.adminAccessToken = token;

      return next();
    } catch (jwtError) {
      const expired = jwtError?.name === 'TokenExpiredError';
      return res.status(401).json({
        message: expired ? 'Token expired.' : 'Invalid or expired token.',
        code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      });
    }
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Role check middleware factory
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.admin.role)) {
      return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
    }

    next();
  };
};

// Specific role middlewares
const requireAdmin = requireRole('SUPER_ADMIN', 'ADMIN');
const requireSuperAdmin = requireRole('SUPER_ADMIN');
const requireSupport = requireRole('SUPER_ADMIN', 'ADMIN', 'SUPPORT');

module.exports = {
  authMiddleware,
  requireRole,
  requireAdmin,
  requireSuperAdmin,
  requireSupport
};
