const express = require('express');
const router = express.Router();
const mechanicController = require('../controller/mechanic.controller');
const earningsController = require('../controller/earnings.controller');
const mechanicWalletController = require('../controller/mechanic.wallet.controller');
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
router.put('/bank-details/upi', validate(mechanicValidations.updatePayoutUpi), mechanicController.updatePayoutUpi);

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

// 💰 Cashflow Settlement — Wallet, Debt & Withdrawals
router.get('/wallet/summary', mechanicWalletController.getWalletSummary);
router.get('/wallet/sync-debt', mechanicWalletController.syncDebtStatus);
router.get('/wallet/transactions', mechanicWalletController.getWalletTransactions);
router.post('/wallet/withdraw', mechanicWalletController.withdrawWallet);
router.get('/wallet/test', mechanicWalletController.getTestWallet);
router.get('/debt/details', mechanicWalletController.getDebtDetails);
router.post('/wallet/clear-debt', mechanicWalletController.createDebtClearanceOrder);
router.post('/wallet/fine-payment-link', mechanicWalletController.generateFinePaymentLink);
router.post('/wallet/auto-clear-debt', mechanicWalletController.autoClearDebt);
router.post('/wallet/verify-debt-payment', mechanicWalletController.verifyDebtClearancePayment);

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
router.post('/job/:id/payment-link', bookingController.generateJobPaymentLink);
router.post('/job/:id/generate-qr', bookingController.generateJobPaymentLink);
router.get('/job/:id/payment-status', bookingController.getJobPaymentStatus);
router.get('/cash-status', mechanicWalletController.getCashStatus);
router.post('/job/:id/reject', bookingController.rejectJob);
router.post('/job/:id/cancel', bookingController.cancelJobByMechanic);

// Account
router.delete('/account', mechanicController.deleteAccount);

module.exports = router;
