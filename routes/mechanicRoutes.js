const express = require('express');
const router = express.Router();
const mechanicController = require('../controller/mechanic.controller');
const earningsController = require('../controller/earnings.controller');
const bookingController = require('../controller/booking.controller');
const { authenticateToken, requireMechanic } = require('../middleware/jwt.middleware');
const { uploadImage, uploadDocument, handleMulterError } = require('../middleware/upload.middleware');
const { validate, mechanicValidations } = require('../utils/validation');
const { uploadLimiter } = require('../middleware/rateLimiter.middleware');

// All routes require mechanic authentication
router.use(authenticateToken);
router.use(requireMechanic);

// Profile routes
router.get('/profile', mechanicController.getProfile);
router.put('/profile', validate(mechanicValidations.updateProfile), mechanicController.updateProfile);
router.post('/photo', uploadLimiter, uploadImage.single('photo'), handleMulterError, mechanicController.uploadPhoto);
router.get('/stats', mechanicController.getStats);
router.get('/stats/today', mechanicController.getTodayStats);

// Bank details
router.get('/bank-details', mechanicController.getBankDetails);
router.put('/bank-details', validate(mechanicValidations.updateBankDetails), mechanicController.updateBankDetails);

// Documents/KYC
router.get('/documents', mechanicController.getDocuments);
router.post('/document', uploadLimiter, uploadDocument.single('document'), handleMulterError, mechanicController.uploadDocument);

// Location & Online status
router.put('/location', validate(mechanicValidations.updateLocation), mechanicController.updateLocation);
router.post('/toggle-online', mechanicController.toggleOnline);

// Earnings
router.get('/earnings', earningsController.getEarningsOverview);
router.get('/earnings/history', earningsController.getEarningsHistory);
router.get('/earnings/weekly', earningsController.getWeeklyEarnings);
router.post('/earnings/payout', validate(mechanicValidations.requestPayout), earningsController.requestPayout);
router.get('/earnings/payouts', earningsController.getPayoutHistory);
router.get('/earnings/payout/:id', earningsController.getPayoutDetails);

// Wallet & Withdrawals
router.get('/wallet', mechanicController.getWallet);
router.post('/withdraw', mechanicController.requestWithdrawal);
router.get('/withdrawals', mechanicController.getWithdrawals);

// FCM Token for Push Notifications
router.post('/fcm-token', mechanicController.updateFcmToken);
router.delete('/fcm-token', mechanicController.clearFcmToken);

// Jobs
router.get('/jobs', bookingController.getMechanicJobs);
router.get('/bookings/current', bookingController.getCurrentBooking);
router.get('/bookings/history', bookingController.getMechanicBookingHistory);
router.post('/job/:id/accept', bookingController.acceptJob);
router.put('/job/:id/status', bookingController.updateJobStatus);
router.post('/job/:id/confirm-payment', bookingController.confirmPayment);
router.post('/job/:id/reject', bookingController.rejectJob);
router.post('/job/:id/cancel', bookingController.cancelJobByMechanic);

// Account
router.delete('/account', mechanicController.deleteAccount);

module.exports = router;
