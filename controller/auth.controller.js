const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const twilioService = require('../services/twilio.service');
const tokenService = require('../services/token.service');

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

// POST /auth/send-otp
const sendOtp = async (req, res) => {
  try {
    const { phone, role } = req.body;
    console.log('📱 Send OTP Request:', { phone, role });

    const phoneValidation = validatePhone(phone);
    if (!phoneValidation.valid) {
      console.log('❌ Phone validation failed:', phoneValidation.error);
      return res.status(400).json({ success: false, message: phoneValidation.error });
    }

    const roleValidation = validateRole(role);
    if (!roleValidation.valid) {
      console.log('❌ Role validation failed:', roleValidation.error);
      return res.status(400).json({ success: false, message: roleValidation.error });
    }

    console.log('📤 Calling Twilio to send OTP...');
    const result = await twilioService.sendOtp(phone);
    console.log('📥 Twilio result:', result);

    if (!result.success) {
      return res.status(500).json({ success: false, message: result.error });
    }

    res.json({
      success: true,
      message: 'OTP sent successfully',
      data: { phone, status: result.status }
    });
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/verify-otp
const verifyOtp = async (req, res) => {
  try {
    const { phone, otp, role } = req.body;

    const phoneValidation = validatePhone(phone);
    if (!phoneValidation.valid) {
      return res.status(400).json({ success: false, message: phoneValidation.error });
    }

    const roleValidation = validateRole(role);
    if (!roleValidation.valid) {
      return res.status(400).json({ success: false, message: roleValidation.error });
    }

    if (!otp || otp.length !== 6) {
      return res.status(400).json({ success: false, message: 'Invalid OTP. Must be 6 digits' });
    }

    // Verify OTP with Twilio
    const verification = await twilioService.verifyOtp(phone, otp);

    if (!verification.success) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // Check if account exists
    let account = null;
    if (role === 'USER') {
      account = await User.findOne({ phone });
    } else {
      account = await Mechanic.findOne({ phone });
    }

    // CASE A: Account exists - login
    if (account) {
      // Check if banned/suspended
      if (account.status === 'BANNED') {
        return res.status(403).json({ success: false, message: 'Account is banned' });
      }
      if (account.status === 'SUSPENDED') {
        return res.status(403).json({ success: false, message: 'Account is suspended' });
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

    const { name, email, address, vehicleTypes, lastLocation } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Name is required (min 2 characters)' });
    }

    // Create mechanic - set to ACTIVE for testing (change to PENDING for production)
    const mechanicData = {
      phone,
      fullName: name.trim(),
      email: email?.toLowerCase().trim(),
      role: 'MECHANIC',
      status: 'ACTIVE', // Auto-approve for now
      lastLoginAt: new Date()
    };

    // Add optional fields
    if (address) {
      mechanicData.address = { line1: address };
    }
    
    if (vehicleTypes && Array.isArray(vehicleTypes) && vehicleTypes.length > 0) {
      mechanicData.vehicleTypes = vehicleTypes;
    }
    
    if (lastLocation && lastLocation.lat && lastLocation.lng) {
      mechanicData.lastLocation = {
        lat: lastLocation.lat,
        lng: lastLocation.lng,
        address: address || '',
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

    // Find account and verify stored refresh token
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
      return res.status(401).json({ success: false, message: 'Refresh token mismatch' });
    }

    // Check account status
    if (account.status === 'BANNED' || account.status === 'SUSPENDED') {
      return res.status(403).json({ success: false, message: 'Account is not active' });
    }

    // Generate new access token
    const newAccessToken = tokenService.generateAccessToken({ id: account._id, role });

    res.json({
      success: true,
      accessToken: newAccessToken
    });
  } catch (error) {
    console.error('Refresh Token Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// POST /auth/logout
const logout = async (req, res) => {
  try {
    const { id, role } = req.user;

    // Clear refresh token
    if (role === 'USER') {
      await User.findByIdAndUpdate(id, { refreshTokenHash: null });
    } else if (role === 'MECHANIC') {
      await Mechanic.findByIdAndUpdate(id, { refreshTokenHash: null });
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout Error:', error);
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
