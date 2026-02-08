const Mechanic = require('../models/Mechanic');
const MechanicDocument = require('../models/MechanicDocument');
const MechanicEarning = require('../models/MechanicEarning');
const MechanicPayout = require('../models/MechanicPayout');
const cloudinaryService = require('../services/cloudinary.service');
const redisService = require('../services/redis.service');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Get mechanic profile
 * GET /api/mechanic/profile
 */
const getProfile = asyncHandler(async (req, res) => {
  const mechanic = await Mechanic.findById(req.mechanic.id)
    .select('-refreshTokenHash');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  // Get document verification status
  const docStatus = await MechanicDocument.getVerificationStatus(mechanic._id);

  ApiResponse.success(res, { 
    mechanic,
    documentStatus: docStatus,
  });
});

/**
 * Update mechanic profile
 * PUT /api/mechanic/profile
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { fullName, email, address, vehicleTypes, servicesOffered } = req.body;
  
  const updateData = {};
  if (fullName) updateData.fullName = fullName;
  if (email) updateData.email = email.toLowerCase();
  if (address) updateData.address = address;
  if (vehicleTypes) updateData.vehicleTypes = vehicleTypes;
  if (servicesOffered) updateData.servicesOffered = servicesOffered;

  const mechanic = await Mechanic.findByIdAndUpdate(
    req.mechanic.id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).select('-refreshTokenHash');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  ApiResponse.success(res, { mechanic }, 'Profile updated successfully');
});

/**
 * Upload profile photo
 * POST /api/mechanic/photo
 */
