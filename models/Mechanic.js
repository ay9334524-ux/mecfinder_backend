const mongoose = require('mongoose');

const mechanicSchema = new mongoose.Schema({
  phone: {
    type: String,
    unique: true,
    required: true
  },
  fullName: {
    type: String,
    required: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  role: {
    type: String,
    enum: ['MECHANIC'],
    default: 'MECHANIC'
  },

  // Address
  address: {
    line1: String,
    city: String,
    state: String,
    pincode: String
  },

  // Work related
  vehicleTypes: {
    type: [{
      type: String,
      enum: ['BIKE', 'CAR', 'TRUCK', 'AUTO']
    }],
    default: ['BIKE', 'CAR', 'AUTO', 'TRUCK'] // Default to all vehicle types
  },

  servicesOffered: [
    {
      serviceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Service'
      },
      serviceName: String
    }
  ],

  // Bank details
  bankDetails: {
    accountHolderName: String,
    accountNumber: String,
    ifscCode: String,
    bankName: String
  },

  // Status control
  status: {
    type: String,
    enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'BANNED'],
    default: 'PENDING'
  },
  // Ban system
  banInfo: {
    isBanned: {
      type: Boolean,
      default: false
    },
    banType: {
      type: String,
      enum: ["PERMANENT", "TEMPORARY"],
      default: null
    },
    banReason: String,
    bannedAt: Date,
    bannedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    },
    banExpiresAt: Date, // For temporary bans
    unbanReason: String,
    unbannedAt: Date,
    unbannedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    }
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  isBusy: {
    type: Boolean,
    default: false
  },

  // Rating system
  ratingAverage: {
    type: Number,
    default: 0
  },
  ratingCount: {
    type: Number,
    default: 0
  },
  totalJobsCompleted: {
    type: Number,
    default: 0
  },

  // GeoJSON location for $nearSphere queries (production geo-spatial)
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [0, 0],
    },
  },

  // Legacy location tracking (kept for backward compatibility)
  lastLocation: {
    lat: Number,
    lng: Number,
    address: String,
    updatedAt: Date
  },

  // Current active booking (prevents double assignment)
  currentBookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    default: null,
  },

  // Earnings
  totalEarnings: {
    type: Number,
    default: 0
  },

  // Auth
  refreshTokenHash: String,
  lastLoginAt: Date,
  lastActiveAt: Date,
  
  // FCM Push Notifications
  fcmToken: {
    type: String,
    default: null
  },

  // Title/Badge system based on total jobs completed
  currentTitle: {
    type: String,
    enum: [
      'NEW',         // <= 5
      'BEGINNER',    // > 5 and <= 25
      'INTERMEDIATE', // > 25 and <= 50
      'BRONZE',      // > 50 and <= 100
      'SILVER',      // > 100 and <= 150
      'GOLD',        // > 150 and <= 200
      'PLATINUM',    // > 200 and <= 250
      'DIAMOND',     // > 250 and <= 300
      'ACE',         // > 300 and <= 400
      'CONQUEROR',   // > 400 and <= 500
      'MASTER'       // > 500
    ],
    default: 'NEW'
  },
  titleUnlockHistory: [{
    title: String,
    unlockedAt: {
      type: Date,
      default: Date.now
    },
    jobsCompletedAtUnlock: Number
  }],

  // Audit
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Production-grade indexes
mechanicSchema.index({ location: '2dsphere' }); // GeoJSON 2dsphere for $nearSphere
mechanicSchema.index({ status: 1, isOnline: 1, isBusy: 1 }); // Compound for mechanic search
mechanicSchema.index({ 'lastLocation.lat': 1, 'lastLocation.lng': 1 }); // Legacy compat
mechanicSchema.index({ currentBookingId: 1 }); // Quick busy lookup
mechanicSchema.index({ phone: 1 }, { unique: true });

const Mechanic = mongoose.model('Mechanic', mechanicSchema);

module.exports = Mechanic;
