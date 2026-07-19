const mongoose = require('mongoose');

const companyLedgerSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  mechanicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mechanic',
  },
  amount: {
    type: Number,
    required: true,
  },
  platformFeeAmount: {
    type: Number,
    default: 0,
  },
  gstAmount: {
    type: Number,
    default: 0,
  },
  paymentMethod: {
    type: String,
    enum: ['ONLINE', 'WALLET', 'CASH', 'UPI'],
    required: true,
  },
  status: {
    type: String,
    enum: ['DUE', 'SETTLED'],
    default: 'DUE',
  },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  settledAt: Date,
}, {
  timestamps: true,
});

companyLedgerSchema.index({ bookingId: 1 }, { unique: true });
companyLedgerSchema.index({ status: 1, createdAt: -1 });
companyLedgerSchema.index({ mechanicId: 1, createdAt: -1 });

module.exports = mongoose.model('CompanyLedger', companyLedgerSchema);
