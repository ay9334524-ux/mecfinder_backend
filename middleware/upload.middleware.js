const multer = require('multer');
const path = require('path');
const ApiResponse = require('../utils/apiResponse');

// Memory storage for Cloudinary uploads
const storage = multer.memoryStorage();

// File filter for images
const imageFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpeg, jpg, png, gif, webp) are allowed'), false);
  }
};

// File filter for documents (images + PDF)
const documentFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
  ];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image and PDF files are allowed'), false);
  }
};

// Create multer instances
const uploadImage = multer({
  storage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

const uploadDocument = multer({
  storage,
  fileFilter: documentFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return ApiResponse.badRequest(res, 'File size too large');
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return ApiResponse.badRequest(res, 'Too many files');
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return ApiResponse.badRequest(res, 'Unexpected file field');
    }
    return ApiResponse.badRequest(res, err.message);
  }
  
  if (err) {
    return ApiResponse.badRequest(res, err.message);
  }
  
  next();
};

module.exports = {
  uploadImage,
  uploadDocument,
  handleMulterError,
};
