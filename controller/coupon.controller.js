const Coupon = require('../models/Coupon');
const Booking = require('../models/Booking');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

// ==================== ADMIN COUPON MANAGEMENT ====================

/**
 * Create a new coupon
 * POST /api/admin/coupons
 */
const createCoupon = asyncHandler(async (req, res) => {
  const { code, description, discountType, discountValue, maxUsagePerUser, maxTotalUsage, minOrderAmount, maxDiscountAmount, expiresAt } = req.body;

  // Validate input
  if (!code || !discountType || !discountValue || !expiresAt) {
    return ApiResponse.error(res, 'Code, discount type, discount value, and expiry date are required', 400);
  }

  // Check if coupon already exists
  const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
  if (existingCoupon) {
    return ApiResponse.error(res, 'Coupon code already exists', 400);
  }

  // Validate discount type
  if (!['FIXED', 'PERCENTAGE'].includes(discountType)) {
    return ApiResponse.error(res, 'Discount type must be FIXED or PERCENTAGE', 400);
  }

  // For percentage, discount should be 0-100
  if (discountType === 'PERCENTAGE' && (discountValue < 0 || discountValue > 100)) {
    return ApiResponse.error(res, 'Percentage discount must be between 0 and 100', 400);
  }

  const coupon = new Coupon({
    code: code.toUpperCase(),
    description,
    discountType,
    discountValue,
    maxUsagePerUser: maxUsagePerUser || 1,
    maxTotalUsage: maxTotalUsage || null,
    minOrderAmount: minOrderAmount || 0,
    maxDiscountAmount: maxDiscountAmount || null,
    expiresAt: new Date(expiresAt),
    createdBy: req.user.adminId || req.user.id || req.adminId,
  });

  await coupon.save();

  ApiResponse.success(res, {
    message: 'Coupon created successfully',
    coupon,
  }, 201);
});

/**
 * Get all coupons
 * GET /api/admin/coupons
 */
const getAllCoupons = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status, search } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (status === 'active') filter.isActive = true;
  if (status === 'expired') filter.expiresAt = { $lt: new Date() };
  if (search) filter.code = { $regex: search, $options: 'i' };

  const [coupons, total] = await Promise.all([
    Coupon.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Coupon.countDocuments(filter),
  ]);

  ApiResponse.success(res, {
    coupons,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    },
  });
});

/**
 * Get coupon by ID
 * GET /api/admin/coupons/:id
 */
const getCouponById = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findById(req.params.id).populate('usageLog.userId', 'name phone').populate('usageLog.bookingId', 'bookingId status');

  if (!coupon) {
    return ApiResponse.error(res, 'Coupon not found', 404);
  }

  ApiResponse.success(res, { coupon });
});

/**
 * Update coupon
 * PUT /api/admin/coupons/:id
 */
const updateCoupon = asyncHandler(async (req, res) => {
  const { description, maxUsagePerUser, maxTotalUsage, minOrderAmount, maxDiscountAmount, isActive } = req.body;

  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) {
    return ApiResponse.error(res, 'Coupon not found', 404);
  }

  // Can't update discount value or type after creation
  if (req.body.discountValue || req.body.discountType) {
    return ApiResponse.error(res, 'Cannot update discount value or type', 400);
  }

  if (description !== undefined) coupon.description = description;
  if (maxUsagePerUser !== undefined) coupon.maxUsagePerUser = maxUsagePerUser;
  if (maxTotalUsage !== undefined) coupon.maxTotalUsage = maxTotalUsage;
  if (minOrderAmount !== undefined) coupon.minOrderAmount = minOrderAmount;
  if (maxDiscountAmount !== undefined) coupon.maxDiscountAmount = maxDiscountAmount;
  if (isActive !== undefined) coupon.isActive = isActive;

  await coupon.save();

  ApiResponse.success(res, {
    message: 'Coupon updated successfully',
    coupon,
  });
});

/**
 * Forcefully expire a coupon
 * PATCH /api/admin/coupons/:id/expire
 */
const expireCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findByIdAndUpdate(
    req.params.id,
    { expiresAt: new Date(), isActive: false },
    { new: true }
  );

  if (!coupon) {
    return ApiResponse.error(res, 'Coupon not found', 404);
  }

  ApiResponse.success(res, {
    message: 'Coupon expired successfully',
    coupon,
  });
});

/**
 * Delete coupon
 * DELETE /api/admin/coupons/:id
 */
const deleteCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findByIdAndDelete(req.params.id);

  if (!coupon) {
    return ApiResponse.error(res, 'Coupon not found', 404);
  }

  ApiResponse.success(res, {
    message: 'Coupon deleted successfully',
  });
});

// ==================== USER COUPON VALIDATION ====================

/**
 * Validate and apply coupon
 * POST /api/coupons/validate
 */
