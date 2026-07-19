const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'userModel',
    required: true,
  },
  userModel: {
    type: String,
    enum: ['User', 'Mechanic'],
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  body: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: [
      'BOOKING',        // Booking related
      'PAYMENT',        // Payment/wallet related
      'REWARD',         // Rewards/points related
      'REFERRAL',       // Referral related
      'PROMO',          // Promotional offers
      'JOB',            // Job request (for mechanics)
      'EARNINGS',       // Earnings related (for mechanics)
      'PAYOUT',         // Payout related (for mechanics)
      'SYSTEM',         // System notifications
      'REMINDER',       // Reminders
    ],
    default: 'SYSTEM',
  },
  priority: {
    type: String,
    enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
    default: 'NORMAL',
  },
  data: {
    type: mongoose.Schema.Types.Mixed, // Additional data for navigation
    default: {},
  },
  imageUrl: {
    type: String,
  },
  actionUrl: {
    type: String, // Deep link or screen to navigate
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  readAt: {
    type: Date,
  },
  isPushSent: {
    type: Boolean,
    default: false,
  },
  pushSentAt: {
    type: Date,
  },
  expiresAt: {
    type: Date, // Optional expiry for time-sensitive notifications
  },
}, {
  timestamps: true,
});

// Indexes
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ userId: 1, type: 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Mark as read
notificationSchema.methods.markAsRead = async function() {
  if (!this.isRead) {
    this.isRead = true;
    this.readAt = new Date();
    return this.save();
  }
  return this;
};

// Static method to create and optionally send push
notificationSchema.statics.createNotification = async function(data) {
  const notification = await this.create(data);
  // Push notification logic can be added here
  return notification;
};

// Static method to get unread count
notificationSchema.statics.getUnreadCount = async function(userId, userModel) {
  return this.countDocuments({ userId, userModel, isRead: false });
};

// Static method to mark all as read
notificationSchema.statics.markAllAsRead = async function(userId, userModel) {
  return this.updateMany(
    { userId, userModel, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
};

module.exports = mongoose.model('Notification', notificationSchema);
