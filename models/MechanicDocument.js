const mongoose = require('mongoose');

const mechanicDocumentSchema = new mongoose.Schema({
  mechanicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mechanic',
    required: true,
  },
  documentType: {
    type: String,
    enum: [
      'AADHAAR_FRONT',
      'AADHAAR_BACK',
      'PAN_CARD',
      'DRIVING_LICENSE',
      'VEHICLE_RC',
      'PROFILE_PHOTO',
      'ADDRESS_PROOF',
      'SKILL_CERTIFICATE',
      'OTHER',
    ],
    required: true,
  },
  documentNumber: {
    type: String, // Aadhaar number, PAN number, etc. (encrypted in production)
  },
  documentUrl: {
    type: String,
    required: true,
  },
  cloudinaryPublicId: String,
  
  // Verification
  status: {
    type: String,
    enum: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'],
    default: 'PENDING',
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  verifiedAt: Date,
  rejectionReason: String,
  
  // Document validity
  issueDate: Date,
  expiryDate: Date,
  isExpired: {
    type: Boolean,
    default: false,
  },
  
  // Metadata
  fileName: String,
  fileSize: Number,
  mimeType: String,
  
  // Audit
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
  lastUpdatedAt: Date,
  
}, {
  timestamps: true,
});

// Indexes
mechanicDocumentSchema.index({ mechanicId: 1, documentType: 1 });
mechanicDocumentSchema.index({ status: 1 });

// Compound unique index (one document type per mechanic)
mechanicDocumentSchema.index(
  { mechanicId: 1, documentType: 1 },
  { unique: true }
);

// Check if document is expired
mechanicDocumentSchema.methods.checkExpiry = function() {
  if (this.expiryDate && new Date() > this.expiryDate) {
    this.isExpired = true;
    this.status = 'EXPIRED';
  }
  return this.isExpired;
};

// Approve document
mechanicDocumentSchema.methods.approve = async function(adminId) {
  this.status = 'APPROVED';
  this.verifiedBy = adminId;
  this.verifiedAt = new Date();
  this.lastUpdatedAt = new Date();
  return this.save();
};

// Reject document
mechanicDocumentSchema.methods.reject = async function(adminId, reason) {
  this.status = 'REJECTED';
  this.verifiedBy = adminId;
  this.verifiedAt = new Date();
  this.rejectionReason = reason;
  this.lastUpdatedAt = new Date();
  return this.save();
};

// Static method to get document verification status for a mechanic
mechanicDocumentSchema.statics.getVerificationStatus = async function(mechanicId) {
  const requiredDocs = ['AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN_CARD', 'PROFILE_PHOTO'];
  const docs = await this.find({ mechanicId });
  
  const status = {
    totalRequired: requiredDocs.length,
    uploaded: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    missing: [],
    isComplete: false,
    isVerified: false,
  };
  
  const uploadedTypes = docs.map(d => d.documentType);
  
  requiredDocs.forEach(type => {
    if (!uploadedTypes.includes(type)) {
      status.missing.push(type);
    }
  });
  
  docs.forEach(doc => {
    if (requiredDocs.includes(doc.documentType)) {
      status.uploaded++;
      if (doc.status === 'APPROVED') status.approved++;
      else if (doc.status === 'PENDING' || doc.status === 'UNDER_REVIEW') status.pending++;
      else if (doc.status === 'REJECTED') status.rejected++;
    }
  });
  
  status.isComplete = status.uploaded === status.totalRequired;
  status.isVerified = status.approved === status.totalRequired;
  
  return status;
};

module.exports = mongoose.model('MechanicDocument', mechanicDocumentSchema);
