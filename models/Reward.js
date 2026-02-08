const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['CASHBACK', 'DISCOUNT', 'FREE_SERVICE', 'VOUCHER', 'POINTS_MULTIPLIER'],
    required: true,
  },
  // Points required to redeem
  pointsRequired: {
    type: Number,
    required: true,
    min: 0,
  },
  // Value of reward
  value: {
    type: Number,
    required: true,
  },
  valueType: {
    type: String,
    enum: ['FIXED', 'PERCENTAGE'],
    default: 'FIXED',
  },
  maxValue: Number, // Cap for percentage rewards
  
  // Validity
  validFrom: {
    type: Date,
    default: Date.now,
  },
  validTill: Date,
  
  // Usage limits
  totalQuantity: Number, // Total available
  usedQuantity: {
    type: Number,
    default: 0,
  },
  perUserLimit: {
    type: Number,
    default: 1,
  },
  
  // Conditions
  minBookingAmount: Number,
  applicableServices: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
  }],
  applicableCategories: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceCategory',
  }],
  
  // Display
  imageUrl: String,
  iconName: String,
  priority: {
    type: Number,
    default: 0,
  },
  
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE', 'EXPIRED'],
    default: 'ACTIVE',
  },
  
  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  
}, {
  timestamps: true,
});

// Indexes
rewardSchema.index({ status: 1, validTill: 1 });
rewardSchema.index({ pointsRequired: 1 });

// Check if reward is available
rewardSchema.methods.isAvailable = function() {
  const now = new Date();
  if (this.status !== 'ACTIVE') return false;
  if (this.validTill && now > this.validTill) return false;
  if (this.totalQuantity && this.usedQuantity >= this.totalQuantity) return false;
  return true;
};

module.exports = mongoose.model('Reward', rewardSchema);
