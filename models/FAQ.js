const mongoose = require('mongoose');

const faqSchema = new mongoose.Schema({
  question: {
    type: String,
    required: true,
  },
  answer: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    enum: ['GENERAL', 'BOOKING', 'PAYMENT', 'MECHANIC', 'WALLET', 'REWARDS', 'ACCOUNT', 'SAFETY'],
    default: 'GENERAL',
  },
  targetAudience: {
    type: String,
    enum: ['USER', 'MECHANIC', 'BOTH'],
    default: 'BOTH',
  },
  tags: [String],
  order: {
    type: Number,
    default: 0,
  },
  viewCount: {
    type: Number,
    default: 0,
  },
  helpfulCount: {
    type: Number,
    default: 0,
  },
  notHelpfulCount: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
}, {
  timestamps: true,
});

// Indexes
faqSchema.index({ category: 1, status: 1, order: 1 });
faqSchema.index({ targetAudience: 1, status: 1 });
faqSchema.index({ tags: 1 });

// Text index for search
faqSchema.index({ question: 'text', answer: 'text', tags: 'text' });

module.exports = mongoose.model('FAQ', faqSchema);
