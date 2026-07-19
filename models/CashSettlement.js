const mongoose = require('mongoose');

const cashSettlementSchema = new mongoose.Schema({
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true,
  },
  mechanicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mechanic',
    required: true,
  },
  amountDue: {
    type: Number,
    required: true,
  },
  paymentMethod: {
    type: String,
    enum: ['CASH', 'UPI'],
    required: true,
  },
  transactionId: String,
  status: {
    type: String,
    enum: ['DUE', 'SETTLED'],
    default: 'DUE',
  },
  collectedAt: Date,
  settledAt: Date,
  settledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  adminNotes: String,
}, {
  timestamps: true,
});

cashSettlementSchema.index({ bookingId: 1 }, { unique: true });
cashSettlementSchema.index({ mechanicId: 1, status: 1 });

module.exports = mongoose.model('CashSettlement', cashSettlementSchema);
