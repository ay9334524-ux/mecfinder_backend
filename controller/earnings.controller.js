const MechanicEarning = require('../models/MechanicEarning');
const MechanicPayout = require('../models/MechanicPayout');
const Mechanic = require('../models/Mechanic');
const razorpayService = require('../services/razorpay.service');
const notificationController = require('./notification.controller');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');
const { getMinPayoutInr } = require('../config/minPayoutInr');
const { clampLimit, clampPage } = require('../utils/pagination');

/**
 * Get earnings overview
 * GET /api/mechanic/earnings
 */
const getEarningsOverview = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;

  // Get summary
  const summary = await MechanicEarning.getEarningsSummary(mechanicId);

  // Get daily earnings for last 7 days
  const dailyEarnings = await MechanicEarning.getDailyEarnings(mechanicId, 7);

  // Get pending payout
  const pendingPayout = await MechanicPayout.findOne({
    mechanicId,
    status: { $in: ['REQUESTED', 'PROCESSING'] },
  });

  ApiResponse.success(res, {
    summary: {
      availableBalance: summary.availableBalance,
      totalEarnings: summary.totalEarnings,
      processingAmount: summary.processingAmount,
      paidAmount: summary.paidAmount,
      totalJobs: summary.totalJobs,
    },
    dailyEarnings,
    pendingPayout: pendingPayout ? {
      id: pendingPayout._id,
      amount: pendingPayout.amount,
      status: pendingPayout.status,
      requestedAt: pendingPayout.requestedAt,
    } : null,
  });
});

/**
 * Get earnings history
 * GET /api/mechanic/earnings/history
 */
const getEarningsHistory = asyncHandler(async (req, res) => {
  const { type, startDate, endDate } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 20 });
  const skip = (page - 1) * limit;

  const filter = { mechanicId: req.mechanic.id };

  if (type) filter.type = type;

  if (startDate || endDate) {
    filter.serviceDate = {};
    if (startDate) filter.serviceDate.$gte = new Date(startDate);
    if (endDate) filter.serviceDate.$lte = new Date(endDate);
  }

  const [earnings, total] = await Promise.all([
    MechanicEarning.find(filter)
      .sort({ serviceDate: -1 })
      .skip(skip)
      .limit(limit)
      .populate('bookingId', 'bookingId status'),
    MechanicEarning.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, earnings, {
    page,
    limit,
    total,
  });
});

/**
 * Get weekly earnings breakdown
 * GET /api/mechanic/earnings/weekly
 */
