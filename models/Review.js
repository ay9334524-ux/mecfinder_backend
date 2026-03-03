const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    mechanicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mechanic',
      required: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      required: true,
    },
    
    // Rating out of 5
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },
    
    // Review text
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    
    // Rating breakdown (optional)
    ratingBreakdown: {
      workQuality: {
        type: Number,
        min: 1,
        max: 5,
      },
      timelinessAndPunctuality: {
        type: Number,
        min: 1,
        max: 5,
      },
      professionalism: {
        type: Number,
        min: 1,
        max: 5,
      },
      communication: {
        type: Number,
        min: 1,
        max: 5,
      },
    },
    
    // Review status
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
    },
    
    // Admin response
    adminResponse: {
      message: String,
      respondedAt: Date,
      respondedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
      },
    },
    
    // Helpful votes
    helpfulVotes: {
      type: Number,
      default: 0,
    },
    
    // Images/attachments
    images: [String],
    
    // Flags/Reports
    flagged: {
      type: Boolean,
      default: false,
    },
    flagReason: String,
    flaggedAt: Date,
    
    // Metadata
    serviceSnapshot: {
      name: String,
      categoryName: String,
    },
    userSnapshot: {
      name: String,
      email: String,
      phoneNumber: String,
    },
    mechanicSnapshot: {
      name: String,
      email: String,
      phoneNumber: String,
    },
  },
  {
    timestamps: true,
  }
);

// Index for better query performance
reviewSchema.index({ bookingId: 1 });
reviewSchema.index({ userId: 1 });
reviewSchema.index({ mechanicId: 1 });
reviewSchema.index({ serviceId: 1 });
reviewSchema.index({ rating: 1 });
reviewSchema.index({ status: 1 });
reviewSchema.index({ createdAt: -1 });

// Pre-save hook to populate snapshots
reviewSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  
  try {
    // Populate user snapshot
    const User = mongoose.model('User');
    const user = await User.findById(this.userId);
    if (user) {
      this.userSnapshot = {
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
      };
    }
    
    // Populate mechanic snapshot
    const Mechanic = mongoose.model('Mechanic');
    const mechanic = await Mechanic.findById(this.mechanicId);
    if (mechanic) {
      this.mechanicSnapshot = {
        name: mechanic.name,
        email: mechanic.email,
        phoneNumber: mechanic.phoneNumber,
      };
    }
    
    // Populate service snapshot
    const Service = mongoose.model('Service');
    const service = await Service.findById(this.serviceId);
    if (service) {
      this.serviceSnapshot = {
        name: service.name,
        categoryName: service.categoryName,
      };
    }
    
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Review', reviewSchema);
