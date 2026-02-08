const mongoose = require('mongoose');

// Counter for auto-incrementing booking ID
const counterSchema = new mongoose.Schema({
  _id: String,
  seq: Number,
});
const Counter = mongoose.model('Counter', counterSchema);

const bookingSchema = new mongoose.Schema({
  bookingId: {
    type: String,
    unique: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  mechanicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mechanic',
  },
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true,
  },
  regionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
  },
  
  // Service snapshot (in case service details change later)
  serviceSnapshot: {
    name: String,
    categoryName: String,
    icon: String,
  },
  
  // Location
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true,
    },
    address: String,
    landmark: String,
  },
  
  // Vehicle details
  vehicleDetails: {
    type: {
      type: String,
      enum: ['BIKE', 'CAR', 'TRUCK', 'AUTO'],
    },
    make: String,
    model: String,
    registrationNumber: String,
  },
  
  // Status tracking
  status: {
    type: String,
    enum: [
      'PENDING',        // Just created, finding mechanic
      'SEARCHING',      // Actively searching for mechanic
      'ASSIGNED',       // Mechanic assigned, waiting acceptance
      'ACCEPTED',       // Mechanic accepted
      'EN_ROUTE',       // Mechanic on the way
      'ARRIVED',        // Mechanic arrived at location
      'IN_PROGRESS',    // Work in progress
      'COMPLETED',      // Work completed
      'CANCELLED',      // Cancelled by user or mechanic
      'EXPIRED',        // No mechanic found
    ],
    default: 'PENDING',
  },
  
  // Pricing
  pricing: {
    basePrice: { type: Number, default: 0 },
    gstPercent: { type: Number, default: 18 },
    gstAmount: { type: Number, default: 0 },
    platformFeePercent: { type: Number, default: 25 },
    platformFeeAmount: { type: Number, default: 0 },
    travelCharge: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    promoCode: String,
    totalAmount: { type: Number, required: true },
    mechanicEarning: { type: Number, default: 0 },
    companyEarning: { type: Number, default: 0 },
  },
  
  // Payment
  paymentStatus: {
    type: String,
    enum: ['PENDING', 'PAID', 'PARTIALLY_PAID', 'REFUNDED', 'FAILED'],
    default: 'PENDING',
  },
  paymentMethod: {
    type: String,
    enum: ['WALLET', 'CARD', 'UPI', 'NETBANKING', 'CASH', 'MIXED'],
  },
  paymentDetails: {
    razorpayOrderId: String,
    razorpayPaymentId: String,
    walletAmount: Number,
    onlineAmount: Number,
    cashAmount: Number,
  },
  
  // Timestamps for tracking
  scheduledAt: Date,         // For scheduled bookings
  searchStartedAt: Date,
  assignedAt: Date,
  acceptedAt: Date,
  enRouteAt: Date,
  arrivedAt: Date,
  startedAt: Date,
  completedAt: Date,
  cancelledAt: Date,
  
  // Cancellation
  cancellationReason: String,
  cancelledBy: {
    type: String,
    enum: ['USER', 'MECHANIC', 'SYSTEM', 'ADMIN'],
  },
  
  // Rating & Review
  rating: {
    type: Number,
    min: 1,
    max: 5,
  },
  review: String,
  ratedAt: Date,
  
  // Mechanic rating by user
  userRatingByMechanic: {
    rating: Number,
    review: String,
    ratedAt: Date,
  },
  
  // Additional info
  notes: String,           // User notes
  mechanicNotes: String,   // Mechanic notes
  adminNotes: String,      // Admin notes
  
  // OTP for verification
  verificationOtp: String,
  otpVerifiedAt: Date,
  
  // Mechanic location tracking
  mechanicLocation: {
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: [Number],
    updatedAt: Date,
  },
  
  // Estimated times
  estimatedArrival: Number, // Minutes
  estimatedCompletion: Number, // Minutes
  actualDuration: Number,   // Minutes
  
}, {
  timestamps: true,
});

// Geospatial index for location-based queries
bookingSchema.index({ 'location': '2dsphere' });
bookingSchema.index({ 'mechanicLocation': '2dsphere' });

// Other indexes
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ mechanicId: 1, createdAt: -1 });
bookingSchema.index({ status: 1 });
bookingSchema.index({ bookingId: 1 });
bookingSchema.index({ paymentStatus: 1 });

// Auto-generate booking ID
bookingSchema.pre('save', async function() {
  if (!this.bookingId) {
    const counter = await Counter.findByIdAndUpdate(
      'bookingId',
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this.bookingId = `MF${String(counter.seq).padStart(6, '0')}`;
  }
});

// Virtual for duration
bookingSchema.virtual('duration').get(function() {
  if (this.completedAt && this.startedAt) {
    return Math.round((this.completedAt - this.startedAt) / 60000); // Minutes
  }
  return null;
});

// Method to update status with timestamp
bookingSchema.methods.updateStatus = async function(newStatus, additionalData = {}) {
  this.status = newStatus;
  
  const now = new Date();
  switch (newStatus) {
    case 'SEARCHING':
      this.searchStartedAt = now;
      break;
    case 'ASSIGNED':
      this.assignedAt = now;
      break;
    case 'ACCEPTED':
      this.acceptedAt = now;
      break;
    case 'EN_ROUTE':
      this.enRouteAt = now;
      break;
    case 'ARRIVED':
      this.arrivedAt = now;
      break;
    case 'IN_PROGRESS':
      this.startedAt = now;
      break;
    case 'COMPLETED':
      this.completedAt = now;
      if (this.startedAt) {
        this.actualDuration = Math.round((now - this.startedAt) / 60000);
      }
      break;
    case 'CANCELLED':
      this.cancelledAt = now;
      this.cancellationReason = additionalData.reason;
      this.cancelledBy = additionalData.cancelledBy;
      break;
  }
  
  return this.save();
};

module.exports = mongoose.model('Booking', bookingSchema);
