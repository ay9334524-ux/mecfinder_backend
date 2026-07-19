const express = require('express');
const { authenticateToken } = require('../middleware/jwt.middleware');
const {
  createCoupon,
  getAllCoupons,
  getCouponById,
  updateCoupon,
  expireCoupon,
  deleteCoupon,
  validateCoupon,
  applyCouponToBooking,
  getAvailableCoupons,
} = require('../controller/coupon.controller');

const router = express.Router();

// All coupon routes require authentication
router.use(authenticateToken);

// User routes (must come before admin routes to avoid conflicts)
router.get('/available', getAvailableCoupons);
router.post('/validate', validateCoupon);
router.post('/apply/:bookingId', applyCouponToBooking);

// Admin routes
router.post('/admin/coupons', createCoupon);
router.get('/admin/coupons', getAllCoupons);
router.get('/admin/coupons/:id', getCouponById);
router.put('/admin/coupons/:id', updateCoupon);
router.patch('/admin/coupons/:id/expire', expireCoupon);
router.delete('/admin/coupons/:id', deleteCoupon);

module.exports = router;
