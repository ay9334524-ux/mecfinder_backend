const express = require('express');
const router = express.Router();
const publicController = require('../controller/public.controller');
const bannerController = require('../controller/banner.controller');

router.get('/payment-config', publicController.getPaymentConfig);
router.get('/banners', bannerController.listActiveBanners);

module.exports = router;
