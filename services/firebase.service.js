const admin = require('firebase-admin');
const { logger } = require('./logger.service');

// Initialize Firebase Admin with service account
let firebaseInitialized = false;

const initializeFirebase = () => {
  if (firebaseInitialized) {
    return;
  }

  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    
    firebaseInitialized = true;
    logger.info('Firebase Admin SDK initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Firebase Admin SDK:', error.message);
    // Don't throw - allow app to continue without push notifications
  }
};

// Initialize on module load
initializeFirebase();

/**
 * Send push notification to a single device
 * @param {string} token - FCM device token
 * @param {object} notification - { title, body }
 * @param {object} data - Additional data payload
 * @returns {Promise<string>} - Message ID
 */
const sendPushNotification = async (token, notification, data = {}) => {
  if (!firebaseInitialized) {
    logger.warn('Firebase not initialized, skipping push notification');
    return null;
  }

  if (!token) {
    logger.warn('No FCM token provided, skipping push notification');
    return null;
  }

  try {
    const message = {
      token,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        ...data,
        // Ensure all values are strings
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, String(value)])
        ),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'mecfinder_notifications',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body,
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    logger.info(`Push notification sent successfully: ${response}`);
    return response;
  } catch (error) {
    // Handle invalid token
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      logger.warn(`Invalid FCM token: ${token.substring(0, 20)}...`);
      return null;
    }
    
    logger.error('Failed to send push notification:', error.message);
    throw error;
  }
};

/**
 * Send push notification to multiple devices
 * @param {string[]} tokens - Array of FCM device tokens
 * @param {object} notification - { title, body }
 * @param {object} data - Additional data payload
 * @returns {Promise<object>} - Batch response
 */
const sendMultiplePushNotifications = async (tokens, notification, data = {}) => {
  if (!firebaseInitialized) {
    logger.warn('Firebase not initialized, skipping push notifications');
    return null;
  }

  if (!tokens || tokens.length === 0) {
    logger.warn('No FCM tokens provided, skipping push notifications');
    return null;
  }

  // Filter out null/undefined tokens
  const validTokens = tokens.filter(token => token);
  
  if (validTokens.length === 0) {
    logger.warn('No valid FCM tokens after filtering');
    return null;
  }

  try {
    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, String(value)])
        ),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'mecfinder_notifications',
          priority: 'high',
          defaultSound: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body,
            },
            sound: 'default',
          },
        },
      },
      tokens: validTokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    
    logger.info(`Multicast sent: ${response.successCount} successful, ${response.failureCount} failed`);
    
    // Log failed tokens for debugging
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          logger.warn(`Failed to send to token ${idx}: ${resp.error?.message}`);
        }
      });
    }
    
    return response;
  } catch (error) {
    logger.error('Failed to send multicast push notification:', error.message);
    throw error;
  }
};

/**
 * Send booking request notification to mechanic
 * @param {string} token - Mechanic's FCM token
 * @param {object} bookingDetails - Booking information
 */
const sendBookingRequestNotification = async (token, bookingDetails) => {
  const notification = {
    title: '🔧 New Service Request!',
    body: `${bookingDetails.vehicleType} - ${bookingDetails.serviceName}. Tap to view details.`,
  };

  const data = {
    type: 'BOOKING_REQUEST',
    bookingId: bookingDetails.bookingId,
    vehicleType: bookingDetails.vehicleType,
    serviceName: bookingDetails.serviceName,
    userLocation: JSON.stringify(bookingDetails.userLocation),
    estimatedAmount: bookingDetails.estimatedAmount?.toString() || '0',
  };

  return sendPushNotification(token, notification, data);
};

/**
 * Send booking confirmation to user
 * @param {string} token - User's FCM token
 * @param {object} bookingDetails - Booking information
 */
const sendBookingConfirmationNotification = async (token, bookingDetails) => {
  const notification = {
    title: '✅ Mechanic Assigned!',
    body: `${bookingDetails.mechanicName} is on the way. ETA: ${bookingDetails.eta || 'Soon'}`,
  };

  const data = {
    type: 'BOOKING_CONFIRMED',
    bookingId: bookingDetails.bookingId,
    mechanicName: bookingDetails.mechanicName,
    mechanicPhone: bookingDetails.mechanicPhone,
    eta: bookingDetails.eta || '',
  };

  return sendPushNotification(token, notification, data);
};

/**
 * Send booking cancellation notification
 * @param {string} token - FCM token
 * @param {object} details - Cancellation details
 * @param {string} recipientType - 'user' or 'mechanic'
 */
const sendBookingCancellationNotification = async (token, details, recipientType) => {
  const isMechanic = recipientType === 'mechanic';
  
  const notification = {
    title: '❌ Booking Cancelled',
    body: isMechanic 
      ? `Booking for ${details.serviceName} has been cancelled by the user.`
      : `Your booking has been cancelled${details.cancelledBy === 'mechanic' ? ' by the mechanic' : ''}.`,
  };

  const data = {
    type: 'BOOKING_CANCELLED',
    bookingId: details.bookingId,
    reason: details.reason || '',
    cancelledBy: details.cancelledBy || '',
  };

  return sendPushNotification(token, notification, data);
};

/**
 * Send job completion notification to user
 * @param {string} token - User's FCM token
 * @param {object} details - Job completion details
 */
const sendJobCompletedNotification = async (token, details) => {
  const notification = {
    title: '🎉 Service Completed!',
    body: `Your ${details.serviceName} service is complete. Total: ₹${details.totalAmount}`,
  };

  const data = {
    type: 'JOB_COMPLETED',
    bookingId: details.bookingId,
    totalAmount: details.totalAmount?.toString() || '0',
    serviceName: details.serviceName,
  };

  return sendPushNotification(token, notification, data);
};

/**
 * Send mechanic arrival notification to user
 * @param {string} token - User's FCM token
 * @param {object} details - Arrival details
 */
const sendMechanicArrivedNotification = async (token, details) => {
  const notification = {
    title: '📍 Mechanic Arrived!',
    body: `${details.mechanicName} has arrived at your location.`,
  };

  const data = {
    type: 'MECHANIC_ARRIVED',
    bookingId: details.bookingId,
    mechanicName: details.mechanicName,
  };

  return sendPushNotification(token, notification, data);
};

/**
 * Send payment reminder notification
 * @param {string} token - FCM token
 * @param {object} details - Payment details
 */
const sendPaymentReminderNotification = async (token, details) => {
  const notification = {
    title: '💳 Payment Required',
    body: `Complete payment of ₹${details.amount} for your recent service.`,
  };

  const data = {
    type: 'PAYMENT_REMINDER',
    bookingId: details.bookingId,
    amount: details.amount?.toString() || '0',
  };

  return sendPushNotification(token, notification, data);
};

module.exports = {
  initializeFirebase,
  sendPushNotification,
  sendMultiplePushNotifications,
  sendBookingRequestNotification,
  sendBookingConfirmationNotification,
  sendBookingCancellationNotification,
  sendJobCompletedNotification,
  sendMechanicArrivedNotification,
  sendPaymentReminderNotification,
};
