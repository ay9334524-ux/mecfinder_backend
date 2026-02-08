const express = require('express');
const router = express.Router();
const referralController = require('../controller/referral.controller');
const { authenticateToken } = require('../middleware/jwt.middleware');
const { validate, referralValidations } = require('../utils/validation');

// All routes require authentication
router.use(authenticateToken);

// Referral routes
router.get('/', referralController.getReferralDetails);
router.post('/apply', validate(referralValidations.applyCode), referralController.applyReferralCode);
router.get('/leaderboard', referralController.getLeaderboard);

module.exports = router;
