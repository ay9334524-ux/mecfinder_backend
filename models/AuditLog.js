const mongoose = require('mongoose');

/**
 * Append-only audit trail for wallet, payouts, and platform fee flows (admin visibility).
 */
const auditLogSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: [
        'PAYOUT',
        'WALLET',
        'DEBT',
        'PAYMENT_LINK',
        'BOOKING_PAYMENT',
        'ADMIN',
      ],
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    mechanicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mechanic', index: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    amount: Number,
    status: String,
    message: String,
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
