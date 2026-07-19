const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Public payment configuration
 * GET /api/public/payment-config
 */
const getPaymentConfig = asyncHandler(async (req, res) => {
  ApiResponse.success(res, {
    razorpayPaymentPageUrl:
      (process.env.RAZORPAY_PAYMENT_PAGE_URL || 'https://razorpay.me/@mecfinders').trim(),
    companyUpiId: (process.env.COMPANY_UPI_ID || '').trim(),
  });
});

module.exports = {
  getPaymentConfig,
};
