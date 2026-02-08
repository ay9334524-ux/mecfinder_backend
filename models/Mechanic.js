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
  vehicleTypes: [{
    type: String,
    enum: ['BIKE', 'CAR', 'TRUCK', 'AUTO']
  }],

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
    enum: ['PENDING', 'ACTIVE', 'SUSPENDED'],
    default: 'PENDING'
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

  // Location tracking
  lastLocation: {
    lat: Number,
    lng: Number,
    address: String,
    updatedAt: Date
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

mechanicSchema.index({ status: 1, isOnline: 1 });
mechanicSchema.index({ 'lastLocation.lat': 1, 'lastLocation.lng': 1 });

const Mechanic = mongoose.model('Mechanic', mechanicSchema);

module.exports = Mechanic;