const getWeeklyEarnings = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  
  // Get start of current week (Monday)
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1);
  startOfWeek.setHours(0, 0, 0, 0);

  const weeklyData = await MechanicEarning.aggregate([
    {
      $match: {
        mechanicId: req.mechanic._id,
        serviceDate: { $gte: startOfWeek },
        status: { $in: ['AVAILABLE', 'PROCESSING', 'PAID'] },
      },
    },
    {
      $group: {
        _id: { $dayOfWeek: '$serviceDate' },
        total: { $sum: '$netAmount' },
        jobs: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Fill in missing days
  const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weeklyEarnings = daysOfWeek.map((day, index) => {
    const dayData = weeklyData.find(d => d._id === index + 1);
    return {
      day,
      earnings: dayData?.total || 0,
      jobs: dayData?.jobs || 0,
    };
  });

  const totalWeekly = weeklyData.reduce((sum, d) => sum + d.total, 0);
  const totalJobs = weeklyData.reduce((sum, d) => sum + d.jobs, 0);

  ApiResponse.success(res, {
    weeklyEarnings,
    totalWeekly,
    totalJobs,
    weekStartDate: startOfWeek,
  });
});

/**
 * Request payout
 * POST /api/mechanic/earnings/payout
 */
const requestPayout = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  const { amount } = req.body;

  // Check if there's already a pending payout
  const existingPayout = await MechanicPayout.findOne({
    mechanicId,
    status: { $in: ['REQUESTED', 'PROCESSING'] },
  });

  if (existingPayout) {
    return ApiResponse.badRequest(res, 'You already have a pending payout request');
  }

  // Get available balance
  const summary = await MechanicEarning.getEarningsSummary(mechanicId);

  if (amount > summary.availableBalance) {
    return ApiResponse.badRequest(res, 'Insufficient balance for payout');
  }

  const minPayout = getMinPayoutInr();
  if (amount < minPayout) {
    return ApiResponse.badRequest(
      res,
      `Minimum payout amount is ₹${minPayout} — use Wallet screen for the new queue flow`,
    );
  }

  // Get mechanic bank details
  const mechanic = await Mechanic.findById(mechanicId);
  
  if (!mechanic.bankDetails?.accountNumber || !mechanic.bankDetails?.ifscCode) {
    return ApiResponse.badRequest(res, 'Please add bank details before requesting payout');
  }

  // Create payout request
  const payout = await MechanicPayout.create({
    mechanicId,
    amount,
    bankDetails: {
      accountHolderName: mechanic.bankDetails.accountHolderName,
      accountNumber: mechanic.bankDetails.accountNumber,
      ifscCode: mechanic.bankDetails.ifscCode,
      bankName: mechanic.bankDetails.bankName,
      upiId: mechanic.bankDetails.upiId,
    },
    status: 'REQUESTED',
    requestedAt: new Date(),
  });

  // Mark earnings as processing
  await MechanicEarning.updateMany(
    {
      mechanicId,
      status: 'AVAILABLE',
    },
    {
      $set: {
        status: 'PROCESSING',
        payoutId: payout._id,
      },
    }
  );

  // Send notification
  await notificationController.sendPayoutNotification(
    mechanicId,
    'Payout Requested',
    `Your payout request of ₹${amount} has been submitted`,
    amount,
    'REQUESTED'
  );

  ApiResponse.success(res, {
    payout: {
      id: payout._id,
      payoutId: payout.payoutId,
      amount: payout.amount,
      status: payout.status,
      requestedAt: payout.requestedAt,
    },
  }, 'Payout request submitted successfully');
});

/**
 * Get payout history
 * GET /api/mechanic/earnings/payouts
 */
const getPayoutHistory = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 10 });
  const skip = (page - 1) * limit;

  const filter = { mechanicId: req.mechanic.id };
  if (status) filter.status = status;

  const [payouts, total] = await Promise.all([
    MechanicPayout.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    MechanicPayout.countDocuments(filter),
  ]);

  // Mask bank account numbers
  const maskedPayouts = payouts.map((p) => {
    const acc = p.bankDetails?.accountNumber || '';
    const maskedAcc =
      acc.length > 4 ? `****${acc.slice(-4)}` : acc;
    return {
      ...p.toObject(),
      bankDetails: {
        ...p.bankDetails,
        accountNumber: maskedAcc,
      },
    };
  });

  ApiResponse.paginated(res, maskedPayouts, {
    page,
    limit,
    total,
  });
});

/**
 * Get payout details
 * GET /api/mechanic/earnings/payout/:id
 */
const getPayoutDetails = asyncHandler(async (req, res) => {
  const payout = await MechanicPayout.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
  }).populate('bookingIds', 'bookingId serviceSnapshot.name pricing.mechanicEarning');

  if (!payout) {
    return ApiResponse.notFound(res, 'Payout not found');
  }

  // Mask bank account
  const acc = payout.bankDetails?.accountNumber || '';
  const maskedAcc = acc.length > 4 ? `****${acc.slice(-4)}` : acc;
  const maskedPayout = {
    ...payout.toObject(),
    bankDetails: {
      ...payout.bankDetails,
      accountNumber: maskedAcc,
    },
  };

  ApiResponse.success(res, { payout: maskedPayout });
});

// Internal functions

/**
 * Create earning record after job completion
 */
