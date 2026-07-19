const EventEmitter = require('events');
const notificationService = require('./notification.service');

/**
 * Booking Event Emitter - Handles all booking-related events and sends notifications
 * Extends Node.js EventEmitter
 */
class BookingEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setupListeners();
  }

  /**
   * Setup all event listeners
   */
  setupListeners() {
    // Booking accepted/assigned events
    this.on('booking:accepted', this.handleBookingAccepted.bind(this));
    this.on('booking:mechanic-assigned', this.handleMechanicAssigned.bind(this));
    
    // Service status events
    this.on('service:started', this.handleServiceStarted.bind(this));
    this.on('service:in-progress', this.handleServiceInProgress.bind(this));
    this.on('service:completed', this.handleServiceCompleted.bind(this));
    
    // Payment events
    this.on('payment:pending', this.handlePaymentPending.bind(this));
    this.on('payment:success', this.handlePaymentSuccess.bind(this));
    this.on('payment:failed', this.handlePaymentFailed.bind(this));
    
    // Booking status events
    this.on('booking:cancelled', this.handleBookingCancelled.bind(this));
    this.on('booking:failed', this.handleBookingFailed.bind(this));
    
    // Rating and rewards events
    this.on('rating:reminder', this.handleRatingReminder.bind(this));
    this.on('reward:earned', this.handleRewardEarned.bind(this));
    
    // Mechanic events
    this.on('job:offered', this.handleJobOffered.bind(this));
    this.on('mechanic:earnings', this.handleMechanicEarnings.bind(this));
  }

  /**
   * Booking accepted by mechanic
   */
  async handleBookingAccepted(data) {
    const { booking, mechanic } = data;
    try {
      console.log(`📞 Booking ${booking._id} accepted by mechanic ${mechanic._id}`);
      await notificationService.sendMechanicAssignedNotification(booking.userId, booking, mechanic);
    } catch (error) {
      console.error('Error sending booking accepted notification:', error);
    }
  }

  /**
   * Mechanic assigned to booking
   */
  async handleMechanicAssigned(data) {
    const { booking, mechanic } = data;
    try {
      console.log(`🔧 Mechanic ${mechanic._id} assigned to booking ${booking._id}`);
      await notificationService.sendMechanicAssignedNotification(booking.userId, booking, mechanic);
    } catch (error) {
      console.error('Error sending mechanic assigned notification:', error);
    }
  }

  /**
   * Service started
   */
  async handleServiceStarted(data) {
    const { booking, mechanic } = data;
    try {
      console.log(`🚗 Service started for booking ${booking._id}`);
      await notificationService.sendServiceStartedNotification(booking.userId, booking, mechanic);
    } catch (error) {
      console.error('Error sending service started notification:', error);
    }
  }

  /**
   * Service in progress
   */
  async handleServiceInProgress(data) {
    const { booking, mechanic, progress } = data;
    try {
      console.log(`⏳ Service ${progress}% complete for booking ${booking._id}`);
      await notificationService.sendServiceInProgressNotification(booking.userId, booking, mechanic, progress);
    } catch (error) {
      console.error('Error sending service in progress notification:', error);
    }
  }

  /**
   * Service completed
   */
  async handleServiceCompleted(data) {
    const { booking, mechanic } = data;
    try {
      console.log(`✨ Service completed for booking ${booking._id}`);
      await notificationService.sendServiceCompletedNotification(booking.userId, booking, mechanic);
    } catch (error) {
      console.error('Error sending service completed notification:', error);
    }
  }

  /**
   * Payment pending reminder
   */
  async handlePaymentPending(data) {
    const { booking } = data;
    try {
      console.log(`💳 Payment pending for booking ${booking._id}`);
      await notificationService.sendPaymentReminderNotification(booking.userId, booking);
    } catch (error) {
      console.error('Error sending payment reminder notification:', error);
    }
  }

  /**
   * Payment successful
   */
  async handlePaymentSuccess(data) {
    const { booking, transactionId } = data;
    try {
      console.log(`✅ Payment successful for booking ${booking._id}`);
      await notificationService.sendPaymentSuccessNotification(booking.userId, booking, transactionId);
    } catch (error) {
      console.error('Error sending payment success notification:', error);
    }
  }

  /**
   * Payment failed
   */
  async handlePaymentFailed(data) {
    const { booking, reason } = data;
    try {
      console.log(`❌ Payment failed for booking ${booking._id}`);
      await notificationService.sendBookingCancelledNotification(booking.userId, booking, `Payment failed - ${reason}`);
    } catch (error) {
      console.error('Error sending payment failed notification:', error);
    }
  }

  /**
   * Booking cancelled
   */
  async handleBookingCancelled(data) {
    const { booking, reason } = data;
    try {
      console.log(`❌ Booking ${booking._id} cancelled - Reason: ${reason}`);
      await notificationService.sendBookingCancelledNotification(booking.userId, booking, reason);
    } catch (error) {
      console.error('Error sending booking cancelled notification:', error);
    }
  }

  /**
   * Booking failed
   */
  async handleBookingFailed(data) {
    const { booking, reason } = data;
    try {
      console.log(`⚠️ Booking ${booking._id} failed - Reason: ${reason}`);
      await notificationService.sendBookingFailedNotification(booking.userId, booking, reason);
    } catch (error) {
      console.error('Error sending booking failed notification:', error);
    }
  }

  /**
   * Rating reminder
   */
  async handleRatingReminder(data) {
    const { booking, mechanic } = data;
    try {
      console.log(`⭐ Sending rating reminder for booking ${booking._id}`);
      await notificationService.sendRatingReminderNotification(booking.userId, booking, mechanic);
    } catch (error) {
      console.error('Error sending rating reminder notification:', error);
    }
  }

  /**
   * Reward points earned
   */
  async handleRewardEarned(data) {
    const { userId, points, totalPoints } = data;
    try {
      console.log(`🎁 User ${userId} earned ${points} reward points`);
      await notificationService.sendRewardPointsNotification(userId, points, totalPoints);
    } catch (error) {
      console.error('Error sending reward notification:', error);
    }
  }

  /**
   * Job offered to mechanic
   */
  async handleJobOffered(data) {
    const { booking, mechanic, customer } = data;
    try {
      console.log(`📌 Job offered to mechanic ${mechanic._id}`);
      await notificationService.sendMechanicJobNotification(mechanic._id, booking, customer);
    } catch (error) {
      console.error('Error sending job notification:', error);
    }
  }

  /**
   * Mechanic earnings
   */
  async handleMechanicEarnings(data) {
    const { mechanicId, amount, bookingId } = data;
    try {
      console.log(`💰 Mechanic ${mechanicId} earned ₹${amount}`);
      await notificationService.sendMechanicEarningsNotification(mechanicId, amount, bookingId);
    } catch (error) {
      console.error('Error sending mechanic earnings notification:', error);
    }
  }

  /**
   * Emit booking status change event
   */
  emitBookingStatusChange(booking, previousStatus, mechanic = null) {
    const status = booking.status;

    if (previousStatus === 'SEARCHING' && status === 'ACCEPTED') {
      this.emit('booking:accepted', { booking, mechanic });
    } else if (status === 'ACCEPTED') {
      this.emit('booking:mechanic-assigned', { booking, mechanic });
    } else if (previousStatus === 'ACCEPTED' && status === 'SERVICE_STARTED') {
      this.emit('service:started', { booking, mechanic });
    } else if (status === 'SERVICE_COMPLETED') {
      this.emit('service:completed', { booking, mechanic });
    } else if (status === 'CANCELLED') {
      this.emit('booking:cancelled', { booking, reason: booking.cancellationReason || 'Cancelled' });
    } else if (status === 'FAILED') {
      this.emit('booking:failed', { booking, reason: booking.failureReason || 'Service failed' });
    }
  }

  /**
   * Emit custom events
   */
  emitServiceInProgress(booking, mechanic, progress) {
    this.emit('service:in-progress', { booking, mechanic, progress });
  }

  emitPaymentEvent(booking, event, transactionId = null, reason = null) {
    if (event === 'pending') {
      this.emit('payment:pending', { booking });
    } else if (event === 'success') {
      this.emit('payment:success', { booking, transactionId });
    } else if (event === 'failed') {
      this.emit('payment:failed', { booking, reason });
    }
  }

  emitRatingReminder(booking, mechanic) {
    this.emit('rating:reminder', { booking, mechanic });
  }

  emitRewardEarned(userId, points, totalPoints) {
    this.emit('reward:earned', { userId, points, totalPoints });
  }

  emitJobOffered(booking, mechanic, customer) {
    this.emit('job:offered', { booking, mechanic, customer });
  }

  emitMechanicEarnings(mechanicId, amount, bookingId) {
    this.emit('mechanic:earnings', { mechanicId, amount, bookingId });
  }
}

// Create singleton instance
const bookingEventEmitter = new BookingEventEmitter();

module.exports = bookingEventEmitter;
