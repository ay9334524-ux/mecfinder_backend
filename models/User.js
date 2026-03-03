const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    unique: true,
    required: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    required: true
  },
  gender: {
    type: String,
    enum: ["MALE", "FEMALE", "OTHER"]
  },
  role: {
    type: String,
    enum: ["USER"],
    default: "USER"
  },
  status: {
    type: String,
    enum: ["ACTIVE", "BANNED"],
    default: "ACTIVE"
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
  profileImageUrl: String,
  lastLocation: {
    lat: Number,
    lng: Number,
    address: String
  },
  isPhoneVerified: {
    type: Boolean,
    default: true
  },
  refreshTokenHash: String,
  lastLoginAt: Date,
  lastLoginIp: String,
  deviceInfo: String,
  
  // FCM Push Notifications
  fcmToken: {
    type: String,
    default: null
  },
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const User = mongoose.model('User', userSchema);

module.exports = User;