const createEarning = async (bookingData) => {
  const {
    bookingId,
    mechanicId,
    grossAmount,
    platformFeePercent = 25,
    platformFeeAmount,
    gstOnPlatformFee,
    netAmount,
    serviceDetails,
    customerName,
    customerPhone,
    location,
    paymentMethod,
    // CASH payments use 'ON_HOLD' so they don't inflate wallet balance until debt is cleared
    status: earningStatus = 'AVAILABLE',
  } = bookingData;

  const existing = await MechanicEarning.findOne({ bookingId });
  if (existing) {
    return existing;
  }

  const computedPlatformFee = typeof platformFeeAmount === 'number'
    ? platformFeeAmount
    : (grossAmount * platformFeePercent) / 100;
  const computedGstOnPlatformFee = typeof gstOnPlatformFee === 'number'
    ? gstOnPlatformFee
    : (computedPlatformFee * 18) / 100;
  const computedNetAmount = typeof netAmount === 'number'
    ? netAmount
    : grossAmount - computedPlatformFee - computedGstOnPlatformFee;

  const isOnHold = earningStatus === 'ON_HOLD';

  const earning = await MechanicEarning.create({
    mechanicId,
    bookingId,
    bookingCode: bookingData.bookingCode,
    type: 'JOB',
    grossAmount,
    platformFee: computedPlatformFee,
    platformFeePercent,
    gstOnPlatformFee: computedGstOnPlatformFee,
    netAmount: computedNetAmount,
    status: earningStatus,
    availableAt: isOnHold ? undefined : new Date(),
    paymentMethod,
    serviceDetails,
    customerName,
    customerPhone,
    location,
    serviceDate: new Date(),
  });

  // totalJobsConfirmed is incremented in booking confirmPayment flow only (avoid double count)
  await Mechanic.findByIdAndUpdate(mechanicId, {
    $inc: { totalEarnings: computedNetAmount },
  });

  return earning;
};

/**
 * Process payout (admin function)
 */
const processPayout = async (payoutId, adminId) => {
  const payout = await MechanicPayout.findById(payoutId);
  
  if (!payout || payout.status !== 'REQUESTED') {
    throw new Error('Invalid payout or already processed');
  }

  await payout.markProcessing(adminId);

  // Attempt Razorpay payout (if RazorpayX is active)
  try {
    const result = await razorpayService.createPayout({
      accountNumber: payout.bankDetails.accountNumber,
      ifscCode: payout.bankDetails.ifscCode,
      accountHolderName: payout.bankDetails.accountHolderName,
      amount: payout.amount,
      reference: `PAYOUT_${payout._id}`,
    });

    if (result.success) {
      await payout.markCompleted(result.payout.reference, result.payout.id);
      
      // Mark earnings as paid
      await MechanicEarning.updateMany(
        { payoutId: payout._id },
        { $set: { status: 'PAID', paidAt: new Date() } }
      );

      // Send notification
      await notificationController.sendPayoutNotification(
        payout.mechanicId,
        'Payout Completed',
        `₹${payout.amount} has been transferred to your bank account`,
        payout.amount,
        'COMPLETED'
      );

      return { success: true, payout };
    } else {
      // For now, mark as completed manually (RazorpayX not active)
      await payout.markCompleted(`MANUAL_${Date.now()}`, null);
      
      await MechanicEarning.updateMany(
        { payoutId: payout._id },
        { $set: { status: 'PAID', paidAt: new Date() } }
      );

      return { success: true, payout, note: 'Processed manually' };
    }
  } catch (error) {
    await payout.markFailed(error.message);
    
    // Revert earnings status
    await MechanicEarning.updateMany(
      { payoutId: payout._id },
      { $set: { status: 'AVAILABLE', payoutId: null } }
    );

    await notificationController.sendPayoutNotification(
      payout.mechanicId,
      'Payout Failed',
      `Your payout of ₹${payout.amount} failed. Please check your bank details.`,
      payout.amount,
      'FAILED'
    );

    throw error;
  }
};

module.exports = {
  getEarningsOverview,
  getEarningsHistory,
  getWeeklyEarnings,
  requestPayout,
  getPayoutHistory,
  getPayoutDetails,
  // Internal
  createEarning,
  processPayout,
};
