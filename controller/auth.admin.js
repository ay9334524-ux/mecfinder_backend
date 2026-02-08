const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

const ALLOWED_ROLES = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];

// Fail fast if JWT_SECRET not set in production
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET environment variable is required in production!');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.ADMIN_JWT_EXPIRES_IN || '7d';
const REFRESH_TOKEN_EXPIRES_IN = process.env.ADMIN_REFRESH_TOKEN_EXPIRES_IN || '30d';

const sanitizeAdmin = (adminDoc) => ({
  id: adminDoc._id,
  name: adminDoc.name,
  email: adminDoc.email,
  role: adminDoc.role,
  status: adminDoc.status
});

/**
 * Generate JWT tokens for admin
 */
const generateTokens = (admin) => {
  const accessToken = jwt.sign(
    { 
      adminId: admin._id, 
      email: admin.email, 
      role: admin.role,
      type: 'admin_access'
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  
  const refreshToken = jwt.sign(
    { 
      adminId: admin._id,
      type: 'admin_refresh'
    },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );
  
  return { accessToken, refreshToken };
};

const registerAdmin = async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required.' });
    }

    if (role && !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Invalid role specified.' });
    }

    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(409).json({ message: 'Admin with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const admin = await Admin.create({
      name,
      email,
      phone,
      passwordHash,
      role: role && ALLOWED_ROLES.includes(role) ? role : 'ADMIN'
    });

    // Generate tokens for immediate login after registration
    const tokens = generateTokens(admin);

    return res.status(201).json({
      message: 'Admin registered successfully.',
      admin: sanitizeAdmin(admin),
      ...tokens
    });
  } catch (error) {
    console.error('Error registering admin:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

const loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    if (admin.status !== 'ACTIVE') {
      return res.status(403).json({ message: 'Account is not active. Please contact super admin.' });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    // Update login tracking
    admin.lastLoginAt = new Date();
    admin.lastLoginIp = req.ip;
    await admin.save();

    // Generate JWT tokens
    const tokens = generateTokens(admin);

    return res.status(200).json({
      message: 'Login successful.',
      admin: sanitizeAdmin(admin),
      ...tokens
    });
  } catch (error) {
    console.error('Error logging in admin:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Refresh access token using refresh token
 */
const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    
    if (!token) {
      return res.status(400).json({ message: 'Refresh token is required.' });
    }
    
    // Verify refresh token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Invalid or expired refresh token.' });
    }
    
    if (decoded.type !== 'admin_refresh') {
      return res.status(401).json({ message: 'Invalid token type.' });
    }
    
    // Find admin
    const admin = await Admin.findById(decoded.adminId);
    if (!admin || admin.status !== 'ACTIVE') {
      return res.status(401).json({ message: 'Admin not found or inactive.' });
    }
    
    // Generate new tokens
    const tokens = generateTokens(admin);
    
    return res.status(200).json({
      message: 'Token refreshed successfully.',
      ...tokens
    });
  } catch (error) {
    console.error('Error refreshing token:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Logout admin (client should discard tokens)
 */
const logoutAdmin = async (req, res) => {
  try {
    // In a more advanced setup, you'd blacklist the token in Redis
    // For now, logout is handled client-side by discarding tokens
    return res.status(200).json({ message: 'Logged out successfully.' });
  } catch (error) {
    console.error('Error logging out admin:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Get current admin profile
 */
const getProfile = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(404).json({ message: 'Admin not found.' });
    }
    
    return res.status(200).json({
      admin: sanitizeAdmin(admin)
    });
  } catch (error) {
    console.error('Error getting profile:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Change password
 */
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required.' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    }
    
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(404).json({ message: 'Admin not found.' });
    }
    
    const isPasswordValid = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }
    
    admin.passwordHash = await bcrypt.hash(newPassword, 10);
    await admin.save();
    
    return res.status(200).json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Error changing password:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

module.exports = {
  registerAdmin,
  loginAdmin,
  refreshToken,
  logoutAdmin,
  getProfile,
  changePassword,
  generateTokens,
  ALLOWED_ROLES
};
