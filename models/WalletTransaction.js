const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema({
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    enum: ['CREDIT', 'DEBIT'],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  balanceAfter: {
    type: Number,
    required: true,
  },
  source: {
    type: String,
    enum: [
      'RECHARGE',      // Added money via payment
      'CASHBACK',      // Cashback from booking
      'REFERRAL',      // Referral bonus
      'REWARD',        // Reward redemption
      'BOOKING',       // Payment for booking
      'REFUND',        // Refund from cancelled booking
      'PROMO',         // Promotional credit
      'ADJUSTMENT',    // Admin adjustment
    ],
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  referenceId: {
    type: String, // Order ID, Booking ID, etc.
  },
  referenceType: {
    type: String,
    enum: ['RAZORPAY_ORDER', 'BOOKING', 'REFERRAL', 'REWARD', 'PROMO', 'ADMIN'],
  },
  paymentDetails: {
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    method: String, // UPI, Card, NetBanking
  },
  status: {
    type: String,
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'],
    default: 'COMPLETED',
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
  },
}, {
  timestamps: true,
});

// Indexes
walletTransactionSchema.index({ walletId: 1, createdAt: -1 });
walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ referenceId: 1 });
walletTransactionSchema.index({ status: 1 });

// Virtual for formatted amount
walletTransactionSchema.virtual('formattedAmount').get(function() {
  const prefix = this.type === 'CREDIT' ? '+' : '-';
  return `${prefix}₹${this.amount.toFixed(2)}`;
});

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
