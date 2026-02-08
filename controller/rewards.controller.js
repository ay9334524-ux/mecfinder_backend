const Reward = require('../models/Reward');
const UserReward = require('../models/UserReward');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

// Points earning rules
const POINTS_RULES = {
  BOOKING_COMPLETED: 10,      // Points per booking
  REVIEW_SUBMITTED: 5,        // Points for submitting review
  REFERRAL_SUCCESS: 20,       // Points for successful referral
  SIGNUP_BONUS: 50,           // Welcome points
  FIRST_BOOKING_BONUS: 25,    // First booking bonus
};

/**
 * Get user rewards & points
 * GET /api/rewards
 */
const getUserRewards = asyncHandler(async (req, res) => {
  const userReward = await UserReward.getOrCreate(req.user.id);
  
  // Get available rewards to redeem
  const availableRewards = await Reward.find({
    status: 'ACTIVE',
    pointsRequired: { $lte: userReward.availablePoints },
    $or: [
      { validTill: { $gt: new Date() } },
      { validTill: null },
    ],
  }).sort({ pointsRequired: 1 });

  ApiResponse.success(res, {
    points: {
      available: userReward.availablePoints,
      total: userReward.totalPoints,
      redeemed: userReward.redeemedPoints,
    },
    tier: userReward.tier,
    availableRewards,
    recentHistory: userReward.pointsHistory.slice(-10).reverse(),
    activeRewards: userReward.redeemedRewards.filter(r => r.status === 'ACTIVE'),
  });
});

/**
 * Get points history
 * GET /api/rewards/history
 */
const getPointsHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const userReward = await UserReward.findOne({ userId: req.user.id });
  
  if (!userReward) {
    return ApiResponse.success(res, { history: [], total: 0 });
  }

  const history = userReward.pointsHistory
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice((page - 1) * limit, page * limit);

  ApiResponse.paginated(res, history, {
    page: parseInt(page),
    limit: parseInt(limit),
    total: userReward.pointsHistory.length,
  });
});

/**
 * Get all available rewards catalog
 * GET /api/rewards/catalog
 */
const getRewardsCatalog = asyncHandler(async (req, res) => {
  const rewards = await Reward.find({
    status: 'ACTIVE',
    $or: [
      { validTill: { $gt: new Date() } },
      { validTill: null },
    ],
  }).sort({ pointsRequired: 1 });

  const userReward = await UserReward.findOne({ userId: req.user.id });
  const availablePoints = userReward?.availablePoints || 0;

  const catalogWithStatus = rewards.map(reward => ({
    ...reward.toObject(),
    canRedeem: availablePoints >= reward.pointsRequired,
    isAvailable: reward.isAvailable(),
  }));

  ApiResponse.success(res, { rewards: catalogWithStatus });
});

/**
 * Redeem a reward
 * POST /api/rewards/redeem
 */
const redeemReward = asyncHandler(async (req, res) => {
  const { rewardId } = req.body;

  const reward = await Reward.findById(rewardId);
  if (!reward) {
    return ApiResponse.notFound(res, 'Reward not found');
  }

  if (!reward.isAvailable()) {
    return ApiResponse.badRequest(res, 'This reward is no longer available');
  }

  const userReward = await UserReward.getOrCreate(req.user.id);

  if (userReward.availablePoints < reward.pointsRequired) {
    return ApiResponse.badRequest(res, 'Insufficient points');
  }

  // Check per-user limit
  const userRedemptions = userReward.redeemedRewards.filter(
    r => r.rewardId?.toString() === rewardId
  ).length;

  if (userRedemptions >= reward.perUserLimit) {
    return ApiResponse.badRequest(res, 'You have reached the redemption limit for this reward');
  }

  // Redeem the reward
  await userReward.redeemPoints(
    reward.pointsRequired,
    reward._id,
    reward.name,
    reward.value,
    30 // Valid for 30 days
  );

  // Update reward usage count
  reward.usedQuantity += 1;
  await reward.save();

  // Get the newly created redemption
  const redemption = userReward.redeemedRewards[userReward.redeemedRewards.length - 1];

  ApiResponse.success(res, {
    couponCode: redemption.couponCode,
    reward: {
      name: reward.name,
      value: reward.value,
      valueType: reward.valueType,
    },
    expiresAt: redemption.expiresAt,
    remainingPoints: userReward.availablePoints,
  }, 'Reward redeemed successfully!');
});

