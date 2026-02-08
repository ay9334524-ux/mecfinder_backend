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