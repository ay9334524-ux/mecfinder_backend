const Notification = require('../models/Notification');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Get user notifications
 * GET /api/notifications
 */
const getNotifications = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, type, unreadOnly } = req.query;
  const skip = (page - 1) * limit;

  const userId = req.user?.id || req.mechanic?.id;
  const userModel = req.user ? 'User' : 'Mechanic';

  const filter = { userId, userModel };
  if (type) filter.type = type;
  if (unreadOnly === 'true') filter.isRead = false;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Notification.countDocuments(filter),
    Notification.getUnreadCount(userId, userModel),
  ]);

  ApiResponse.paginated(res, { notifications, unreadCount }, {
    page: parseInt(page),
    limit: parseInt(limit),
    total,
  });
});

/**
 * Get unread count
 * GET /api/notifications/unread-count
 */
const getUnreadCount = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.mechanic?.id;
  const userModel = req.user ? 'User' : 'Mechanic';

  const count = await Notification.getUnreadCount(userId, userModel);

  ApiResponse.success(res, { unreadCount: count });
});

/**
 * Mark notification as read
 * PUT /api/notifications/:id/read
 */
const markAsRead = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.mechanic?.id;

  const notification = await Notification.findOne({
    _id: req.params.id,
    userId,
  });

  if (!notification) {
    return ApiResponse.notFound(res, 'Notification not found');
  }

  await notification.markAsRead();

  ApiResponse.success(res, { notification }, 'Marked as read');
});

/**
 * Mark all notifications as read
 * PUT /api/notifications/read-all
 */
const markAllAsRead = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.mechanic?.id;
  const userModel = req.user ? 'User' : 'Mechanic';

  await Notification.markAllAsRead(userId, userModel);

  ApiResponse.success(res, null, 'All notifications marked as read');
});

/**
 * Delete notification
 * DELETE /api/notifications/:id
 */
const deleteNotification = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.mechanic?.id;

  const notification = await Notification.findOneAndDelete({
    _id: req.params.id,
    userId,
  });

  if (!notification) {
    return ApiResponse.notFound(res, 'Notification not found');
  }

  ApiResponse.success(res, null, 'Notification deleted');
});

/**
 * Delete all notifications
 * DELETE /api/notifications
 */
const deleteAllNotifications = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.mechanic?.id;
  const userModel = req.user ? 'User' : 'Mechanic';

  await Notification.deleteMany({ userId, userModel });

  ApiResponse.success(res, null, 'All notifications deleted');
});

// Internal functions for creating notifications

/**
 * Create notification (internal)
 */
const createNotification = async (data) => {
  const notification = await Notification.create(data);
  // TODO: Send push notification via Firebase
  return notification;
};

/**
 * Send booking notification to user
 */
const sendBookingNotification = async (userId, title, body, bookingId, type = 'BOOKING') => {
  return createNotification({
    userId,
    userModel: 'User',
    title,
    body,
    type,
    data: { bookingId },
    actionUrl: `/booking/${bookingId}`,
  });
};

/**
 * Send job notification to mechanic
 */
const sendJobNotification = async (mechanicId, title, body, bookingId, priority = 'HIGH') => {
  return createNotification({
    userId: mechanicId,
    userModel: 'Mechanic',
    title,
    body,
    type: 'JOB',
    priority,
    data: { bookingId },
    actionUrl: `/job/${bookingId}`,
  });
};

/**
 * Send payment notification
 */
const sendPaymentNotification = async (userId, userModel, title, body, data = {}) => {
  return createNotification({
    userId,
    userModel,
    title,
    body,
    type: 'PAYMENT',
    data,
  });
};

/**
 * Send reward notification
 */
const sendRewardNotification = async (userId, title, body, points) => {
  return createNotification({
    userId,
    userModel: 'User',
    title,
    body,
    type: 'REWARD',
    data: { points },
  });
};

/**
 * Send payout notification to mechanic
 */
const sendPayoutNotification = async (mechanicId, title, body, amount, status) => {
  return createNotification({
    userId: mechanicId,
    userModel: 'Mechanic',
    title,
    body,
    type: 'PAYOUT',
    data: { amount, status },
  });
};

/**
 * Send promotional notification (bulk)
 */
const sendPromoNotification = async (userIds, userModel, title, body, imageUrl = null) => {
  const notifications = userIds.map(userId => ({
    userId,
    userModel,
    title,
    body,
    type: 'PROMO',
    imageUrl,
  }));

  return Notification.insertMany(notifications);
};

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllNotifications,
  // Internal
  createNotification,
  sendBookingNotification,
  sendJobNotification,
  sendPaymentNotification,
  sendRewardNotification,
  sendPayoutNotification,
  sendPromoNotification,
};
