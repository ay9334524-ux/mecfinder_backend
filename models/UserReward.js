const mongoose = require('mongoose');

const userRewardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Points system
  totalPoints: {
    type: Number,
    default: 0,
  },
  availablePoints: {
    type: Number,
    default: 0,
  },
  redeemedPoints: {
    type: Number,
    default: 0,
  },
  expiredPoints: {
    type: Number,
    default: 0,
  },
  
  // Points history
  pointsHistory: [{
    type: {
      type: String,
      enum: ['EARNED', 'REDEEMED', 'EXPIRED', 'BONUS', 'ADJUSTMENT'],
    },
    points: Number,
    source: {
      type: String,
      enum: ['BOOKING', 'REFERRAL', 'REVIEW', 'PROMO', 'SIGNUP', 'BIRTHDAY', 'ADMIN'],
    },
    referenceId: String, // Booking ID, etc.
    description: String,
    expiresAt: Date,
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
  
  // Redeemed rewards
  redeemedRewards: [{
    rewardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Reward',
    },
    rewardName: String,
    pointsUsed: Number,
    value: Number,
    couponCode: String,
    status: {
      type: String,
      enum: ['ACTIVE', 'USED', 'EXPIRED'],
      default: 'ACTIVE',
    },
    usedOnBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
    },
    redeemedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: Date,
    usedAt: Date,
  }],
  
  // Tier system (future enhancement)
  tier: {
    type: String,
    enum: ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'],
    default: 'BRONZE',
  },
  tierUpdatedAt: Date,
  
}, {
  timestamps: true,
});

// Indexes
userRewardSchema.index({ userId: 1 });

// Static method to get or create
userRewardSchema.statics.getOrCreate = async function(userId) {
  let record = await this.findOne({ userId });
  if (!record) {
    record = await this.create({ userId });
  }
  return record;
};

// Method to add points
userRewardSchema.methods.addPoints = async function(points, source, referenceId, description, expiresInDays = 365) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);
  
  this.pointsHistory.push({
    type: 'EARNED',
    points,
    source,
    referenceId,
    description,
    expiresAt,
  });
  
  this.totalPoints += points;
  this.availablePoints += points;
  
  // Update tier based on total points
  this.updateTier();
  
  return this.save();
};

// Method to redeem points
userRewardSchema.methods.redeemPoints = async function(points, rewardId, rewardName, value, expiresInDays = 30) {
  if (this.availablePoints < points) {
    throw new Error('Insufficient points');
  }
  
  const couponCode = `RWD${Date.now().toString(36).toUpperCase()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);
  
  this.pointsHistory.push({
    type: 'REDEEMED',
    points: -points,
    source: 'BOOKING',
    description: `Redeemed for ${rewardName}`,
  });
  
  this.redeemedRewards.push({
    rewardId,
    rewardName,
    pointsUsed: points,
    value,
    couponCode,
    expiresAt,
  });
  
  this.availablePoints -= points;
  this.redeemedPoints += points;
  
  return this.save();
};

// Method to update tier
userRewardSchema.methods.updateTier = function() {
  const points = this.totalPoints;
  let newTier = 'BRONZE';
  
  if (points >= 10000) newTier = 'PLATINUM';
  else if (points >= 5000) newTier = 'GOLD';
  else if (points >= 2000) newTier = 'SILVER';
  
  if (this.tier !== newTier) {
    this.tier = newTier;
    this.tierUpdatedAt = new Date();
  }
};

// Method to use a reward
userRewardSchema.methods.useReward = async function(couponCode, bookingId) {
  const reward = this.redeemedRewards.find(
    r => r.couponCode === couponCode && r.status === 'ACTIVE'
  );
  
  if (!reward) {
    throw new Error('Invalid or expired coupon');
  }
  
  if (reward.expiresAt && new Date() > reward.expiresAt) {
    reward.status = 'EXPIRED';
    await this.save();
    throw new Error('Coupon has expired');
  }
  
  reward.status = 'USED';
  reward.usedOnBooking = bookingId;
  reward.usedAt = new Date();
  
  return this.save();
};

module.exports = mongoose.model('UserReward', userRewardSchema);
