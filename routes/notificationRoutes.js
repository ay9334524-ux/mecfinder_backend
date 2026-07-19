const express = require('express');
const router = express.Router();
const notificationController = require('../controller/notification.controller');
const { authenticateToken, authenticateMechanic, authenticateAny } = require('../middleware/jwt.middleware');

// Create a middleware that accepts both user and mechanic tokens
const authenticateUserOrMechanic = async (req, res, next) => {
  // Try to authenticate as user first
  try {
    await new Promise((resolve, reject) => {
      authenticateToken(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return next();
  } catch (e) {
    // Try mechanic auth
    try {
      await new Promise((resolve, reject) => {
        authenticateMechanic(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return next();
    } catch (e2) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
  }
};

// All routes require authentication (user or mechanic)
router.use(authenticateUserOrMechanic);

// Notification routes
router.get('/', notificationController.getNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.put('/read-all', notificationController.markAllAsRead);
router.put('/:id/read', notificationController.markAsRead);
router.delete('/:id', notificationController.deleteNotification);
router.delete('/', notificationController.deleteAllNotifications);

module.exports = router;
