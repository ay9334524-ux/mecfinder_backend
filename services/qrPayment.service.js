const razorpayService = require('./razorpay.service');
const redisService = require('./redis.service');
const { logger } = require('./logger.service');
const PlatformSettings = require('../models/PlatformSettings');

class QrPaymentService {
  async generateJobQR(booking, mechanic) {
    const settings = await PlatformSettings.get();
    if (!settings.qr.enabled) {
      return { success: false, error: 'QR payments disabled by admin' };
    }

    const amount = booking.pricing?.totalAmount;
    if (!amount || amount < 1) {
      return { success: false, error: 'Invalid amount for QR' };
    }

    const cacheKey = `qr:booking:${booking._id}`;
    const cached = await redisService.get(cacheKey);
    if (cached && cached.short_url) {
      return { success: true, qr: cached };
    }

    try {
      const rzp = razorpayService.getInstance();
      const qrCode = await rzp.qrCode.create({
        type: 'upi_qr',
        name: `Payment to ${mechanic.fullName || 'Mechanic'}`,
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: Math.round(amount * 100),
        description: `MecFinder Service - ${booking.bookingId}`,
        customer_id: '',
        close_by: Math.floor(Date.now() / 1000) + (settings.qr.expiryMinutes * 60),
        notes: {
          bookingId: booking._id.toString(),
          mechanicId: mechanic._id.toString(),
          purpose: 'JOB_PAYMENT',
        },
      });

      const qrData = {
        id: qrCode.id,
        image_url: qrCode.image_url,
        short_url: qrCode.short_url,
        amount: amount,
        status: qrCode.status,
        close_by: qrCode.close_by,
      };

      await redisService.set(cacheKey, qrData, settings.qr.expiryMinutes * 60);

      logger.info(`[QR] Generated for booking ${booking._id}, amount ₹${amount}`);
      return { success: true, qr: qrData };
    } catch (error) {
      logger.error(`[QR] Generation failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new QrPaymentService();
