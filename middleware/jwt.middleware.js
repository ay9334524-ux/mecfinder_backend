const tokenService = require('../services/token.service');
const User = require('../models/User');
const Mechanic = require('../models/Mechanic');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Access token required' });
    }

    const token = authHeader.split(' ')[1];
    const result = tokenService.verifyAccessToken(token);

    if (!result.valid) {
      if (result.error === 'jwt expired') {
        return res.status(401).json({ success: false, message: 'Access token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ success: false, message: 'Invalid access token' });
    }

    req.user = result.decoded;
    next();
  } catch (error) {
    console.error('Auth Middleware Error:', error);
    res.status(500).json({ success: false, message: 'Authentication error' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions' });
    }

    // Set role-specific request properties for controller convenience
    if (req.user.role === 'MECHANIC') {
      req.mechanic = { id: req.user.id, ...req.user };
    }

    next();
  };
};

const requireUser = requireRole('USER');
const requireMechanic = requireRole('MECHANIC');
const requireUserOrMechanic = requireRole('USER', 'MECHANIC');

const requireActiveStatus = async (req, res, next) => {
  try {
    const { id, role } = req.user;

    let account = null;
    if (role === 'USER') {
      account = await User.findById(id).select('status');
    } else if (role === 'MECHANIC') {
      account = await Mechanic.findById(id).select('status');
    }

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    if (account.status === 'BANNED') {
      return res.status(403).json({ success: false, message: 'Account is banned' });
    }

    if (account.status === 'SUSPENDED') {
      return res.status(403).json({ success: false, message: 'Account is suspended' });
    }

    if (role === 'MECHANIC' && account.status === 'PENDING') {
      return res.status(403).json({ success: false, message: 'Account pending approval', code: 'PENDING_APPROVAL' });
    }

    next();
  } catch (error) {
    console.error('Status Check Error:', error);
    res.status(500).json({ success: false, message: 'Status verification error' });
  }
};

module.exports = {
  authenticateToken,
  requireRole,
  requireUser,
  requireMechanic,
  requireUserOrMechanic,
  requireActiveStatus
};
