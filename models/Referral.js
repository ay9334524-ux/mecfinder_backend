const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const referralSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  referralCode: {
    type: String,
    unique: true,
    uppercase: true,
  },
  referredUsers: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    phone: String,
    name: String,
    status: {
      type: String,
      enum: ['REGISTERED', 'FIRST_BOOKING', 'REWARDED'],
      default: 'REGISTERED',
    },
    referrerRewardGiven: {
      type: Boolean,
      default: false,
    },
    refereeRewardGiven: {
      type: Boolean,
      default: false,
    },
    referrerRewardAmount: Number,
    refereeRewardAmount: Number,
    createdAt: {
      type: Date,
      default: Date.now,
    },
    rewardedAt: Date,
  }],
  totalReferrals: {
    type: Number,
    default: 0,
  },
  successfulReferrals: {
    type: Number,
    default: 0,
  },
  totalEarnings: {
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

// Generate unique referral code before saving
referralSchema.pre('save', async function(next) {
  if (!this.referralCode) {
    // Generate a code like "MECF1234" or based on user name
    const randomPart = uuidv4().substring(0, 6).toUpperCase();
    this.referralCode = `MEC${randomPart}`;
  }
  next();
});

// Index for faster lookups
referralSchema.index({ referralCode: 1 });
referralSchema.index({ userId: 1 });

// Static method to get or create referral record
referralSchema.statics.getOrCreate = async function(userId) {
  let referral = await this.findOne({ userId });
  if (!referral) {
    referral = await this.create({ userId });
  }
  return referral;
};

// Method to add referred user
referralSchema.methods.addReferredUser = async function(referredUserId, phone, name) {
  // Check if already referred
  const existing = this.referredUsers.find(
    r => r.userId?.toString() === referredUserId?.toString() || r.phone === phone
  );
  
  if (existing) {
    throw new Error('User already referred');
  }

  this.referredUsers.push({
    userId: referredUserId,
    phone,
    name,
    status: 'REGISTERED',
  });
  this.totalReferrals += 1;
  
  return this.save();
};

// Method to update referral status and give rewards
referralSchema.methods.completeReferral = async function(referredUserId, referrerAmount, refereeAmount) {
  const referredUser = this.referredUsers.find(
    r => r.userId?.toString() === referredUserId?.toString()
  );

  if (!referredUser) {
    throw new Error('Referred user not found');
  }

  referredUser.status = 'REWARDED';
  referredUser.referrerRewardGiven = true;
  referredUser.refereeRewardGiven = true;
  referredUser.referrerRewardAmount = referrerAmount;
  referredUser.refereeRewardAmount = refereeAmount;
  referredUser.rewardedAt = new Date();

  this.successfulReferrals += 1;
  this.totalEarnings += referrerAmount;

  return this.save();
};

module.exports = mongoose.model('Referral', referralSchema);
