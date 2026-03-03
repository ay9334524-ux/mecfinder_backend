const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    discountType: {
      type: String,
      enum: ['FIXED', 'PERCENTAGE'],
      required: true,
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },
    maxUsagePerUser: {
      type: Number,
      default: 1,
      min: 1,
    },
    maxTotalUsage: {
      type: Number,
      default: null,
    },
    currentUsage: {
      type: Number,
      default: 0,
    },
    minOrderAmount: {
      type: Number,
      default: 0,
    },
    maxDiscountAmount: {
      type: Number,
      default: null,
    },
    validFrom: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },
    // Track usage per user
    usageLog: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        bookingId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Booking',
        },
        usedAt: {
          type: Date,
          default: Date.now,
        },
        discountGiven: Number,
      },
    ],
  },
  { timestamps: true }
);

// Index for faster queries
couponSchema.index({ code: 1 });
couponSchema.index({ expiresAt: 1 });
couponSchema.index({ isActive: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
