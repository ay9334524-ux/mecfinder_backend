const mongoose = require('mongoose');

/**
 * MechanicDebt - Tracks money owed by mechanic (negative wallet balance)
 * When mechanic collects CASH payment, company's share is recorded as debt
 * Next online payment auto-deducts this debt
 */
const mechanicDebtSchema = new mongoose.Schema({
  mechanicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mechanic',
    required: true,
    index: true,
  },
  
  // Source booking
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true,
    index: true,
  },
  
  // Debt details
  debtAmount: {
    type: Number,
    required: true, // Company's share from CASH collection
    min: 0,
  },
  
  reason: {
    type: String,
    enum: ['CASH_COLLECTION', 'PENALTY', 'ADJUSTMENT'],
    default: 'CASH_COLLECTION',
  },
  
  // Settlement tracking
  status: {
    type: String,
    enum: ['ACTIVE', 'SETTLED', 'PARTIAL'],
    default: 'ACTIVE',
    index: true,
  },
  
  settledAt: Date,
  
  // Partial settlement tracking
  settlementDetails: [{
    paymentId: String,
    deductedAmount: Number,
    deductedAt: Date,
    method: String, // 'AUTO_DEDUCT_ONLINE', 'MANUAL_PAYMENT', etc
  }],
  
  // Due date - must be settled within 24 hours or mechanic can't book
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  
  dueAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    index: true,
  },
  
  // Memo for mechanic
  notes: String,
  
  // Auto-settlement flag
  autoSettledAt: Date,
}, {
  timestamps: true,
});

// Index for finding active debts for a mechanic
mechanicDebtSchema.index({ mechanicId: 1, status: 1 });

// Static: Create new debt
mechanicDebtSchema.statics.createDebt = async function(mechanicId, bookingId, debtAmount) {
  return this.create({
    mechanicId,
    bookingId,
    debtAmount,
    status: 'ACTIVE',
    reason: 'CASH_COLLECTION',
  });
};

// Static: Get total active debt for mechanic
mechanicDebtSchema.statics.getTotalActiveDebt = async function(mechanicId) {
  const debts = await this.find({
    mechanicId,
    status: { $in: ['ACTIVE', 'PARTIAL'] },
  });
  
  return debts.reduce((sum, debt) => {
    const settled = debt.settlementDetails?.reduce((s, detail) => s + (detail.deductedAmount || 0), 0) || 0;
    return sum + (debt.debtAmount - settled);
  }, 0);
};

// Static: Settle debt (auto or manual)
mechanicDebtSchema.statics.settleDebt = async function(mechanicId, paymentId, deductAmount, method = 'AUTO_DEDUCT_ONLINE') {
  // Find active debts
  const debts = await this.find({
    mechanicId,
    status: { $in: ['ACTIVE', 'PARTIAL'] },
  }).sort({ createdAt: 1 }); // FIFO - oldest first

  let remaining = deductAmount;
  let updated = false;

  for (const debt of debts) {
    if (remaining <= 0) break;

    const settled = debt.settlementDetails?.reduce((s, detail) => s + (detail.deductedAmount || 0), 0) || 0;
    const outstandingDebt = debt.debtAmount - settled;

    if (outstandingDebt > 0) {
      const deductThis = Math.min(remaining, outstandingDebt);

      // Add settlement record
      debt.settlementDetails.push({
        paymentId,
        deductedAmount: deductThis,
        deductedAt: new Date(),
        method,
      });

      // Update status
      const newSettled = settled + deductThis;
      if (newSettled >= debt.debtAmount) {
        debt.status = 'SETTLED';
        debt.settledAt = new Date();
        debt.autoSettledAt = method === 'AUTO_DEDUCT_ONLINE' ? new Date() : undefined;
      } else {
        debt.status = 'PARTIAL';
      }

      await debt.save();
      remaining -= deductThis;
      updated = true;
    }
  }

  return {
    deductedAmount: deductAmount - remaining,
    /** Leftover payment that wasn't applied (NOT the remaining debt balance). */
    remainingDebt: remaining,
    unusedPayment: remaining,
    debtsSettled: updated,
  };
};

// Instance method: Get remaining balance
mechanicDebtSchema.methods.getRemainingBalance = function() {
  const settled = this.settlementDetails?.reduce((sum, detail) => sum + (detail.deductedAmount || 0), 0) || 0;
  return this.debtAmount - settled;
};

// Instance method: Check if overdue (24 hours passed)
mechanicDebtSchema.methods.isOverdue = function() {
  return new Date() > this.dueAt;
};

module.exports = mongoose.model('MechanicDebt', mechanicDebtSchema);
