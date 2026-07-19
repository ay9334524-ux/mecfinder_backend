const Notification = require('../models/Notification');

/**
 * Notification Service - Handles all notification creation and sending
 * Sends notifications for all booking events, user milestones, and system events
 */
class NotificationService {
  /**
   * Send welcome notification to new user
   */
  static async sendWelcomeNotification(userId) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'SYSTEM',
      priority: 'HIGH',
      title: '🎉 Welcome to MecFinder!',
      body: 'Get your vehicle serviced by professional mechanics at your doorstep. Get ₹100 welcome bonus to use on your first booking!',
      imageUrl: 'https://via.placeholder.com/300?text=Welcome',
      data: {
        action: 'WELCOME',
        bonus: 100,
      },
    });
  }

  /**
   * Send booking confirmation notification
   */
  static async sendBookingConfirmationNotification(userId, booking) {
    const bookingDate = new Date(booking.scheduledDate).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'BOOKING',
      priority: 'HIGH',
      title: '✅ Booking Confirmed',
      body: `Your ${booking.service.name} service is scheduled for ${bookingDate}. Mechanic will arrive soon!`,
      imageUrl: booking.service.imageUrl,
      data: {
        action: 'BOOKING_CONFIRMED',
        bookingId: booking._id,
        serviceName: booking.service.name,
      },
      actionUrl: `/booking/${booking._id}`,
    });
  }

  /**
   * Send mechanic assigned notification
   */
  static async sendMechanicAssignedNotification(userId, booking, mechanic) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'BOOKING',
      priority: 'HIGH',
      title: '🔧 Mechanic Assigned',
      body: `${mechanic.name} has been assigned to your service. Rating: ${mechanic.rating}/5 ⭐`,
      imageUrl: mechanic.profileImage,
      data: {
        action: 'MECHANIC_ASSIGNED',
        bookingId: booking._id,
        mechanicId: mechanic._id,
        mechanicName: mechanic.name,
        mechanicPhone: mechanic.phone,
      },
      actionUrl: `/booking/${booking._id}/mechanic`,
    });
  }

  /**
   * Send service started notification
   */
  static async sendServiceStartedNotification(userId, booking, mechanic) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'BOOKING',
      priority: 'NORMAL',
      title: '🚗 Service Started',
      body: `${mechanic.name} has started working on your ${booking.service.name}. Estimated time: ${booking.estimatedDuration || '1 hour'}`,
      data: {
        action: 'SERVICE_STARTED',
        bookingId: booking._id,
        mechanicId: mechanic._id,
        estimatedEndTime: booking.estimatedEndTime,
      },
      actionUrl: `/booking/${booking._id}/live`,
    });
  }

  /**
   * Send service in progress notification (every 30 mins if needed)
   */
  static async sendServiceInProgressNotification(userId, booking, mechanic, progress = 50) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'BOOKING',
      priority: 'NORMAL',
      title: '⏳ Service in Progress',
      body: `${mechanic.name} is working on your service. Progress: ${progress}% complete.`,
      data: {
        action: 'SERVICE_IN_PROGRESS',
        bookingId: booking._id,
        progress,
      },
      actionUrl: `/booking/${booking._id}/live`,
    });
  }

  /**
   * Send service completed notification
   */
  static async sendServiceCompletedNotification(userId, booking, mechanic) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'BOOKING',
      priority: 'HIGH',
      title: '✨ Service Completed',
      body: `Great! ${mechanic.name} has completed your ${booking.service.name} service. Total cost: ₹${booking.pricing.totalAmount}. Please proceed to payment.`,
      data: {
        action: 'SERVICE_COMPLETED',
        bookingId: booking._id,
        totalAmount: booking.pricing.totalAmount,
      },
      actionUrl: `/booking/${booking._id}/payment`,
    });
  }

  /**
   * Send payment reminder notification
   */
  static async sendPaymentReminderNotification(userId, booking) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'PAYMENT',
      priority: 'HIGH',
      title: '💳 Complete Payment',
      body: `Please complete the payment for your service. Amount: ₹${booking.pricing.totalAmount}. Complete in 30 minutes to avoid cancellation.`,
      data: {
        action: 'PAYMENT_PENDING',
        bookingId: booking._id,
        amount: booking.pricing.totalAmount,
      },
      actionUrl: `/booking/${booking._id}/payment`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // Expires in 30 mins
    });
  }

  /**
   * Send payment successful notification
   */
  static async sendPaymentSuccessNotification(userId, booking, transactionId) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'PAYMENT',
      priority: 'NORMAL',
      title: '✅ Payment Successful',
      body: `Payment of ₹${booking.pricing.totalAmount} received. Transaction ID: ${transactionId}. Thank you for using MecFinder!`,
      data: {
        action: 'PAYMENT_SUCCESS',
        bookingId: booking._id,
        transactionId,
        amount: booking.pricing.totalAmount,
      },
      actionUrl: `/booking/${booking._id}/receipt`,
    });
  }

  /**
   * Send booking cancellation notification
   */
  static async sendBookingCancelledNotification(userId, booking, reason = 'Cancelled by user') {
    let title = '❌ Booking Cancelled';
    let priority = 'NORMAL';

    if (reason.includes('mechanic')) {
      title = '⚠️ Booking Cancelled by Mechanic';
      priority = 'HIGH';
    } else if (reason.includes('payment')) {
      title = '❌ Booking Cancelled - Payment Failed';
      priority = 'HIGH';
    }

    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'BOOKING',
      priority,
      title,
      body: `Your booking for ${booking.service.name} has been cancelled. Reason: ${reason}. Amount refunded: ₹${booking.pricing.totalAmount}`,
      data: {
        action: 'BOOKING_CANCELLED',
        bookingId: booking._id,
        reason,
        refundAmount: booking.pricing.totalAmount,
      },
      actionUrl: `/booking/${booking._id}/cancelled`,
    });
  }

  /**
   * Send booking failed notification
   */
  static async sendBookingFailedNotification(userId, booking, reason = 'Service could not be completed') {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'BOOKING',
      priority: 'HIGH',
      title: '⚠️ Service Failed',
      body: `Unfortunately, we couldn't complete your booking. Reason: ${reason}. A refund will be processed within 24 hours.`,
      data: {
        action: 'BOOKING_FAILED',
        bookingId: booking._id,
        reason,
      },
      actionUrl: `/booking/${booking._id}/support`,
    });
  }

  /**
   * Send rating reminder notification
   */
  static async sendRatingReminderNotification(userId, booking, mechanic) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'SYSTEM',
      priority: 'NORMAL',
      title: '⭐ Rate Your Service',
      body: `How was your experience with ${mechanic.name}? Your feedback helps us improve and reward great mechanics!`,
      data: {
        action: 'RATE_SERVICE',
        bookingId: booking._id,
        mechanicId: mechanic._id,
      },
      actionUrl: `/booking/${booking._id}/rate`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Expires in 7 days
    });
  }

  /**
   * Send reward points notification
   */
  static async sendRewardPointsNotification(userId, points, totalPoints) {
    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'REWARD',
      priority: 'NORMAL',
      title: '🎁 Reward Points Earned!',
      body: `You've earned ${points} reward points! Total points: ${totalPoints}. Redeem for discounts and cashback.`,
      data: {
        action: 'REWARDS_EARNED',
        points,
        totalPoints,
      },
      actionUrl: '/rewards',
    });
  }

  /**
   * Send coupon notification
   */
  static async sendCouponNotification(userId, couponCode, discount, expiresAt) {
    const expiryDate = new Date(expiresAt).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
    });

    return Notification.createNotification({
      userId,
      userModel: 'User',
      type: 'PROMO',
      priority: 'HIGH',
      title: '🎉 Special Offer for You!',
      body: `Use code "${couponCode}" to get ${typeof discount === 'string' ? discount : `₹${discount}`} off on your next booking! Valid till ${expiryDate}.`,
      data: {
        action: 'PROMO_OFFER',
        couponCode,
        discount,
      },
      actionUrl: '/booking/new',
    });
  }

  /**
   * Send mechanic notification for new job
   */
  static async sendMechanicJobNotification(mechanicId, booking, customer) {
    return Notification.createNotification({
      userId: mechanicId,
      userModel: 'Mechanic',
      type: 'JOB',
      priority: 'HIGH',
      title: '📌 New Job Request',
      body: `New job: ${booking.service.name} at ${booking.location.address}. Offer: ₹${booking.pricing.offerAmount}. Customer rating: ${customer.rating}/5`,
      imageUrl: customer.profileImage,
      data: {
        action: 'NEW_JOB',
        bookingId: booking._id,
        customerId: customer._id,
        customerName: customer.name,
        offerAmount: booking.pricing.offerAmount,
      },
      actionUrl: `/job/${booking._id}/accept`,
    });
  }

  /**
   * Send mechanic acceptance notification to customer
   */
  static async sendMechanicAcceptanceNotification(userId, booking, mechanic) {
    return this.sendMechanicAssignedNotification(userId, booking, mechanic);
  }

  /**
   * Send mechanic earnings notification
   */
  static async sendMechanicEarningsNotification(mechanicId, amount, bookingId) {
    return Notification.createNotification({
      userId: mechanicId,
      userModel: 'Mechanic',
      type: 'EARNINGS',
      priority: 'NORMAL',
      title: '💰 Payment Received',
      body: `You've earned ₹${amount} for completing a service. Check your wallet for details.`,
      data: {
        action: 'EARNINGS_RECEIVED',
        bookingId: bookingId,
        amount,
      },
      actionUrl: '/earnings',
    });
  }

  /**
   * Send support/help notification
   */
  static async sendSupportNotification(userId, userModel, subject, message) {
    return Notification.createNotification({
      userId,
      userModel,
      type: 'SYSTEM',
      priority: 'NORMAL',
      title: `📞 ${subject}`,
      body: message,
      data: {
        action: 'SUPPORT_MESSAGE',
      },
      actionUrl: '/support',
    });
  }

  /**
   * Get user notifications with filters
   */
  static async getUserNotifications(userId, userModel, options = {}) {
    const { page = 1, limit = 20, type, unreadOnly = false } = options;
    const skip = (page - 1) * limit;

    const filter = { userId, userModel };
    if (type) filter.type = type;
    if (unreadOnly) filter.isRead = false;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Notification.countDocuments(filter),
      Notification.getUnreadCount(userId, userModel),
    ]);

    return {
      notifications,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      unreadCount,
    };
  }

  /**
   * Mark notification as read
   */
  static async markAsRead(notificationId) {
    const notification = await Notification.findById(notificationId);
    if (notification) {
      return notification.markAsRead();
    }
    return null;
  }

  /**
   * Mark all notifications as read
   */
  static async markAllAsRead(userId, userModel) {
    return Notification.markAllAsRead(userId, userModel);
  }
}

module.exports = NotificationService;
