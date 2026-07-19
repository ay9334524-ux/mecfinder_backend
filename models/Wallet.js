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

// Method to debit amount.
//
// IMPORTANT: prefer `Wallet.atomicDebit(userId, amount)` for any concurrent
// path. This instance method does a non-atomic read-then-save and can permit
// overdraft when two debits race. Kept for legacy single-process scripts only.
walletSchema.methods.debit = async function(amount) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'wallet.debit() is unsafe under concurrency — use Wallet.atomicDebit(userId, amount) instead.'
    );
  }
  if (this.balance < amount) {
    throw new Error('Insufficient balance');
  }
  this.balance -= amount;
  this.totalDebits += amount;
  this.lastTransactionAt = new Date();
  return this.save();
};

/**
 * Atomic debit — uses conditional findOneAndUpdate so two parallel debits
 * cannot overdraw the wallet. Returns the updated wallet, or null if balance
 * was insufficient.
 */
walletSchema.statics.atomicDebit = async function(userId, amount) {
  if (!(amount > 0)) {
    throw new Error('Amount must be positive');
  }
  return this.findOneAndUpdate(
    { userId, balance: { $gte: amount } },
    {
      $inc: { balance: -amount, totalDebits: amount },
      $set: { lastTransactionAt: new Date() },
    },
    { new: true }
  );
};

/**
 * Atomic credit — single-document update for consistency.
 */
walletSchema.statics.atomicCredit = async function(userId, amount) {
  if (!(amount > 0)) {
    throw new Error('Amount must be positive');
  }
  // Ensure wallet exists.
  await this.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId, balance: 0 } },
    { upsert: true, new: true }
  );
  return this.findOneAndUpdate(
    { userId },
    {
      $inc: { balance: amount, totalCredits: amount },
      $set: { lastTransactionAt: new Date() },
    },
    { new: true }
  );
};

module.exports = mongoose.model('Wallet', walletSchema);
