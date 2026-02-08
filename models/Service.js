const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  slug: {
    type: String,
    required: true,
    lowercase: true
  },
  description: String,
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceCategory',
    required: true
  },
  basePrice: {
    type: Number,
    required: true,
    min: 0
  },
  estimatedTime: {
    type: Number, // in minutes
    default: 60
  },
  icon: {
    type: String,
    default: '🔧'
  },
  vehicleTypes: [{
    type: String,
    enum: ['BIKE', 'CAR', 'TRUCK', 'AUTO']
  }],
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

// Compound index for unique service name per category
serviceSchema.index({ name: 1, categoryId: 1 }, { unique: true });

const Service = mongoose.model('Service', serviceSchema);

module.exports = Service;
