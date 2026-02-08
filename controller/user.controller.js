const User = require('../models/User');
const cloudinaryService = require('../services/cloudinary.service');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Get current user profile
 * GET /api/user/profile
 */
const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select('-refreshTokenHash');
  
  if (!user) {
    return ApiResponse.notFound(res, 'User not found');
  }

  ApiResponse.success(res, { user });
});

/**
 * Update user profile
 * PUT /api/user/profile
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, gender } = req.body;
  
  const updateData = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email.toLowerCase();
  if (gender) updateData.gender = gender;

  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).select('-refreshTokenHash');

  if (!user) {
    return ApiResponse.notFound(res, 'User not found');
  }

  ApiResponse.success(res, { user }, 'Profile updated successfully');
});

/**
 * Upload avatar
 * POST /api/user/avatar
 */
const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) {
    return ApiResponse.badRequest(res, 'No image file provided');
  }

  // Get current user to check for existing avatar
  const user = await User.findById(req.user.id);
  if (!user) {
    return ApiResponse.notFound(res, 'User not found');
  }

  // Upload to Cloudinary
  const result = await cloudinaryService.uploadUserAvatar(req.file.buffer, req.user.id);
  
  if (!result.success) {
    return ApiResponse.serverError(res, 'Failed to upload avatar');
  }

  // Update user with new avatar URL
  user.profileImageUrl = result.url;
  await user.save();

  ApiResponse.success(res, { 
    avatarUrl: result.url,
    user: user.toObject({ versionKey: false }),
  }, 'Avatar uploaded successfully');
});

/**
 * Update user location
 * PUT /api/user/location
 */
const updateLocation = asyncHandler(async (req, res) => {
  const { latitude, longitude, address } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user.id,
    {
      $set: {
        lastLocation: {
          lat: latitude,
          lng: longitude,
          address: address || '',
        },
      },
    },
    { new: true }
  ).select('-refreshTokenHash');

  if (!user) {
    return ApiResponse.notFound(res, 'User not found');
  }

  ApiResponse.success(res, { user }, 'Location updated');
});

/**
 * Delete user account
 * DELETE /api/user/account
 */
const deleteAccount = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return ApiResponse.notFound(res, 'User not found');
  }

  // Soft delete - change status to BANNED
  user.status = 'BANNED';
  user.deletedAt = new Date();
  await user.save();

  // TODO: Clean up related data (wallet, referrals, etc.)

  ApiResponse.success(res, null, 'Account deleted successfully');
});

/**
 * Get saved addresses (future feature)
 * GET /api/user/addresses
 */
const getAddresses = asyncHandler(async (req, res) => {
  // Placeholder for saved addresses feature
  ApiResponse.success(res, { addresses: [] }, 'Addresses retrieved');
});

module.exports = {
  getProfile,
  updateProfile,
  uploadAvatar,
  updateLocation,
  deleteAccount,
  getAddresses,
};
