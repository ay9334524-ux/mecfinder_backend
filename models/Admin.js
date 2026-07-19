const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    unique: true,
    lowercase: true,
    required: true
  },
  phone: String,
  passwordHash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ["SUPER_ADMIN", "ADMIN", "SUPPORT"],
    default: "ADMIN"
  },
  status: {
    type: String,
    enum: ["ACTIVE", "DISABLED"],
    default: "ACTIVE"
  },
  lastLoginAt: Date,
  lastLoginIp: String,
  permissions: {
    canApproveMechanic: Boolean,
    canSuspendMechanic: Boolean,
    canViewPayments: Boolean
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

const Admin = mongoose.model('Admin', adminSchema);

module.exports = Admin;