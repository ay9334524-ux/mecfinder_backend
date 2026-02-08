const mongoose = require('mongoose');

const mechanicPayoutSchema = new mongoose.Schema({
  mechanicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mechanic',
    required: true,
  },
  payoutId: {
    type: String,
    unique: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 1,
  },
  // Bank details snapshot (in case bank details change)
  bankDetails: {
    accountHolderName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    ifscCode: { type: String, required: true },
    bankName: String,
    upiId: String,
  },
  status: {
    type: String,
    enum: [
      'REQUESTED',    // Payout requested
      'PROCESSING',   // Being processed
      'COMPLETED',    // Successfully transferred
      'FAILED',       // Transfer failed
      'CANCELLED',    // Cancelled by admin
      'ON_HOLD',      // On hold for verification
    ],
    default: 'REQUESTED',
  },
  // Payment gateway details
  paymentGateway: {
    type: String,
    enum: ['RAZORPAY', 'MANUAL', 'BANK_TRANSFER'],
    default: 'RAZORPAY',
  },
  razorpayPayoutId: String,
  razorpayFundAccountId: String,
  transactionId: String,        // UTR number
  
  // Timestamps
  requestedAt: {
    type: Date,
    default: Date.now,
  },
  processedAt: Date,
  completedAt: Date,
  failedAt: Date,
  
  // Failure info
  failureReason: String,
  retryCount: {
    type: Number,
    default: 0,
  },
  
  // Admin actions
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  adminNotes: String,
  
  // Period for which payout is made
  periodFrom: Date,
  periodTo: Date,
  
  // Breakdown
  breakdown: {
    totalEarnings: Number,
    platformFee: Number,
    tds: Number,           // Tax deducted at source
    otherDeductions: Number,
    netAmount: Number,
  },
  
  // Related bookings
  bookingIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
  }],
  
}, {
  timestamps: true,
});

// Indexes
mechanicPayoutSchema.index({ mechanicId: 1, createdAt: -1 });
mechanicPayoutSchema.index({ status: 1 });
mechanicPayoutSchema.index({ payoutId: 1 });

// Auto-generate payout ID
mechanicPayoutSchema.pre('save', async function(next) {
  if (!this.payoutId) {
    const count = await this.constructor.countDocuments();
    this.payoutId = `PO${Date.now().toString(36).toUpperCase()}${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

// Method to mark as processing
mechanicPayoutSchema.methods.markProcessing = async function(processedBy) {
  this.status = 'PROCESSING';
  this.processedAt = new Date();
  this.processedBy = processedBy;
  return this.save();
};

// Method to mark as completed
mechanicPayoutSchema.methods.markCompleted = async function(transactionId, razorpayPayoutId) {
  this.status = 'COMPLETED';
  this.completedAt = new Date();
  this.transactionId = transactionId;
  this.razorpayPayoutId = razorpayPayoutId;
  return this.save();
};

// Method to mark as failed
mechanicPayoutSchema.methods.markFailed = async function(reason) {
  this.status = 'FAILED';
  this.failedAt = new Date();
  this.failureReason = reason;
  this.retryCount += 1;
  return this.save();
};

module.exports = mongoose.model('MechanicPayout', mechanicPayoutSchema);
