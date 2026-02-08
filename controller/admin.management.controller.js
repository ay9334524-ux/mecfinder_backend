const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const Booking = require('../models/Booking');
const Service = require('../models/Service');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

// ==================== USER MANAGEMENT ====================

/**
 * Get all users with pagination and filters
 * GET /api/admin/users
 */
const getAllUsers = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status, search } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('-refreshTokenHash')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    User.countDocuments(filter),
  ]);

  ApiResponse.success(res, {
    users,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    },
  });
});

/**
 * Get user by ID
 * GET /api/admin/users/:id
 */
const getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('-refreshTokenHash');

  if (!user) {
    return ApiResponse.notFound(res, 'User not found');
  }

  // Get booking stats
  const [totalBookings, completedBookings] = await Promise.all([
    Booking.countDocuments({ userId: user._id }),
    Booking.countDocuments({ userId: user._id, status: 'COMPLETED' }),
  ]);

  ApiResponse.success(res, {
    user,
    stats: {
      totalBookings,
      completedBookings,
    },
  });
});

/**
 * Update user status (block/unblock)
 * PATCH /api/admin/users/:id/status
 */
const updateUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  if (!['ACTIVE', 'BANNED'].includes(status)) {
    return ApiResponse.badRequest(res, 'Invalid status. Must be ACTIVE or BANNED');
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true }
  ).select('-refreshTokenHash');

  if (!user) {
    return ApiResponse.notFound(res, 'User not found');
  }

  ApiResponse.success(res, { user }, `User ${status === 'BANNED' ? 'banned' : 'activated'} successfully`);
});

// ==================== MECHANIC MANAGEMENT ====================

/**
 * Get all mechanics with pagination and filters
 * GET /api/admin/mechanics
 */
const getAllMechanics = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status, search, isOnline } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }
  if (isOnline !== undefined) filter.isOnline = isOnline === 'true';

  const [mechanics, total] = await Promise.all([
    Mechanic.find(filter)
      .select('-refreshTokenHash -bankDetails.accountNumber')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Mechanic.countDocuments(filter),
  ]);

  // Transform to match frontend expectations
  const transformedMechanics = mechanics.map(m => ({
    _id: m._id,
    name: m.fullName,
    phone: m.phone,
    email: m.email,
    status: m.status,
    isOnline: m.isOnline,
    isAvailable: m.isAvailable,
    vehicleTypes: m.vehicleTypes || [],
    rating: m.rating,
    totalRatings: m.totalRatings,
    completedJobs: m.completedJobs,
    profileImageUrl: m.profilePhoto,
    createdAt: m.createdAt,
  }));

  ApiResponse.success(res, {
    mechanics: transformedMechanics,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    },
  });
});

/**
 * Get mechanic by ID
 * GET /api/admin/mechanics/:id
 */
const getMechanicById = asyncHandler(async (req, res) => {
  const mechanic = await Mechanic.findById(req.params.id).select('-refreshTokenHash');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  // Get booking stats
  const [totalJobs, completedJobs, totalEarnings] = await Promise.all([
    Booking.countDocuments({ mechanicId: mechanic._id }),
    Booking.countDocuments({ mechanicId: mechanic._id, status: 'COMPLETED' }),
    Booking.aggregate([
      { $match: { mechanicId: mechanic._id, status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$pricing.mechanicEarning' } } },
    ]),
  ]);

  ApiResponse.success(res, {
    mechanic,
    stats: {
      totalJobs,
      completedJobs,
      totalEarnings: totalEarnings[0]?.total || 0,
    },
  });
});

/**
 * Update mechanic status
 * PATCH /api/admin/mechanics/:id/status
 */
const updateMechanicStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  if (!['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(status)) {
    return ApiResponse.badRequest(res, 'Invalid status. Must be PENDING, APPROVED, REJECTED, or SUSPENDED');
  }

  const updateData = { status };
  if (status === 'APPROVED') {
    updateData.approvedAt = new Date();
    updateData.approvedBy = req.admin.id;
  }

  const mechanic = await Mechanic.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true }
  ).select('-refreshTokenHash');

  if (!mechanic) {
    return ApiResponse.notFound(res, 'Mechanic not found');
  }

  ApiResponse.success(res, { mechanic }, `Mechanic ${status.toLowerCase()} successfully`);
});

// ==================== BOOKING MANAGEMENT ====================

/**
 * Get all bookings with pagination and filters
 * GET /api/admin/bookings
 */
