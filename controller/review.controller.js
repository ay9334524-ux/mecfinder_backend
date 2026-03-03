const Review = require('../models/Review');
const Booking = require('../models/Booking');
const { asyncHandler } = require('../middleware/error.middleware');
const ApiResponse = require('../utils/apiResponse');

// Create a new review (user submitting review for completed booking)
const createReview = asyncHandler(async (req, res) => {
  const { bookingId, rating, title, description, ratingBreakdown, images } = req.body;

  // Validate required fields
  if (!bookingId || !rating || !title) {
    return ApiResponse.error(res, 'bookingId, rating, and title are required', 400);
  }

  // Validate rating
  if (rating < 1 || rating > 5) {
    return ApiResponse.error(res, 'Rating must be between 1 and 5', 400);
  }

  // Check if booking exists and is completed
  const booking = await Booking.findById(bookingId).populate('userId mechanicId serviceId');
  if (!booking) {
    return ApiResponse.error(res, 'Booking not found', 404);
  }

  if (booking.status !== 'COMPLETED') {
    return ApiResponse.error(res, 'Can only review completed bookings', 400);
  }

  // Check if review already exists for this booking
  const existingReview = await Review.findOne({ bookingId });
  if (existingReview) {
    return ApiResponse.error(res, 'Review already exists for this booking', 400);
  }

  // Create review
  const review = new Review({
    bookingId,
    userId: booking.userId._id,
    mechanicId: booking.mechanicId,
    serviceId: booking.serviceId._id,
    rating,
    title,
    description,
    ratingBreakdown: ratingBreakdown || {},
    images: images || [],
    status: 'PENDING', // Reviews are pending approval by admin
  });

  await review.save();

  // Populate the review data
  await review.populate('userId mechanicId serviceId bookingId');

  ApiResponse.success(res, review, 'Review submitted successfully. Pending admin approval.', 201);
});

// Get all reviews (admin)
const getAllReviews = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    status = '',
    rating = '',
    sortBy = 'createdAt',
    order = '-1',
  } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (rating) filter.rating = parseInt(rating);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sortObj = { [sortBy]: parseInt(order) };

  const reviews = await Review.find(filter)
    .populate('userId', 'name email phoneNumber avatar')
    .populate('mechanicId', 'fullName email phone avatar expertise')
    .populate('serviceId', 'name categoryName icon')
    .populate('bookingId', 'bookingId status')
    .sort(sortObj)
    .skip(skip)
    .limit(parseInt(limit));

  const total = await Review.countDocuments(filter);

  ApiResponse.success(
    res,
    {
      reviews,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    'Reviews retrieved successfully'
  );
});

// Get review details
const getReviewDetails = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;

  const review = await Review.findById(reviewId)
    .populate('userId', 'name email phoneNumber avatar')
    .populate('mechanicId', 'fullName email phone avatar expertise')
    .populate('serviceId', 'name categoryName icon')
    .populate('bookingId')
    .populate('adminResponse.respondedBy', 'name email');

  if (!review) {
    return ApiResponse.error(res, 'Review not found', 404);
  }

  ApiResponse.success(res, review, 'Review details retrieved successfully');
});

// Get reviews by mechanic
const getReviewsByMechanic = asyncHandler(async (req, res) => {
  const { mechanicId } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const reviews = await Review.find({
    mechanicId,
    status: 'APPROVED',
  })
    .populate('userId', 'name avatar')
    .populate('serviceId', 'name')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const total = await Review.countDocuments({
    mechanicId,
    status: 'APPROVED',
  });

  // Calculate average rating and breakdown
  const stats = await Review.aggregate([
    { $match: { mechanicId: require('mongoose').Types.ObjectId(mechanicId), status: 'APPROVED' } },
    {
      $group: {
        _id: null,
        averageRating: { $avg: '$rating' },
        totalReviews: { $sum: 1 },
        avgWorkQuality: { $avg: '$ratingBreakdown.workQuality' },
        avgTimelinessAndPunctuality: { $avg: '$ratingBreakdown.timelinessAndPunctuality' },
        avgProfessionalism: { $avg: '$ratingBreakdown.professionalism' },
        avgCommunication: { $avg: '$ratingBreakdown.communication' },
      },
    },
  ]);

  ApiResponse.success(
    res,
    {
      reviews,
      stats: stats[0] || {},
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    'Mechanic reviews retrieved successfully'
  );
});

// Get reviews by service
const getReviewsByService = asyncHandler(async (req, res) => {
  const { serviceId } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const reviews = await Review.find({
    serviceId,
    status: 'APPROVED',
  })
    .populate('userId', 'name avatar')
    .populate('mechanicId', 'fullName avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const total = await Review.countDocuments({
    serviceId,
    status: 'APPROVED',
  });

  // Calculate average rating
  const stats = await Review.aggregate([
    { $match: { serviceId: require('mongoose').Types.ObjectId(serviceId), status: 'APPROVED' } },
    {
      $group: {
        _id: null,
        averageRating: { $avg: '$rating' },
        totalReviews: { $sum: 1 },
        ratingDistribution: {
          $push: '$rating',
        },
      },
    },
  ]);

  ApiResponse.success(
    res,
    {
      reviews,
      stats: stats[0] || {},
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    'Service reviews retrieved successfully'
  );
});

// Approve review
const approveReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;

  const review = await Review.findByIdAndUpdate(
    reviewId,
    {
      status: 'APPROVED',
      adminResponse: {
        message: 'Review approved',
        respondedAt: new Date(),
        respondedBy: req.admin._id,
      },
    },
    { new: true }
  );

  if (!review) {
    return ApiResponse.error(res, 'Review not found', 404);
  }

  ApiResponse.success(res, review, 'Review approved successfully');
});