const validateCoupon = asyncHandler(async (req, res) => {
  const { code, orderAmount } = req.body;
  const userId = req.userId;

  if (!code || !orderAmount) {
    return ApiResponse.error(res, 'Code and order amount are required', 400);
  }

  const coupon = await Coupon.findOne({ code: code.toUpperCase() });

  // Coupon not found
  if (!coupon) {
    return ApiResponse.error(res, 'Invalid coupon code', 404);
  }

  // Log for debugging
  console.log(`Validating coupon: ${code}`, {
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    isActive: coupon.isActive,
    expiresAt: coupon.expiresAt,
  });

  // Coupon is not active
  if (!coupon.isActive) {
    return ApiResponse.error(res, 'Coupon is no longer active', 400);
  }

  // Check if expired
  if (new Date() > coupon.expiresAt) {
    return ApiResponse.error(res, 'Coupon has expired', 400);
  }

  // Check minimum order amount
  if (orderAmount < coupon.minOrderAmount) {
    return ApiResponse.error(res, `Minimum order amount is ₹${coupon.minOrderAmount}`, 400);
  }

  // Check if user has reached max usage limit
  const userUsageCount = coupon.usageLog.filter(log => log.userId.toString() === userId.toString()).length;
  if (userUsageCount >= coupon.maxUsagePerUser) {
    return ApiResponse.error(res, `You have reached the maximum usage limit for this coupon (${coupon.maxUsagePerUser} times)`, 400);
  }

  // Check if coupon has reached max total usage
  if (coupon.maxTotalUsage && coupon.currentUsage >= coupon.maxTotalUsage) {
    return ApiResponse.error(res, 'Coupon usage limit reached', 400);
  }

  // Calculate discount
  let discountAmount = 0;
  if (coupon.discountType === 'FIXED') {
    discountAmount = coupon.discountValue;
  } else if (coupon.discountType === 'PERCENTAGE') {
    discountAmount = (orderAmount * coupon.discountValue) / 100;
  }

  console.log(`Discount calculation for ${code}:`, {
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    orderAmount,
    calculatedDiscount: discountAmount,
  });

  // Apply max discount cap if set
  if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
    console.log(`Applied max discount cap: ${coupon.maxDiscountAmount}`);
    discountAmount = coupon.maxDiscountAmount;
  }

  // Make sure discount doesn't exceed order amount
  if (discountAmount > orderAmount) {
    console.log(`Discount exceeds order amount, capping at ${orderAmount}`);
    discountAmount = orderAmount;
  }

  console.log(`Final discount for ${code}: ${discountAmount}`);

  ApiResponse.success(res, {
    discountAmount: discountAmount,
    discountType: coupon.discountType,
    code: coupon.code,
    couponId: coupon._id,
  });
});

/**
 * Apply coupon to booking
 * This is called after booking is created
 * POST /api/coupons/apply/:bookingId
 */
const applyCouponToBooking = asyncHandler(async (req, res) => {
  const { couponCode } = req.body;
  const { bookingId } = req.params;
  const userId = req.userId;

  if (!couponCode) {
    return ApiResponse.error(res, 'Coupon code is required', 400);
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return ApiResponse.error(res, 'Booking not found', 404);
  }

  if (booking.userId.toString() !== userId.toString()) {
    return ApiResponse.error(res, 'Unauthorized', 403);
  }

  const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });
  if (!coupon) {
    return ApiResponse.error(res, 'Invalid coupon code', 404);
  }

  if (!coupon.isActive || new Date() > coupon.expiresAt) {
    return ApiResponse.error(res, 'Coupon is not valid', 400);
  }

  // Check usage limits
  const userUsageCount = coupon.usageLog.filter(log => log.userId.toString() === userId.toString()).length;
  if (userUsageCount >= coupon.maxUsagePerUser) {
    return ApiResponse.error(res, 'You have reached the usage limit for this coupon', 400);
  }

  if (coupon.maxTotalUsage && coupon.currentUsage >= coupon.maxTotalUsage) {
    return ApiResponse.error(res, 'Coupon limit reached', 400);
  }

  // Calculate discount
  const orderAmount = booking.pricing?.totalAmount || 0;
  let discountAmount = 0;

  if (coupon.discountType === 'FIXED') {
    discountAmount = coupon.discountValue;
  } else if (coupon.discountType === 'PERCENTAGE') {
    discountAmount = (orderAmount * coupon.discountValue) / 100;
  }

  if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
    discountAmount = coupon.maxDiscountAmount;
  }

  if (discountAmount > orderAmount) {
    discountAmount = orderAmount;
  }

  // Apply discount to booking
  booking.couponCode = coupon._id;
  booking.discountAmount = discountAmount;
  booking.pricing.totalAmount -= discountAmount;

  // Log coupon usage
  coupon.usageLog.push({
    userId,
    bookingId,
    discountGiven: discountAmount,
  });
  coupon.currentUsage += 1;

  await Promise.all([booking.save(), coupon.save()]);

  ApiResponse.success(res, {
    message: 'Coupon applied successfully',
    discount: {
      amount: discountAmount,
      newTotal: booking.pricing.totalAmount,
    },
  });
});

/**
 * Get available coupons for users
 * GET /api/coupons/available
 */
const getAvailableCoupons = asyncHandler(async (req, res) => {
  const now = new Date();

  // Find all active, non-expired coupons
  const coupons = await Coupon.find({
    isActive: true,
    validFrom: { $lte: now },
    expiresAt: { $gte: now },
  })
    .select('code description discountType discountValue minOrderAmount maxDiscountAmount expiresAt')
    .sort({ createdAt: -1 })
    .limit(50);

  // Format coupons for frontend
  const formattedCoupons = coupons.map(coupon => ({
    code: coupon.code,
    description: coupon.description,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discount: coupon.discountType === 'PERCENTAGE' ? coupon.discountValue : 0,
    minAmount: coupon.minOrderAmount,
    maxDiscount: coupon.maxDiscountAmount,
    expiryDate: coupon.expiresAt.toISOString(),
  }));

  ApiResponse.success(res, formattedCoupons, 'Available coupons retrieved successfully');
});

module.exports = {
  // Admin
  createCoupon,
  getAllCoupons,
  getCouponById,
  updateCoupon,
  expireCoupon,
  deleteCoupon,
  // User
  validateCoupon,
  applyCouponToBooking,
  getAvailableCoupons,
};
