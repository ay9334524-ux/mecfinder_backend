const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  balance: {
    type: Number,
    default: 0,
    min: 0,
  },
  currency: {
    type: String,
    default: 'INR',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastTransactionAt: {
    type: Date,
  },
  totalCredits: {
    type: Number,
    default: 0,
  },
  totalDebits: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

// Index for faster lookups
walletSchema.index({ userId: 1 });

// Static method to get or create wallet
walletSchema.statics.getOrCreate = async function(userId) {
  let wallet = await this.findOne({ userId });
  if (!wallet) {
    wallet = await this.create({ userId });
  }
  return wallet;
};

// Method to credit amount
walletSchema.methods.credit = async function(amount) {
  this.balance += amount;
  this.totalCredits += amount;
  this.lastTransactionAt = new Date();
  return this.save();
};

// Method to debit amount
walletSchema.methods.debit = async function(amount) {
  if (this.balance < amount) {
    throw new Error('Insufficient balance');
  }
  this.balance -= amount;
  this.totalDebits += amount;
  this.lastTransactionAt = new Date();
  return this.save();
};

module.exports = mongoose.model('Wallet', walletSchema);