// Reject review
const rejectReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return ApiResponse.error(res, 'Rejection reason is required', 400);
  }

  const review = await Review.findByIdAndUpdate(
    reviewId,
    {
      status: 'REJECTED',
      adminResponse: {
        message: reason,
        respondedAt: new Date(),
        respondedBy: req.admin._id,
      },
    },
    { new: true }
  );

  if (!review) {
    return ApiResponse.error(res, 'Review not found', 404);
  }

  ApiResponse.success(res, review, 'Review rejected successfully');
});

// Flag/Unflag review
const flagReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const { flagged, reason } = req.body;

  const review = await Review.findByIdAndUpdate(
    reviewId,
    {
      flagged,
      flagReason: flagged ? reason : undefined,
      flaggedAt: flagged ? new Date() : undefined,
    },
    { new: true }
  );

  if (!review) {
    return ApiResponse.error(res, 'Review not found', 404);
  }

  ApiResponse.success(res, review, 'Review flag status updated successfully');
});

// Respond to review (admin response)
const respondToReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const { message } = req.body;

  if (!message) {
    return ApiResponse.error(res, 'Response message is required', 400);
  }

  const review = await Review.findByIdAndUpdate(
    reviewId,
    {
      adminResponse: {
        message,
        respondedAt: new Date(),
        respondedBy: req.admin._id,
      },
    },
    { new: true }
  ).populate('adminResponse.respondedBy', 'name email');

  if (!review) {
    return ApiResponse.error(res, 'Review not found', 404);
  }

  ApiResponse.success(res, review, 'Response added successfully');
});

// Get review statistics
const getReviewStatistics = asyncHandler(async (req, res) => {
  const { mechanicId, serviceId } = req.query;

  const matchStage = { status: 'APPROVED' };
  if (mechanicId) matchStage.mechanicId = require('mongoose').Types.ObjectId(mechanicId);
  if (serviceId) matchStage.serviceId = require('mongoose').Types.ObjectId(serviceId);

  const stats = await Review.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalReviews: { $sum: 1 },
        averageRating: { $avg: '$rating' },
        ratingCounts: {
          $push: {
            k: { $toString: '$rating' },
            v: 1,
          },
        },
        avgWorkQuality: { $avg: '$ratingBreakdown.workQuality' },
        avgTimelinessAndPunctuality: { $avg: '$ratingBreakdown.timelinessAndPunctuality' },
        avgProfessionalism: { $avg: '$ratingBreakdown.professionalism' },
        avgCommunication: { $avg: '$ratingBreakdown.communication' },
      },
    },
    {
      $addFields: {
        ratingDistribution: {
          $arrayToObject: '$ratingCounts',
        },
      },
    },
    {
      $project: {
        ratingCounts: 0,
      },
    },
  ]);

  ApiResponse.success(
    res,
    stats[0] || {
      totalReviews: 0,
      averageRating: 0,
      ratingDistribution: {},
      avgWorkQuality: 0,
      avgTimelinessAndPunctuality: 0,
      avgProfessionalism: 0,
      avgCommunication: 0,
    },
    'Review statistics retrieved successfully'
  );
});

// Get pending reviews count
const getPendingReviewsCount = asyncHandler(async (req, res) => {
  const count = await Review.countDocuments({ status: 'PENDING' });
  ApiResponse.success(res, { count }, 'Pending reviews count retrieved successfully');
});

// Get all booking ratings & feedback (real data from completed bookings)
const getBookingRatings = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    rating = '',
    sortBy = 'ratedAt',
    order = '-1',
  } = req.query;

  const filter = { rating: { $exists: true, $ne: null }, status: 'COMPLETED' };
  if (rating) filter.rating = parseInt(rating);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sortObj = { [sortBy]: parseInt(order) };

  const bookings = await Booking.find(filter)
    .populate('userId', 'name email phoneNumber avatar')
    .populate('mechanicId', 'fullName email phone avatar')
    .populate('serviceId', 'name categoryName icon')
    .sort(sortObj)
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

  const total = await Booking.countDocuments(filter);

  // Compute stats
  const stats = await Booking.aggregate([
    { $match: { rating: { $exists: true, $ne: null }, status: 'COMPLETED' } },
    {
      $group: {
        _id: null,
        totalRatings: { $sum: 1 },
        averageRating: { $avg: '$rating' },
        fiveStar: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
        fourStar: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
        threeStar: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
        twoStar: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
        oneStar: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
      },
    },
  ]);

  ApiResponse.success(
    res,
    {
      ratings: bookings,
      stats: stats[0] || { totalRatings: 0, averageRating: 0, fiveStar: 0, fourStar: 0, threeStar: 0, twoStar: 0, oneStar: 0 },
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    },
    'Booking ratings retrieved successfully'
  );
});

module.exports = {
  createReview,
  getAllReviews,
  getBookingRatings,
  getReviewDetails,
  getReviewsByMechanic,
  getReviewsByService,
  approveReview,
  rejectReview,
  flagReview,
  respondToReview,
  getReviewStatistics,
  getPendingReviewsCount,
};
