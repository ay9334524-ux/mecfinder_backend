const Admin = require('../models/Admin');
const jwt = require('jsonwebtoken');

/**
 * Admin authentication middleware using JWT
 * SECURITY: Only JWT Bearer tokens are accepted
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authentication required. Please provide a valid Bearer token.' });
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      if (decoded.type !== 'admin') {
        return res.status(401).json({ message: 'Invalid token type.' });
      }
      
      const admin = await Admin.findById(decoded.id);
      
      if (!admin || admin.status !== 'ACTIVE') {
        return res.status(401).json({ message: 'Invalid or disabled admin.' });
      }
      
      req.admin = {
        id: admin._id.toString(),
        name: admin.name,
        email: admin.email,
        role: admin.role
      };
      
      return next();
    } catch (jwtError) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
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
