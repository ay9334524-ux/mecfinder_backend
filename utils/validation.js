const Joi = require('joi');
const ApiResponse = require('./apiResponse');

/**
 * Validation middleware factory
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {String} property - Request property to validate (body, query, params)
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));
      return ApiResponse.validationError(res, errors);
    }

    // Replace with validated and sanitized values
    req[property] = value;
    next();
  };
};

// Common validation schemas
const schemas = {
  // Phone number
  phone: Joi.string()
    .pattern(/^[6-9]\d{9}$/)
    .messages({
      'string.pattern.base': 'Please enter a valid 10-digit Indian mobile number',
    }),

  // OTP
  otp: Joi.string()
    .length(6)
    .pattern(/^\d+$/)
    .messages({
      'string.length': 'OTP must be 6 digits',
      'string.pattern.base': 'OTP must contain only numbers',
    }),

  // MongoDB ObjectId
  objectId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .messages({
      'string.pattern.base': 'Invalid ID format',
    }),

  // Email
  email: Joi.string()
    .email()
    .lowercase()
    .trim(),

  // Pagination
  pagination: {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  },

  // Coordinates
  coordinates: {
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
  },
};

// Pre-built validation schemas for common routes

// Auth validations
const authValidations = {
  sendOtp: Joi.object({
    phone: schemas.phone.required(),
    type: Joi.string().valid('USER', 'MECHANIC').default('USER'),
  }),

  verifyOtp: Joi.object({
    phone: schemas.phone.required(),
    otp: schemas.otp.required(),
  }),

  registerUser: Joi.object({
    name: Joi.string().min(2).max(100).required(),
    email: schemas.email,
    gender: Joi.string().valid('MALE', 'FEMALE', 'OTHER'),
  }),

  registerMechanic: Joi.object({
    fullName: Joi.string().min(2).max(100).required(),
    email: schemas.email,
    address: Joi.object({
      line1: Joi.string().required(),
      city: Joi.string().required(),
      state: Joi.string().required(),
      pincode: Joi.string().pattern(/^\d{6}$/).required(),
    }),
    vehicleTypes: Joi.array().items(
      Joi.string().valid('BIKE', 'CAR', 'TRUCK', 'AUTO')
    ).min(1),
  }),
};

// User validations
const userValidations = {
  updateProfile: Joi.object({
    name: Joi.string().min(2).max(100),
    email: schemas.email,
    gender: Joi.string().valid('MALE', 'FEMALE', 'OTHER'),
    profileImageUrl: Joi.string().uri(),
  }),

  updateLocation: Joi.object({
    latitude: schemas.coordinates.latitude,
    longitude: schemas.coordinates.longitude,
    address: Joi.string(),
  }),
};

// Wallet validations
const walletValidations = {
  addMoney: Joi.object({
    amount: Joi.number().min(10).max(50000).required()
      .messages({
        'number.min': 'Minimum amount is ₹10',
        'number.max': 'Maximum amount is ₹50,000',
      }),
  }),

  verifyPayment: Joi.object({
    razorpay_order_id: Joi.string().required(),
    razorpay_payment_id: Joi.string().required(),
    razorpay_signature: Joi.string().required(),
  }),
};

// Booking validations
const bookingValidations = {
  create: Joi.object({
    serviceId: schemas.objectId.required(),
    location: Joi.object({
      latitude: schemas.coordinates.latitude,
      longitude: schemas.coordinates.longitude,
      address: Joi.string().required(),
      landmark: Joi.string(),
    }).required(),
    vehicleDetails: Joi.object({
      type: Joi.string().valid('BIKE', 'CAR', 'TRUCK', 'AUTO').required(),
      make: Joi.string(),
      model: Joi.string(),
      registrationNumber: Joi.string(),
    }),
    scheduledAt: Joi.date().greater('now'),
    notes: Joi.string().max(500),
    paymentMethod: Joi.string().valid('WALLET', 'CARD', 'UPI', 'CASH'),
    promoCode: Joi.string(),
  }),

  updateStatus: Joi.object({
    status: Joi.string().valid(
      'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
    ).required(),
    reason: Joi.string().when('status', {
      is: 'CANCELLED',
      then: Joi.required(),
    }),
    otp: Joi.string().length(4).when('status', {
      is: 'COMPLETED',
      then: Joi.required(),
    }),
  }),

  rate: Joi.object({
    rating: Joi.number().min(1).max(5).required(),
    review: Joi.string().max(500),
  }),
};

// Mechanic validations
const mechanicValidations = {
  updateProfile: Joi.object({
    fullName: Joi.string().min(2).max(100),
    email: schemas.email,
    address: Joi.object({
      line1: Joi.string(),
      city: Joi.string(),
      state: Joi.string(),
      pincode: Joi.string().pattern(/^\d{6}$/),
    }),
    vehicleTypes: Joi.array().items(
      Joi.string().valid('BIKE', 'CAR', 'TRUCK', 'AUTO')
    ),
    servicesOffered: Joi.array().items(
      Joi.object({
        serviceId: schemas.objectId,
        serviceName: Joi.string(),
      })
    ),
  }),

  updateBankDetails: Joi.object({
    accountHolderName: Joi.string().min(3).max(100).required(),
    accountNumber: Joi.string().min(9).max(18).required(),
    ifscCode: Joi.string().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/).required()
      .messages({
        'string.pattern.base': 'Invalid IFSC code format',
      }),
    bankName: Joi.string(),
    upiId: Joi.string().pattern(/^[\w.-]+@[\w]+$/)
      .messages({
        'string.pattern.base': 'Invalid UPI ID format',
      }),
  }),

  updateLocation: Joi.object({
    latitude: schemas.coordinates.latitude,
    longitude: schemas.coordinates.longitude,
    isOnline: Joi.boolean(),
  }),

  requestPayout: Joi.object({
    amount: Joi.number().min(100).required()
      .messages({
        'number.min': 'Minimum payout amount is ₹100',
      }),
  }),
};

// Referral validations
const referralValidations = {
  applyCode: Joi.object({
    referralCode: Joi.string().uppercase().required(),
  }),
};

// Notification validations
const notificationValidations = {
  markRead: Joi.object({
    notificationIds: Joi.array().items(schemas.objectId).min(1),
  }),
};

module.exports = {
  validate,
  schemas,
  authValidations,
  userValidations,
  walletValidations,
  bookingValidations,
  mechanicValidations,
  referralValidations,
  notificationValidations,
};
