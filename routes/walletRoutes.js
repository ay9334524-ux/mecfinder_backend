const express = require('express');
const router = express.Router();
const walletController = require('../controller/wallet.controller');
const { authenticateToken } = require('../middleware/jwt.middleware');
const { validate, walletValidations } = require('../utils/validation');
const { paymentLimiter } = require('../middleware/rateLimiter.middleware');

// All routes require authentication
router.use(authenticateToken);

// Wallet routes
router.get('/', walletController.getWallet);
router.get('/transactions', walletController.getTransactions);

// Add money (with rate limiting)
router.post('/add-money', paymentLimiter, validate(walletValidations.addMoney), walletController.addMoney);
router.post('/verify-payment', paymentLimiter, validate(walletValidations.verifyPayment), walletController.verifyPayment);

module.exports = router;
