const mongoose = require('mongoose');

const regionPricingSchema = new mongoose.Schema({
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  },
  regionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
    required: true
  },
  // Pricing components
  basePrice: {
    type: Number,
    required: true,
    min: 0
  },
  gstPercent: {
    type: Number,
    default: 18,
    min: 0,
    max: 100
  },
  platformFeePercent: {
    type: Number,
    default: 25,
    min: 0,
    max: 100
  },
  travelCharge: {
    type: Number,
    default: 88,
    min: 0
  },
  // Calculated fields (stored for quick access)
  gstAmount: {
    type: Number,
    default: 0
  },
  platformFeeAmount: {
    type: Number,
    default: 0
  },
  totalPrice: {
    type: Number,
    default: 0
  },
  // Revenue split
  mechanicEarning: {
    type: Number,
    default: 0
  },
  companyEarning: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound unique index: one pricing per service per region
regionPricingSchema.index({ serviceId: 1, regionId: 1 }, { unique: true });

// Calculate pricing before save
regionPricingSchema.pre('save', function(next) {
  // GST on base price
  this.gstAmount = Math.round((this.basePrice * this.gstPercent) / 100);
  
  // Platform fee on base price
  this.platformFeeAmount = Math.round((this.basePrice * this.platformFeePercent) / 100);
  
  // Total = Base + GST + Platform Fee + Travel Charge
  this.totalPrice = this.basePrice + this.gstAmount + this.platformFeeAmount + this.travelCharge;
  
  // Mechanic gets: Base Price + Travel Charge
  this.mechanicEarning = this.basePrice + this.travelCharge;
  
  // Company gets: GST + Platform Fee
  this.companyEarning = this.gstAmount + this.platformFeeAmount;
  
  this.updatedAt = Date.now();
  next();
});

const RegionPricing = mongoose.model('RegionPricing', regionPricingSchema);

module.exports = RegionPricing;