const uploadPhoto = asyncHandler(async (req, res) => {
  if (!req.file) {
    return ApiResponse.badRequest(res, 'No image file provided');
  }

  const result = await cloudinaryService.uploadMechanicPhoto(
    req.file.buffer,
    req.mechanic.id
  );
  
  if (!result.success) {
    return ApiResponse.serverError(res, 'Failed to upload photo');
  }

  // Update mechanic profile
  const mechanic = await Mechanic.findByIdAndUpdate(
    req.mechanic.id,
    { profilePhoto: result.url },
    { new: true }
  ).select('-refreshTokenHash');

  // Also create/update profile photo document
  await MechanicDocument.findOneAndUpdate(
    { mechanicId: req.mechanic.id, documentType: 'PROFILE_PHOTO' },
    {
      documentUrl: result.url,
      cloudinaryPublicId: result.publicId,
      status: 'PENDING',
      uploadedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  ApiResponse.success(res, { 
    photoUrl: result.url,
    mechanic,
  }, 'Photo uploaded successfully');
});

/**
 * Update bank details
 * PUT /api/mechanic/bank-details
 */
const updateBankDetails = asyncHandler(async (req, res) => {
  const { accountHolderName, accountNumber, ifscCode, bankName, upiId } = req.body;

  const mechanic = await Mechanic.findByIdAndUpdate(
    req.mechanic.id,
    {
      $set: {
        bankDetails: {
          accountHolderName,
          accountNumber,
          ifscCode: ifscCode.toUpperCase(),
          bankName,
          upiId,
        },
      },
    },
    { new: true, runValidators: true }
  ).select('-refreshTokenHash');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  ApiResponse.success(res, { 
    bankDetails: mechanic.bankDetails,
  }, 'Bank details updated successfully');
});

/**
 * Get bank details
 * GET /api/mechanic/bank-details
 */
const getBankDetails = asyncHandler(async (req, res) => {
  const mechanic = await Mechanic.findById(req.mechanic.id)
    .select('bankDetails');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  // Mask account number for security
  const maskedDetails = mechanic.bankDetails ? {
    ...mechanic.bankDetails.toObject(),
    accountNumber: mechanic.bankDetails.accountNumber 
      ? '****' + mechanic.bankDetails.accountNumber.slice(-4)
      : null,
  } : null;

  ApiResponse.success(res, { bankDetails: maskedDetails });
});

/**
 * Upload KYC document
 * POST /api/mechanic/document
 */
const uploadDocument = asyncHandler(async (req, res) => {
  const { documentType, documentNumber } = req.body;

  if (!req.file) {
    return ApiResponse.badRequest(res, 'No document file provided');
  }

  const validTypes = [
    'AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN_CARD', 
    'DRIVING_LICENSE', 'VEHICLE_RC', 'ADDRESS_PROOF',
    'SKILL_CERTIFICATE', 'OTHER'
  ];

  if (!validTypes.includes(documentType)) {
    return ApiResponse.badRequest(res, 'Invalid document type');
  }

  // Upload to Cloudinary
  const result = await cloudinaryService.uploadMechanicDocument(
    req.file.buffer,
    req.mechanic.id,
    documentType
  );

  if (!result.success) {
    return ApiResponse.serverError(res, 'Failed to upload document');
  }

  // Create or update document record
  const document = await MechanicDocument.findOneAndUpdate(
    { mechanicId: req.mechanic.id, documentType },
    {
      documentUrl: result.url,
      cloudinaryPublicId: result.publicId,
      documentNumber: documentNumber || undefined,
      status: 'PENDING',
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  ApiResponse.success(res, { document }, 'Document uploaded successfully');
});

/**
 * Get uploaded documents
 * GET /api/mechanic/documents
 */
const getDocuments = asyncHandler(async (req, res) => {
  const documents = await MechanicDocument.find({ mechanicId: req.mechanic.id })
    .select('-cloudinaryPublicId')
    .sort({ uploadedAt: -1 });

  const verificationStatus = await MechanicDocument.getVerificationStatus(req.mechanic.id);

  ApiResponse.success(res, { 
    documents,
    verificationStatus,
  });
});

/**
 * Update location and online status
 * PUT /api/mechanic/location
 */
const updateLocation = asyncHandler(async (req, res) => {
  const { latitude, longitude, isOnline } = req.body;

  const updateData = {
    lastActiveAt: new Date(),
  };

  if (typeof isOnline === 'boolean') {
    updateData.isOnline = isOnline;
  }

  const mechanic = await Mechanic.findByIdAndUpdate(
    req.mechanic.id,
    { $set: updateData },
    { new: true }
  );

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  // Update Redis for real-time tracking
  if (isOnline && latitude && longitude) {
    await redisService.setMechanicOnline(req.mechanic.id, {
      latitude,
      longitude,
      vehicleTypes: mechanic.vehicleTypes,
      servicesOffered: mechanic.servicesOffered.map(s => s.serviceId),
    });
    await redisService.addMechanicLocation(req.mechanic.id, longitude, latitude);
  } else if (isOnline === false) {
    await redisService.setMechanicOffline(req.mechanic.id);
    await redisService.removeMechanicLocation(req.mechanic.id);
  }

  ApiResponse.success(res, { 
    isOnline: mechanic.isOnline,
  }, isOnline ? 'You are now online' : 'You are now offline');
});

/**
 * Toggle online status
 * POST /api/mechanic/toggle-online
 */
const toggleOnline = asyncHandler(async (req, res) => {
  const mechanic = await Mechanic.findById(req.mechanic.id);

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  if (mechanic.status !== 'ACTIVE') {
    return ApiResponse.forbidden(res, 'Your account is not active. Please complete verification.');
  }

  mechanic.isOnline = !mechanic.isOnline;
  mechanic.lastActiveAt = new Date();
  await mechanic.save();

  // Update Redis
  if (mechanic.isOnline) {
    // Note: Location should be sent separately
    await redisService.setMechanicOnline(req.mechanic.id, {
      vehicleTypes: mechanic.vehicleTypes,
      servicesOffered: mechanic.servicesOffered.map(s => s.serviceId),
    });
  } else {
    await redisService.setMechanicOffline(req.mechanic.id);
    await redisService.removeMechanicLocation(req.mechanic.id);
  }

  ApiResponse.success(res, { 
    isOnline: mechanic.isOnline,
  }, mechanic.isOnline ? 'You are now online' : 'You are now offline');
});

/**
 * Get mechanic stats
 * GET /api/mechanic/stats
 */
const getStats = asyncHandler(async (req, res) => {
  const mechanic = await Mechanic.findById(req.mechanic.id)
    .select('ratingAverage ratingCount totalJobsCompleted totalEarnings');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  ApiResponse.success(res, {
    stats: {
      rating: mechanic.ratingAverage || 0,
      reviewCount: mechanic.ratingCount || 0,
      totalJobs: mechanic.totalJobsCompleted || 0,
      totalEarnings: mechanic.totalEarnings || 0,
    },
  });
});

/**
 * Delete account
 * DELETE /api/mechanic/account
 */
const deleteAccount = asyncHandler(async (req, res) => {
  const mechanic = await Mechanic.findById(req.mechanic.id);
  
  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  // Soft delete
  mechanic.status = 'SUSPENDED';
  mechanic.isOnline = false;
  mechanic.deletedAt = new Date();
  await mechanic.save();

  // Remove from Redis
  await redisService.setMechanicOffline(req.mechanic.id);
  await redisService.removeMechanicLocation(req.mechanic.id);

  ApiResponse.success(res, null, 'Account deleted successfully');
});

/**
 * Get wallet balance (total earnings available for withdrawal)
 * GET /api/mechanic/wallet
 */
const getWallet = asyncHandler(async (req, res) => {
  const mechanic = await Mechanic.findById(req.mechanic.id)
    .select('totalEarnings bankDetails');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  // Get total pending payouts
  const pendingPayouts = await MechanicPayout.aggregate([
    { 
      $match: { 
        mechanicId: mechanic._id, 
        status: { $in: ['REQUESTED', 'PROCESSING'] } 
      } 
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  // Get total completed payouts
  const completedPayouts = await MechanicPayout.aggregate([
    { $match: { mechanicId: mechanic._id, status: 'COMPLETED' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  const totalEarnings = mechanic.totalEarnings || 0;
  const totalWithdrawn = completedPayouts[0]?.total || 0;
  const pendingWithdrawal = pendingPayouts[0]?.total || 0;
  const availableBalance = totalEarnings - totalWithdrawn - pendingWithdrawal;

  // Get recent transactions (earnings + payouts)
  const recentEarnings = await MechanicEarning.find({ mechanicId: req.mechanic.id })
    .sort({ createdAt: -1 })
    .limit(10)
    .select('netAmount bookingCode createdAt serviceDetails');

  const recentPayouts = await MechanicPayout.find({ mechanicId: req.mechanic.id })
    .sort({ createdAt: -1 })
    .limit(5)
    .select('payoutId amount status createdAt completedAt');

  ApiResponse.success(res, {
    wallet: {
      totalEarnings,
      totalWithdrawn,
      pendingWithdrawal,
      availableBalance,
      currency: 'INR',
      hasBankDetails: !!(mechanic.bankDetails?.accountNumber || mechanic.bankDetails?.upiId),
    },
    recentEarnings,
    recentPayouts,
  });
});

/**
 * Request withdrawal
 * POST /api/mechanic/withdraw
 */
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { amount, payoutMethod } = req.body; // payoutMethod: 'BANK' or 'UPI'

  const mechanic = await Mechanic.findById(req.mechanic.id);

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  // Validate minimum withdrawal
  const MIN_WITHDRAWAL = 100;
  const MAX_DAILY_WITHDRAWAL = 50000;

  if (amount < MIN_WITHDRAWAL) {
    return ApiResponse.badRequest(res, `Minimum withdrawal amount is ₹${MIN_WITHDRAWAL}`);
  }

  // Check bank details
  if (payoutMethod === 'BANK') {
    if (!mechanic.bankDetails?.accountNumber || !mechanic.bankDetails?.ifscCode) {
      return ApiResponse.badRequest(res, 'Please add bank account details first');
    }
  } else if (payoutMethod === 'UPI') {
    if (!mechanic.bankDetails?.upiId) {
      return ApiResponse.badRequest(res, 'Please add UPI ID first');
    }
  } else {
    return ApiResponse.badRequest(res, 'Invalid payout method. Use BANK or UPI');
  }

  // Calculate available balance
  const pendingPayouts = await MechanicPayout.aggregate([
    { 
      $match: { 
        mechanicId: mechanic._id, 
        status: { $in: ['REQUESTED', 'PROCESSING'] } 
      } 
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  const completedPayouts = await MechanicPayout.aggregate([
    { $match: { mechanicId: mechanic._id, status: 'COMPLETED' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  const totalWithdrawn = completedPayouts[0]?.total || 0;
  const pendingWithdrawal = pendingPayouts[0]?.total || 0;
  const availableBalance = (mechanic.totalEarnings || 0) - totalWithdrawn - pendingWithdrawal;

  if (amount > availableBalance) {
    return ApiResponse.badRequest(res, `Insufficient balance. Available: ₹${availableBalance.toFixed(2)}`);
  }

  // Check daily limit
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayPayouts = await MechanicPayout.aggregate([
    { 
      $match: { 
        mechanicId: mechanic._id, 
        createdAt: { $gte: todayStart },
        status: { $ne: 'CANCELLED' }
      } 
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  const todayTotal = todayPayouts[0]?.total || 0;
  if (todayTotal + amount > MAX_DAILY_WITHDRAWAL) {
    return ApiResponse.badRequest(res, `Daily withdrawal limit is ₹${MAX_DAILY_WITHDRAWAL}. You can withdraw ₹${MAX_DAILY_WITHDRAWAL - todayTotal} more today.`);
  }

  // Create payout request
  const payout = await MechanicPayout.create({
    mechanicId: mechanic._id,
    amount,
    bankDetails: {
      accountHolderName: mechanic.bankDetails.accountHolderName,
      accountNumber: mechanic.bankDetails.accountNumber,
      ifscCode: mechanic.bankDetails.ifscCode,
      bankName: mechanic.bankDetails.bankName,
      upiId: mechanic.bankDetails.upiId,
    },
    paymentGateway: payoutMethod === 'UPI' ? 'RAZORPAY' : 'BANK_TRANSFER',
    status: 'REQUESTED',
    breakdown: {
      totalEarnings: amount,
      platformFee: 0,
      tds: amount > 10000 ? amount * 0.01 : 0, // 1% TDS if > 10K
      otherDeductions: 0,
      netAmount: amount - (amount > 10000 ? amount * 0.01 : 0),
    },
  });

  ApiResponse.success(res, { 
    payout: {
      id: payout._id,
      payoutId: payout.payoutId,
      amount: payout.amount,
      netAmount: payout.breakdown.netAmount,
      status: payout.status,
    },
    newAvailableBalance: availableBalance - amount,
  }, 'Withdrawal request submitted successfully. It will be processed within 24 hours.');
});

/**
 * Get withdrawal history
 * GET /api/mechanic/withdrawals
 */
const getWithdrawals = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const skip = (page - 1) * limit;

  const filter = { mechanicId: req.mechanic.id };
  if (status) filter.status = status;

  const [payouts, total] = await Promise.all([
    MechanicPayout.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('-bankDetails.accountNumber'),
    MechanicPayout.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, payouts, {
    page: parseInt(page),
    limit: parseInt(limit),
    total,
  });
});

module.exports = {
  getProfile,
  updateProfile,
  uploadPhoto,
  updateBankDetails,
  getBankDetails,
  uploadDocument,
  getDocuments,
  updateLocation,
  toggleOnline,
  getStats,
  deleteAccount,
  // Wallet & Withdrawals
  getWallet,
  requestWithdrawal,
  getWithdrawals,
};
