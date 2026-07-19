const express = require('express');
const { handleRazorpayWebhook } = require('../controller/webhook.controller');

const router = express.Router();

router.post('/razorpay', express.raw({ type: 'application/json' }), handleRazorpayWebhook);

module.exports = router;
