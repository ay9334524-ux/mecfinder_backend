const mongoose = require('mongoose');

const mechanicEarningSchema = new mongoose.Schema({
  mechanicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mechanic',
    required: true,
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true,
  },
  bookingCode: String, // MF000001
  
  // Earning details
  type: {
    type: String,
    enum: ['JOB', 'BONUS', 'INCENTIVE', 'TIP', 'ADJUSTMENT', 'PENALTY'],
    default: 'JOB',
  },
  
  // Amounts
  grossAmount: {
    type: Number,
    required: true,
  },
  platformFee: {
    type: Number,
    default: 0,
  },
  platformFeePercent: {
    type: Number,
    default: 25,
  },
  gstOnPlatformFee: {
    type: Number,
    default: 0,
  },
  tds: {
    type: Number,
    default: 0,
  },
  netAmount: {
    type: Number,
    required: true,
  },
  
  // Status
  status: {
    type: String,
    enum: ['PENDING', 'AVAILABLE', 'PROCESSING', 'PAID', 'ON_HOLD'],
    default: 'PENDING',
  },
  
  // When this earning becomes available for payout
  availableAt: Date,
  
  // Payout reference
  payoutId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MechanicPayout',
  },
  paidAt: Date,
  
  // Service details snapshot
  serviceDetails: {
    name: String,
    category: String,
  },
  
  // Customer info (for mechanic's reference)
  customerName: String,
  customerPhone: String,
  
  // Location
  location: {
    address: String,
    city: String,
  },
  
  // Date of service
  serviceDate: {
    type: Date,
    required: true,
  },
  
  description: String,
  
}, {
  timestamps: true,
});

// Indexes
mechanicEarningSchema.index({ mechanicId: 1, createdAt: -1 });
mechanicEarningSchema.index({ mechanicId: 1, status: 1 });
mechanicEarningSchema.index({ mechanicId: 1, serviceDate: -1 });
mechanicEarningSchema.index({ bookingId: 1 });
mechanicEarningSchema.index({ payoutId: 1 });

// Static method to get earnings summary
mechanicEarningSchema.statics.getEarningsSummary = async function(mechanicId, startDate, endDate) {
  const match = {
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
    status: { $in: ['AVAILABLE', 'PROCESSING', 'PAID'] },
  };
  
  if (startDate && endDate) {
    match.serviceDate = { $gte: startDate, $lte: endDate };
  }
  
  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$status',
        totalGross: { $sum: '$grossAmount' },
        totalNet: { $sum: '$netAmount' },
        count: { $sum: 1 },
      },
    },
  ]);
  
  const summary = {
    totalEarnings: 0,
    availableBalance: 0,
    processingAmount: 0,
    paidAmount: 0,
    totalJobs: 0,
  };
  
  result.forEach(r => {
    summary.totalEarnings += r.totalNet;
    summary.totalJobs += r.count;
    if (r._id === 'AVAILABLE') summary.availableBalance = r.totalNet;
    else if (r._id === 'PROCESSING') summary.processingAmount = r.totalNet;
    else if (r._id === 'PAID') summary.paidAmount = r.totalNet;
  });
  
  return summary;
};

// Static method to get daily earnings for a period
mechanicEarningSchema.statics.getDailyEarnings = async function(mechanicId, days = 7) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);
  
  return this.aggregate([
    {
      $match: {
        mechanicId: new mongoose.Types.ObjectId(mechanicId),
        serviceDate: { $gte: startDate },
        status: { $in: ['AVAILABLE', 'PROCESSING', 'PAID'] },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$serviceDate' },
        },
        totalNet: { $sum: '$netAmount' },
        jobs: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
};

// Method to mark as available (after holding period)
mechanicEarningSchema.methods.makeAvailable = async function() {
  this.status = 'AVAILABLE';
  this.availableAt = new Date();
  return this.save();
};

// Method to mark as paid
mechanicEarningSchema.methods.markPaid = async function(payoutId) {
  this.status = 'PAID';
  this.payoutId = payoutId;
  this.paidAt = new Date();
  return this.save();
};

module.exports = mongoose.model('MechanicEarning', mechanicEarningSchema);
