const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const firebaseService = require('../services/firebase.service');
const tokenService = require('../services/token.service');
const notificationService = require('../services/notification.service');
const redisService = require('../services/redis.service');

const PHONE_REGEX = /^\+91[6-9]\d{9}$/;

const validatePhone = (phone) => {
  if (!phone || !PHONE_REGEX.test(phone)) {
    return { valid: false, error: 'Invalid phone number. Use format: +91XXXXXXXXXX' };
  }
  return { valid: true };
};

const validateRole = (role) => {
  if (!role || !['USER', 'MECHANIC'].includes(role)) {
    return { valid: false, error: 'Invalid role. Must be USER or MECHANIC' };
  }
  return { valid: true };
};

/**
 * POST /auth/send-otp
 * Firebase Phone Auth handles OTP sending entirely on the client side.
 * This endpoint is kept for API compatibility but is now a no-op stub.
 * The client should call Firebase SDK's verifyPhoneNumber() directly.
 */
const sendOtp = async (req, res) => {
  try {
    const { phone, role } = req.body;

    const phoneValidation = validatePhone(phone);
    if (!phoneValidation.valid) {
      return res.status(400).json({ success: false, message: phoneValidation.error });
    }

    const roleValidation = validateRole(role);
    if (!roleValidation.valid) {
      return res.status(400).json({ success: false, message: roleValidation.error });
    }

    // OTP is now sent directly by the Firebase SDK on the client.
    // Server just acknowledges the request.
    res.json({
      success: true,
      message: 'Use Firebase SDK to verify your phone number',
      data: { phone, provider: 'firebase' }
    });
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /auth/verify-otp
 * Accepts a Firebase ID token obtained after the client completes phone
 * verification via the Firebase SDK. The backend verifies the token with
 * Firebase Admin SDK to confirm the phone number, then issues JWTs.
 *
 * Body: { firebaseIdToken: string, role: "USER"|"MECHANIC" }
 */
const verifyOtp = async (req, res) => {
  try {
    const { firebaseIdToken, role } = req.body;

    if (!firebaseIdToken) {
      return res.status(400).json({
        success: false,
        message: 'firebaseIdToken is required. Complete phone verification via Firebase SDK first.'
      });
    }

    const roleValidation = validateRole(role);
    if (!roleValidation.valid) {
      return res.status(400).json({ success: false, message: roleValidation.error });
    }

    // Verify the Firebase ID token and extract the phone number
    const tokenResult = await firebaseService.verifyFirebaseIdToken(firebaseIdToken);

    if (!tokenResult.valid) {
      return res.status(400).json({ success: false, message: tokenResult.error || 'Firebase token verification failed' });
    }

    const phone = tokenResult.phone;

    // Validate the phone number extracted from the Firebase token
    const phoneValidation = validatePhone(phone);
    if (!phoneValidation.valid) {
      return res.status(400).json({ success: false, message: `Phone number from token is invalid: ${phone}` });
    }

    // Phone number is intentionally NOT logged here (PII).

    // Check if account exists
    let account = null;
    if (role === 'USER') {
      account = await User.findOne({ phone });
    } else {
      account = await Mechanic.findOne({ phone });
    }

    // CASE A: Account exists - login
    if (account) {
      // Check if banned with detailed ban info
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
            // Continue with login below
          } else {
            // Ban still active - return detailed info
            const expiresAt = new Date(account.banInfo.banExpiresAt);
            const remainingMs = expiresAt - now;
            const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
            const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
            
            let banMessage = `Your account is temporarily banned for ${remainingDays} more days.`;
            if (remainingDays <= 1) {
              banMessage = `Your account is temporarily banned for ${remainingHours} more hours.`;
            }
            
            return res.status(403).json({
              success: false,
              message: banMessage,
              code: 'ACCOUNT_BANNED',
              banDetails: {
                isBanned: true,
                banType: 'TEMPORARY',
                reason: account.banInfo.banReason,
                bannedAt: account.banInfo.bannedAt,
                expiresAt: account.banInfo.banExpiresAt,
                remainingDays,
                remainingHours,
              }
            });
          }
        } else {
          // Permanent ban
          return res.status(403).json({
            success: false,
            message: 'Your account has been permanently banned.',
            code: 'ACCOUNT_BANNED',
            banDetails: {
              isBanned: true,
              banType: 'PERMANENT',
              reason: account.banInfo.banReason,
              bannedAt: account.banInfo.bannedAt,
            }
          });
        }
      }
      
      // Check legacy status field
      if (account.status === 'BANNED') {
        return res.status(403).json({ success: false, message: 'Account is banned', code: 'ACCOUNT_BANNED' });
      }
      if (account.status === 'SUSPENDED') {
        return res.status(403).json({ success: false, message: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
      }

      // Generate tokens
      const tokens = tokenService.generateTokenPair(account._id, role);

      // Save hashed refresh token
      account.refreshTokenHash = tokenService.hashToken(tokens.refreshToken);
      account.lastLoginAt = new Date();
      account.updatedAt = new Date();
      await account.save();

      // Prepare profile (exclude sensitive data)
      const profile = account.toObject();
      delete profile.refreshTokenHash;

      return res.json({
        success: true,
        isNewUser: false,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        profile
      });
    }

    // CASE B: Account does not exist - return temp token
    const tempToken = tokenService.generateTempToken(phone, role);

    res.json({
      success: true,
      isNewUser: true,
      tempToken,
      message: 'Complete registration to continue'
    });
  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/register-user
const registerUser = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Temp token required' });
    }

    const tempToken = authHeader.split(' ')[1];
    const tokenResult = tokenService.verifyTempToken(tempToken);

    if (!tokenResult.valid) {
      return res.status(401).json({ success: false, message: 'Invalid or expired temp token' });
    }

    const { phone, role } = tokenResult.decoded;

    if (role !== 'USER') {
      return res.status(400).json({ success: false, message: 'Invalid token role for user registration' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'User already exists' });
    }

    const { name, email, gender, location } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Name is required (min 2 characters)' });
    }

    // Create user
    const user = new User({
      phone,
      name: name.trim(),
      email: email?.toLowerCase().trim(),
      gender,
      lastLocation: location,
      role: 'USER',
      status: 'ACTIVE',
      isPhoneVerified: true,
      lastLoginAt: new Date()
    });

    // Generate tokens
    const tokens = tokenService.generateTokenPair(user._id, 'USER');
    user.refreshTokenHash = tokenService.hashToken(tokens.refreshToken);

    await user.save();

    // Send welcome notification
    try {
      await notificationService.sendWelcomeNotification(user._id);
    } catch (error) {
      console.error('Error sending welcome notification:', error);
    }

    const profile = user.toObject();
    delete profile.refreshTokenHash;

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      profile
    });
  } catch (error) {
    console.error('Register User Error:', error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Phone number already registered' });
    }
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/register-mechanic
const registerMechanic = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Temp token required' });
    }

    const tempToken = authHeader.split(' ')[1];
    const tokenResult = tokenService.verifyTempToken(tempToken);

    if (!tokenResult.valid) {
      return res.status(401).json({ success: false, message: 'Invalid or expired temp token' });
    }

    const { phone, role } = tokenResult.decoded;

    if (role !== 'MECHANIC') {
      return res.status(400).json({ success: false, message: 'Invalid token role for mechanic registration' });
    }

    // Check if mechanic already exists
    const existingMechanic = await Mechanic.findOne({ phone });
    if (existingMechanic) {
      return res.status(409).json({ success: false, message: 'Mechanic already exists' });
    }

    const { fullName, email, address, vehicleTypes, lastLocation } = req.body;

    if (!fullName || fullName.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Name is required (min 2 characters)' });
    }

    // Create mechanic - set to ACTIVE for testing (change to PENDING for production)
    const mechanicData = {
      phone,
      fullName: fullName.trim(),
      email: email?.toLowerCase().trim(),
      role: 'MECHANIC',
      status: 'ACTIVE', // Auto-approve for now
      lastLoginAt: new Date()
    };

    // Add optional fields
    if (address && typeof address === 'object') {
      mechanicData.address = address;
    }
    
    if (vehicleTypes && Array.isArray(vehicleTypes) && vehicleTypes.length > 0) {
      mechanicData.vehicleTypes = vehicleTypes;
    }
    
    if (lastLocation && lastLocation.lat && lastLocation.lng) {
      mechanicData.lastLocation = {
        lat: lastLocation.lat,
        lng: lastLocation.lng,
        address: address?.line1 || '',
        updatedAt: new Date()
      };
    }

    const mechanic = new Mechanic(mechanicData);

    // Generate tokens
    const tokens = tokenService.generateTokenPair(mechanic._id, 'MECHANIC');
    mechanic.refreshTokenHash = tokenService.hashToken(tokens.refreshToken);

    await mechanic.save();

    const profile = mechanic.toObject();
    delete profile.refreshTokenHash;

    res.status(201).json({
      success: true,
      message: 'Mechanic registered successfully.',
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        mechanic: profile
      }
    });
  } catch (error) {
    console.error('Register Mechanic Error:', error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Phone number already registered' });
    }
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/refresh
// Rotates the refresh token on every use so a stolen refresh token is
// invalidated as soon as the legitimate client refreshes.
const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Refresh token required' });
    }

    const tokenResult = tokenService.verifyRefreshToken(token);

    if (!tokenResult.valid) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    const { id, role } = tokenResult.decoded;
    const tokenHash = tokenService.hashToken(token);

    let account = null;
    if (role === 'USER') {
      account = await User.findById(id);
    } else if (role === 'MECHANIC') {
      account = await Mechanic.findById(id);
    }

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    if (account.refreshTokenHash !== tokenHash) {
      // Mismatch could indicate a stolen / reused refresh token. Revoke the
      // current session entirely so the legitimate user must re-authenticate.
      account.refreshTokenHash = null;
      await account.save();
      return res.status(401).json({ success: false, message: 'Refresh token reuse detected. Please log in again.' });
    }

    if (account.status === 'BANNED' || account.status === 'SUSPENDED' || account.banInfo?.isBanned) {
      return res.status(403).json({ success: false, message: 'Account is not active', code: 'ACCOUNT_NOT_ACTIVE' });
    }

    // Rotate: issue a fresh refresh + access token pair and store the new hash.
    const tokens = tokenService.generateTokenPair(account._id, role);
    account.refreshTokenHash = tokenService.hashToken(tokens.refreshToken);
    await account.save();

    res.json({
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (error) {
    console.error('Refresh Token Error:', error.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/logout
// Revokes the access token (Redis blocklist) and clears the refresh token
// hash on the account so prior refresh tokens are no longer accepted.
const logout = async (req, res) => {
  try {
    const { id, role } = req.user;

    if (role === 'USER') {
      await User.findByIdAndUpdate(id, { refreshTokenHash: null });
    } else if (role === 'MECHANIC') {
      await Mechanic.findByIdAndUpdate(id, { refreshTokenHash: null });
    }

    // Blocklist the access token in Redis until it would naturally expire.
    if (req.accessToken) {
      try {
        const tokenHash = tokenService.hashToken(req.accessToken);
        const decoded = tokenService.verifyAccessToken(req.accessToken).decoded;
        const expSeconds = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 60 * 60;
        if (expSeconds > 0) {
          await redisService.blocklistToken(tokenHash, expSeconds).catch(() => {});
        }
      } catch (_) { /* Redis offline — refresh token revocation still applies. */ }
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout Error:', error.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// GET /auth/me
const getMe = async (req, res) => {
  try {
    const { id, role } = req.user;

    let account = null;
    if (role === 'USER') {
      account = await User.findById(id).select('-refreshTokenHash');
    } else if (role === 'MECHANIC') {
      account = await Mechanic.findById(id).select('-refreshTokenHash');
    }

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    res.json({ success: true, profile: account });
  } catch (error) {
    console.error('Get Me Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  sendOtp,
  verifyOtp,
  registerUser,
  registerMechanic,
  refreshToken,
  logout,
  getMe
};
