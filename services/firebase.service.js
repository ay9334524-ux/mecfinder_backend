const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger.service');

// Initialize Firebase Admin with service account
let firebaseInitialized = false;

const initializeFirebase = () => {
  if (firebaseInitialized) {
    return;
  }

  try {
    let serviceAccount = null;

    // Option 1: JSON content in env var (single-line or escaped newlines)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      } catch (jsonErr) {
        // Some setups store escaped newlines or wrapped quotes
        try {
          const normalized = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
            .replace(/^['"]|['"]$/g, '')
            .replace(/\\n/g, '\n');
          serviceAccount = JSON.parse(normalized);
        } catch (normalizedErr) {
          logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON, trying file path fallback');
        }
      }
    }

    // Option 2: File path in env (preferred for local dev)
    if (!serviceAccount) {
      const configuredPath =
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        process.env.FIREBASE_JSON ||
        '';

      if (configuredPath) {
        const absolutePath = path.isAbsolute(configuredPath)
          ? configuredPath
          : path.resolve(process.cwd(), configuredPath);

        if (fs.existsSync(absolutePath)) {
          const fileContent = fs.readFileSync(absolutePath, 'utf8');
          serviceAccount = JSON.parse(fileContent);
          logger.info(`Loaded Firebase service account from file: ${absolutePath}`);
        } else {
          logger.warn(`Firebase service account file not found: ${absolutePath}`);
        }
      }
    }

    if (!serviceAccount) {
      throw new Error(
        'No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_JSON/FIREBASE_SERVICE_ACCOUNT_PATH'
      );
    }
    
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
    // Surface invalid-token errors with a stable tag so callers can clean
    // up the bad token from the user/mechanic record. Returning null here
    // (the previous behavior) was indistinguishable from "Firebase not
    // initialized" and let stale tokens linger forever.
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      logger.warn(`Invalid FCM token: ${token.substring(0, 20)}...`);
      const err = new Error('Invalid FCM token');
      err.code = 'INVALID_FCM_TOKEN';
      err.token = token;
      throw err;
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

/**
 * Normalize Firebase `phone_number` to E.164 India: +91 followed by 10 digits starting 6–9.
 * @param {string} raw
 * @returns {string|null}
 */
const normalizeIndiaPhoneFromFirebase = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  const compact = raw.replace(/[\s\-.()]/g, '');
  if (/^\+91[6-9]\d{9}$/.test(compact)) return compact;
  const digits = compact.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91') && /^91[6-9]\d{9}$/.test(digits)) {
    return `+${digits}`;
  }
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return `+91${digits}`;
  }
  return null;
};

/**
 * Verify a Firebase Phone Auth ID token and extract the phone number.
 * Used to replace Twilio OTP flow — client verifies OTP via Firebase SDK,
 * then sends the resulting ID token to the backend for identity confirmation.
 *
 * @param {string} idToken - Firebase ID token from client after phone verification
 * @returns {Promise<{ valid: boolean, phone?: string, uid?: string, error?: string }>}
 */
const verifyFirebaseIdToken = async (idToken) => {
  if (!firebaseInitialized) {
    logger.warn('Firebase not initialized, cannot verify ID token');
    return { valid: false, error: 'Firebase not initialized on server' };
  }

  if (!idToken) {
    return { valid: false, error: 'No ID token provided' };
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    const rawPhone = decodedToken.phone_number;
    if (!rawPhone) {
      return { valid: false, error: 'Token does not contain a phone number' };
    }

    const phone = normalizeIndiaPhoneFromFirebase(rawPhone) || rawPhone.trim();

    return {
      valid: true,
      phone,
      uid: decodedToken.uid,
    };
  } catch (error) {
    logger.error('Firebase ID token verification failed:', error.message);

    if (error.code === 'auth/id-token-expired') {
      return { valid: false, error: 'Firebase token has expired. Please re-verify.' };
    }
    if (error.code === 'auth/argument-error' || error.code === 'auth/invalid-id-token') {
      return { valid: false, error: 'Invalid Firebase token.' };
    }

    return { valid: false, error: 'Token verification failed' };
  }
};

module.exports = {
  initializeFirebase,
  verifyFirebaseIdToken,
  sendPushNotification,
  sendMultiplePushNotifications,
  sendBookingRequestNotification,
  sendBookingConfirmationNotification,
  sendBookingCancellationNotification,
  sendJobCompletedNotification,
  sendMechanicArrivedNotification,
  sendPaymentReminderNotification,
};
