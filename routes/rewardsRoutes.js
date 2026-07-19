const express = require('express');
const router = express.Router();
const rewardsController = require('../controller/rewards.controller');
const { authenticateToken } = require('../middleware/jwt.middleware');
const { validate, rewardsValidations } = require('../utils/validation');

// All routes require authentication
router.use(authenticateToken);

// Rewards routes
router.get('/', rewardsController.getUserRewards);
router.get('/history', rewardsController.getPointsHistory);
router.get('/catalog', rewardsController.getRewardsCatalog);
router.post('/redeem', validate(rewardsValidations.redeemReward), rewardsController.redeemReward);
router.post('/validate-coupon', validate(rewardsValidations.validateCoupon), rewardsController.validateCoupon);

module.exports = router;