/**
 * Add points (internal function)
 */
const addPoints = async (userId, source, referenceId, description) => {
  const points = POINTS_RULES[source];
  if (!points) return null;

  const userReward = await UserReward.getOrCreate(userId);
  await userReward.addPoints(points, source, referenceId, description);

  return { points, total: userReward.availablePoints };
};

/**
 * Add signup bonus (internal function)
 */
const addSignupBonus = async (userId) => {
  return addPoints(userId, 'SIGNUP', userId, 'Welcome bonus');
};

/**
 * Add booking completion points (internal function)
 */
const addBookingPoints = async (userId, bookingId) => {
  return addPoints(userId, 'BOOKING', bookingId, 'Booking completed');
};

/**
 * Add review points (internal function)
 */
const addReviewPoints = async (userId, bookingId) => {
  return addPoints(userId, 'REVIEW', bookingId, 'Review submitted');
};

/**
 * Validate and use coupon
 * POST /api/rewards/validate-coupon
 */
const validateCoupon = asyncHandler(async (req, res) => {
  const { couponCode, bookingAmount } = req.body;

  const userReward = await UserReward.findOne({ userId: req.user.id });
  if (!userReward) {
    return ApiResponse.notFound(res, 'Invalid coupon');
  }

  const redemption = userReward.redeemedRewards.find(
    r => r.couponCode === couponCode && r.status === 'ACTIVE'
  );

  if (!redemption) {
    return ApiResponse.notFound(res, 'Invalid or expired coupon');
  }

  if (redemption.expiresAt && new Date() > redemption.expiresAt) {
    return ApiResponse.badRequest(res, 'Coupon has expired');
  }

  // Get original reward for conditions check
  const reward = await Reward.findById(redemption.rewardId);
  
  if (reward?.minBookingAmount && bookingAmount < reward.minBookingAmount) {
    return ApiResponse.badRequest(res, `Minimum booking amount is ₹${reward.minBookingAmount}`);
  }

  // Calculate discount
  let discount = redemption.value;
  if (reward?.valueType === 'PERCENTAGE') {
    discount = (bookingAmount * redemption.value) / 100;
    if (reward.maxValue) {
      discount = Math.min(discount, reward.maxValue);
    }
  }

  ApiResponse.success(res, {
    valid: true,
    discount,
    rewardName: redemption.rewardName,
  });
});

// Admin functions

/**
 * Create reward (admin)
 * POST /api/admin/rewards
 */
const createReward = asyncHandler(async (req, res) => {
  const reward = await Reward.create({
    ...req.body,
    createdBy: req.admin.id,
  });

  ApiResponse.created(res, { reward }, 'Reward created successfully');
});

/**
 * Update reward (admin)
 * PUT /api/admin/rewards/:id
 */
const updateReward = asyncHandler(async (req, res) => {
  const reward = await Reward.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true }
  );

  if (!reward) {
    return ApiResponse.notFound(res, 'Reward not found');
  }

  ApiResponse.success(res, { reward }, 'Reward updated');
});

/**
 * Delete reward (admin)
 * DELETE /api/admin/rewards/:id
 */
const deleteReward = asyncHandler(async (req, res) => {
  const reward = await Reward.findByIdAndUpdate(
    req.params.id,
    { status: 'INACTIVE' },
    { new: true }
  );

  if (!reward) {
    return ApiResponse.notFound(res, 'Reward not found');
  }

  ApiResponse.success(res, null, 'Reward deleted');
});

module.exports = {
  getUserRewards,
  getPointsHistory,
  getRewardsCatalog,
  redeemReward,
  validateCoupon,
  // Internal
  addPoints,
  addSignupBonus,
  addBookingPoints,
  addReviewPoints,
  POINTS_RULES,
  // Admin
  createReward,
  updateReward,
  deleteReward,
};
