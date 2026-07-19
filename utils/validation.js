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

  // Firebase flow: firebaseIdToken + role. Legacy: phone + otp (ignored if token present).
  verifyOtp: Joi.object({
    firebaseIdToken: Joi.string().optional(),
    role: Joi.string().valid('USER', 'MECHANIC').optional(),
    phone: schemas.phone.when('firebaseIdToken', {
      is: Joi.exist(),
      then: Joi.optional(),
      otherwise: Joi.required(),
    }),
    otp: Joi.when('firebaseIdToken', {
      is: Joi.exist(),
      then: Joi.optional().allow(null, ''),
      otherwise: schemas.otp.required(),
    }),
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

  updatePayoutUpi: Joi.object({
    upiId: Joi.string().pattern(/^[\w.-]+@[\w]+$/).required()
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
    amount: Joi.number().min(1).required()
      .messages({
        'number.min': 'Invalid payout amount',
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

// Complaint validations
const complaintValidations = {
  create: Joi.object({
    bookingId: schemas.objectId.required(),
    title: Joi.string().min(5).max(100).required().messages({
      'string.min': 'Title must be at least 5 characters',
      'string.max': 'Title must not exceed 100 characters',
    }),
    description: Joi.string().min(10).max(1000).required().messages({
      'string.min': 'Description must be at least 10 characters',
      'string.max': 'Description must not exceed 1000 characters',
    }),
    category: Joi.string().valid('QUALITY_ISSUE', 'BEHAVIOR', 'PRICING', 'TIME_ISSUE', 'OTHER').required(),
    severity: Joi.string().valid('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'),
    images: Joi.array().items(Joi.string().uri()),
  }),
  
  updateAdmin: Joi.object({
    status: Joi.string().valid('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED', 'CLOSED'),
    adminNotes: Joi.string().max(500),
    resolution: Joi.string().max(500),
    refundAmount: Joi.number().min(0),
  }),
};

// Rewards validations
const rewardsValidations = {
  redeemReward: Joi.object({
    rewardId: schemas.objectId.required(),
  }),

  validateCoupon: Joi.object({
    couponCode: Joi.string().min(2).max(50).required(),
    bookingAmount: Joi.number().min(0).required(),
  }),
};

// Review validations
const reviewValidations = {
  create: Joi.object({
    bookingId: schemas.objectId.required(),
    rating: Joi.number().min(1).max(5).required(),
    title: Joi.string().min(2).max(120).allow('', null),
    description: Joi.string().max(1000).allow('', null),
    ratingBreakdown: Joi.object({
      workQuality: Joi.number().min(1).max(5),
      timelinessAndPunctuality: Joi.number().min(1).max(5),
      professionalism: Joi.number().min(1).max(5),
      communication: Joi.number().min(1).max(5),
    }),
    images: Joi.array().items(Joi.string().uri()).max(6),
  }),

  reject: Joi.object({
    reason: Joi.string().min(2).max(500).required(),
  }),

  flag: Joi.object({
    flagged: Joi.boolean().required(),
    reason: Joi.string().max(500),
  }),

  respond: Joi.object({
    message: Joi.string().min(1).max(1000).required(),
  }),
};

// Support / help validations
const supportValidations = {
  create: Joi.object({
    userId: schemas.objectId,
    subject: Joi.string().min(3).max(200).required(),
    message: Joi.string().min(3).max(5000).required(),
    category: Joi.string().max(50),
    priority: Joi.string().valid('LOW', 'NORMAL', 'HIGH', 'URGENT'),
    bookingId: schemas.objectId,
  }),

  updateStatus: Joi.object({
    status: Joi.string().valid('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED').required(),
    resolution: Joi.string().max(2000),
  }),

  assign: Joi.object({
    assignedTo: schemas.objectId.required(),
  }),
};

// Help / FAQ validations
const helpValidations = {
  faqHelpful: Joi.object({
    helpful: Joi.boolean().required(),
  }),

  createTicket: Joi.object({
    subject: Joi.string().min(3).max(200).required(),
    message: Joi.string().min(3).max(5000).required(),
    category: Joi.string().max(50),
    bookingId: schemas.objectId,
  }),

  ticketReply: Joi.object({
    message: Joi.string().min(1).max(5000).required(),
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
  complaintValidations,
  rewardsValidations,
  reviewValidations,
  supportValidations,
  helpValidations,
};