const getAllBookings = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status, paymentMethod, startDate, endDate } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (status) filter.status = status;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .populate('userId', 'name phone email')
      .populate('mechanicId', 'fullName phone email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Booking.countDocuments(filter),
  ]);

  // Transform mechanic data
  const transformedBookings = bookings.map(b => {
    const obj = b.toObject();
    if (obj.mechanicId) {
      obj.mechanicId = {
        _id: obj.mechanicId._id,
        name: obj.mechanicId.fullName,
        phone: obj.mechanicId.phone,
        email: obj.mechanicId.email,
      };
    }
    return obj;
  });

  ApiResponse.success(res, {
    bookings: transformedBookings,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    },
  });
});

/**
 * Get booking by ID
 * GET /api/admin/bookings/:id
 */
const getBookingById = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('userId', 'name phone email profileImageUrl')
    .populate('mechanicId', 'fullName phone email profilePhoto')
    .populate('serviceId');

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found');
  }

  ApiResponse.success(res, { booking });
});

/**
 * Update booking status (admin override)
 * PATCH /api/admin/bookings/:id/status
 */
const updateBookingStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;

  const validStatuses = [
    'PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED',
    'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED',
    'CANCELLED', 'EXPIRED'
  ];

  if (!validStatuses.includes(status)) {
    return ApiResponse.badRequest(res, 'Invalid status');
  }

  const updateData = {
    status,
    'adminOverride.updatedBy': req.admin.id,
    'adminOverride.updatedAt': new Date(),
    'adminOverride.reason': reason || 'Admin status update',
  };

  if (status === 'COMPLETED') {
    updateData.completedAt = new Date();
  }
  if (status === 'CANCELLED') {
    updateData.cancelledAt = new Date();
    updateData.cancelledBy = 'ADMIN';
    updateData.cancellationReason = reason || 'Cancelled by admin';
  }

  const booking = await Booking.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true }
  ).populate('userId', 'name phone').populate('mechanicId', 'fullName phone');

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found');
  }

  ApiResponse.success(res, { booking }, `Booking status updated to ${status}`);
});

// ==================== DASHBOARD STATS ====================

/**
 * Get admin dashboard stats
 * GET /api/admin/dashboard/stats
 */
const getDashboardStats = asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const [
    totalUsers,
    totalMechanics,
    approvedMechanics,
    pendingMechanics,
    totalBookings,
    activeBookings,
    completedBookings,
    todayBookings,
    monthlyRevenue,
    recentBookings,
  ] = await Promise.all([
    User.countDocuments(),
    Mechanic.countDocuments(),
    Mechanic.countDocuments({ status: 'APPROVED' }),
    Mechanic.countDocuments({ status: 'PENDING' }),
    Booking.countDocuments(),
    Booking.countDocuments({ status: { $in: ['SEARCHING', 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] } }),
    Booking.countDocuments({ status: 'COMPLETED' }),
    Booking.countDocuments({ createdAt: { $gte: today } }),
    Booking.aggregate([
      { $match: { status: 'COMPLETED', createdAt: { $gte: thisMonth } } },
      { $group: { _id: null, total: { $sum: '$pricing.totalAmount' } } },
    ]),
    Booking.find()
      .populate('userId', 'name phone')
      .populate('mechanicId', 'fullName phone')
      .sort({ createdAt: -1 })
      .limit(5),
  ]);

  ApiResponse.success(res, {
    stats: {
      users: {
        total: totalUsers,
      },
      mechanics: {
        total: totalMechanics,
        approved: approvedMechanics,
        pending: pendingMechanics,
      },
      bookings: {
        total: totalBookings,
        active: activeBookings,
        completed: completedBookings,
        today: todayBookings,
      },
      revenue: {
        thisMonth: monthlyRevenue[0]?.total || 0,
      },
    },
    recentBookings: recentBookings.map(b => ({
      id: b._id,
      bookingId: b.bookingId,
      user: b.userId?.name || 'Unknown',
      mechanic: b.mechanicId?.fullName || 'Not assigned',
      service: b.serviceSnapshot?.name || 'Unknown',
      status: b.status,
      amount: b.pricing?.totalAmount || 0,
      createdAt: b.createdAt,
    })),
  });
});

module.exports = {
  // Users
  getAllUsers,
  getUserById,
  updateUserStatus,
  // Mechanics
  getAllMechanics,
  getMechanicById,
  updateMechanicStatus,
  // Bookings
  getAllBookings,
  getBookingById,
  updateBookingStatus,
  // Dashboard
  getDashboardStats,
};
