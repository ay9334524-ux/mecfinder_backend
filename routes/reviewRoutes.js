const express = require('express');
const {
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
} = require('../controller/review.controller');
const { authMiddleware, requireRole } = require('../middleware/auth.middleware');

const router = express.Router();

// User routes (authenticated users can submit reviews)
router.post('/create', authMiddleware, createReview);

// Public routes (can be accessed by authenticated users)
router.get('/mechanic/:mechanicId', getReviewsByMechanic);
router.get('/service/:serviceId', getReviewsByService);
router.get('/statistics', getReviewStatistics);

// Admin routes (protected with auth + role check)
router.get('/admin/all', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), getAllReviews);
router.get('/admin/booking-ratings', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), getBookingRatings);
router.get('/admin/:reviewId', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), getReviewDetails);
router.get('/admin/pending/count', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), getPendingReviewsCount);

router.patch('/admin/:reviewId/approve', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), approveReview);
router.patch('/admin/:reviewId/reject', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), rejectReview);
router.patch('/admin/:reviewId/flag', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), flagReview);
router.patch('/admin/:reviewId/respond', authMiddleware, requireRole('ADMIN', 'SUPER_ADMIN'), respondToReview);

module.exports = router;
