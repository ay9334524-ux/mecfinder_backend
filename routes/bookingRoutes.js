const express = require('express');
const router = express.Router();
const bookingController = require('../controller/booking.controller');
const { authenticateToken } = require('../middleware/jwt.middleware');
const { validate, bookingValidations } = require('../utils/validation');
const { bookingLimiter, paymentLimiter } = require('../middleware/rateLimiter.middleware');

// All routes require user authentication
router.use(authenticateToken);

// Booking routes
router.post('/', bookingLimiter, validate(bookingValidations.create), bookingController.createBooking);
router.get('/', bookingController.getUserBookings);
router.get('/history', bookingController.getBookingHistory);
router.get('/:id', bookingController.getBookingDetails);
router.post('/:id/cancel', bookingController.cancelBooking);
router.post('/:id/rate', validate(bookingValidations.rate), bookingController.rateBooking);

// Payment routes
router.post('/:id/pay', paymentLimiter, bookingController.createBookingPaymentOrder);
router.post('/:id/verify-payment', paymentLimiter, bookingController.verifyBookingPayment);
router.post('/:id/pay-wallet', paymentLimiter, bookingController.payWithWallet);

module.exports = router;
