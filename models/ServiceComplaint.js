const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    mechanicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mechanic',
      required: true,
      index: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      required: true,
    },
    
    // Complaint details
    title: {
      type: String,
      required: true,
      maxlength: 100,
    },
    description: {
      type: String,
      required: true,
      maxlength: 1000,
    },
    category: {
      type: String,
      enum: ['QUALITY_ISSUE', 'BEHAVIOR', 'PRICING', 'TIME_ISSUE', 'OTHER'],
      required: true,
    },
    severity: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      default: 'MEDIUM',
    },
    
    // Images/attachments
    images: [{
      type: String, // URL to image
    }],
    
    // Status tracking
    status: {
      type: String,
      enum: ['OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED', 'CLOSED'],
      default: 'OPEN',
      index: true,
    },
    
    // Resolution details
    adminNotes: {
      type: String,
      maxlength: 500,
    },
    resolution: {
      type: String,
      maxlength: 500,
    },
    refundAmount: {
      type: Number,
      default: 0,
    },
    
    // Timestamps
    resolvedAt: Date,
    closedAt: Date,
  },
  {
    timestamps: true,
  }
);

// Index for admin queries
complaintSchema.index({ status: 1, createdAt: -1 });
complaintSchema.index({ mechanicId: 1, status: 1 });
complaintSchema.index({ userId: 1, createdAt: -1 });

// Populate user and mechanic details
complaintSchema.pre(/^find/, function() {
  this.populate('userId', 'name phone email avatar')
    .populate('mechanicId', 'name phone ratingAverage totalJobsCompleted')
    .populate('serviceId', 'name icon')
    .populate('bookingId', 'bookingId pricing');
});

module.exports = mongoose.model('ServiceComplaint', complaintSchema);
