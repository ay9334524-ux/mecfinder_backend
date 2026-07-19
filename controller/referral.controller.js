const Referral = require('../models/Referral');
const User = require('../models/User');
const walletController = require('./wallet.controller');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

// Referral reward amounts (can be moved to config/DB)
const REFERRER_REWARD = 50; // ₹50 to referrer
const REFEREE_REWARD = 25;  // ₹25 to new user

/**
 * Get user's referral details
 * GET /api/referral
 */
const getReferralDetails = asyncHandler(async (req, res) => {
  const referral = await Referral.getOrCreate(req.user.id);

  ApiResponse.success(res, {
    referralCode: referral.referralCode,
    totalReferrals: referral.totalReferrals,
    successfulReferrals: referral.successfulReferrals,
    totalEarnings: referral.totalEarnings,
    referredUsers: referral.referredUsers.map(u => ({
      name: u.name,
      status: u.status,
      rewardGiven: u.referrerRewardGiven,
      rewardAmount: u.referrerRewardAmount,
      createdAt: u.createdAt,
    })),
    rewards: {
      referrerReward: REFERRER_REWARD,
      refereeReward: REFEREE_REWARD,
    },
  });
});

/**
 * Apply referral code (for new users)
 * POST /api/referral/apply
 */
const applyReferralCode = asyncHandler(async (req, res) => {
  const { referralCode } = req.body;
  const userId = req.user.id;

  // Check if user already used a referral code
  const existingReferral = await Referral.findOne({
    'referredUsers.userId': userId,
  });

  if (existingReferral) {
    return ApiResponse.badRequest(res, 'You have already used a referral code');
  }

  // Find the referrer by code
  const referrerReferral = await Referral.findOne({ 
    referralCode: referralCode.toUpperCase(),
    isActive: true,
  });

  if (!referrerReferral) {
    return ApiResponse.notFound(res, 'Invalid referral code');
  }

  // Can't refer yourself
  if (referrerReferral.userId.toString() === userId) {
    return ApiResponse.badRequest(res, 'You cannot use your own referral code');
  }

  // Get user details
  const user = await User.findById(userId);

  // Add to referrer's referred users list
  await referrerReferral.addReferredUser(userId, user.phone, user.name);

  // Credit welcome bonus to new user immediately
  await walletController.creditReferralBonus(
    userId,
    REFEREE_REWARD,
    referrerReferral._id.toString()
  );

  ApiResponse.success(res, {
    message: `Referral code applied! ₹${REFEREE_REWARD} credited to your wallet`,
    bonusAmount: REFEREE_REWARD,
  });
});

/**
 * Complete referral (called after first booking)
 * Internal function - not a route
 */
const completeReferral = async (userId) => {
  // Find if this user was referred
  const referral = await Referral.findOne({
    'referredUsers.userId': userId,
    'referredUsers.status': 'REGISTERED',
  });

  if (!referral) {
    return null;
  }

  // Update referral status and give rewards
  await referral.completeReferral(userId, REFERRER_REWARD, REFEREE_REWARD);

  // Credit bonus to referrer
  await walletController.creditReferralBonus(
    referral.userId.toString(),
    REFERRER_REWARD,
    referral._id.toString()
  );

  // TODO: Send notification to referrer

  return {
    referrerId: referral.userId,
    referrerReward: REFERRER_REWARD,
  };
};

/**
 * Get referral leaderboard (optional feature)
 * GET /api/referral/leaderboard
 */
const getLeaderboard = asyncHandler(async (req, res) => {
  const leaderboard = await Referral.find({ successfulReferrals: { $gt: 0 } })
    .sort({ successfulReferrals: -1 })
    .limit(10)
    .populate('userId', 'name profileImageUrl');

  const formattedLeaderboard = leaderboard.map((r, index) => ({
    rank: index + 1,
    name: r.userId?.name || 'Anonymous',
    avatar: r.userId?.profileImageUrl,
    referrals: r.successfulReferrals,
    earnings: r.totalEarnings,
  }));

  ApiResponse.success(res, { leaderboard: formattedLeaderboard });
});

/**
 * Get referral statistics (admin)
 * GET /api/referral/stats
 */
const getReferralStats = asyncHandler(async (req, res) => {
  const stats = await Referral.aggregate([
    {
      $group: {
        _id: null,
        totalReferrals: { $sum: '$totalReferrals' },
        successfulReferrals: { $sum: '$successfulReferrals' },
        totalEarnings: { $sum: '$totalEarnings' },
        activeReferrers: { $sum: { $cond: [{ $gt: ['$totalReferrals', 0] }, 1, 0] } },
      },
    },
  ]);

  ApiResponse.success(res, {
    stats: stats[0] || {
      totalReferrals: 0,
      successfulReferrals: 0,
      totalEarnings: 0,
      activeReferrers: 0,
    },
  });
});

module.exports = {
  getReferralDetails,
  applyReferralCode,
  completeReferral,
  getLeaderboard,
  getReferralStats,
};
