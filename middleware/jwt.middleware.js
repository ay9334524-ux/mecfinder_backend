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
      account = await User.findById(id).select('status banInfo');
    } else if (role === 'MECHANIC') {
      account = await Mechanic.findById(id).select('status banInfo');
    }

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    // Check if banned
    if (account.banInfo?.isBanned) {
      // Check if temporary ban has expired
      if (account.banInfo.banType === 'TEMPORARY' && account.banInfo.banExpiresAt) {
        const now = new Date();
        if (now >= new Date(account.banInfo.banExpiresAt)) {
          // Ban has expired - auto unban
          account.status = 'ACTIVE';
          account.banInfo.isBanned = false;
          account.banInfo.unbanReason = 'Ban expired automatically';
          account.banInfo.unbannedAt = now;
          await account.save();
          // Continue with request
          return next();
        }
      }

      // Calculate remaining ban time for temporary bans
      let banMessage = 'Your account has been permanently banned.';
      let banDetails = {
        isBanned: true,
        banType: account.banInfo.banType,
        reason: account.banInfo.banReason,
        bannedAt: account.banInfo.bannedAt,
      };

      if (account.banInfo.banType === 'TEMPORARY' && account.banInfo.banExpiresAt) {
        const expiresAt = new Date(account.banInfo.banExpiresAt);
        const now = new Date();
        const remainingMs = expiresAt - now;
        const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
        const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
        
        if (remainingDays > 1) {
          banMessage = `Your account is temporarily banned for ${remainingDays} more days.`;
        } else if (remainingHours > 1) {
          banMessage = `Your account is temporarily banned for ${remainingHours} more hours.`;
        } else {
          banMessage = `Your account is temporarily banned. Ban expires soon.`;
        }
        
        banDetails.expiresAt = account.banInfo.banExpiresAt;
        banDetails.remainingDays = remainingDays;
        banDetails.remainingHours = remainingHours;
      }

      return res.status(403).json({
        success: false,
        message: banMessage,
        code: 'ACCOUNT_BANNED',
        banDetails,
      });
    }

    if (account.status === 'BANNED') {
      return res.status(403).json({ success: false, message: 'Account is banned', code: 'ACCOUNT_BANNED' });
    }

    if (account.status === 'SUSPENDED') {
      return res.status(403).json({ success: false, message: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
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
