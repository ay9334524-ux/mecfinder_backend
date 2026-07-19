const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

class CloudinaryService {
  constructor() {
    this.cloudinary = cloudinary;
  }

  /**
   * Upload a file to Cloudinary
   * @param {Buffer|String} file - File buffer or base64 string
   * @param {Object} options - Upload options
   * @returns {Promise<Object>} Upload result
   */
  async uploadFile(file, options = {}) {
    const defaultOptions = {
      folder: 'mecfinder',
      resource_type: 'auto',
      allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'webp'],
      ...options,
    };

    try {
      // Handle buffer or base64
      let uploadString = file;
      if (Buffer.isBuffer(file)) {
        uploadString = `data:image/png;base64,${file.toString('base64')}`;
      }

      const result = await cloudinary.uploader.upload(uploadString, defaultOptions);
      return {
        success: true,
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        size: result.bytes,
      };
    } catch (error) {
      console.error('Cloudinary upload error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Upload user avatar
   * @param {Buffer|String} file - File buffer or base64
   * @param {String} userId - User ID for naming
   * @returns {Promise<Object>} Upload result
   */
  async uploadUserAvatar(file, userId) {
    return this.uploadFile(file, {
      folder: 'mecfinder/avatars/users',
      public_id: `user_${userId}_${Date.now()}`,
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });
  }

  /**
   * Upload mechanic profile photo
   * @param {Buffer|String} file - File buffer or base64
   * @param {String} mechanicId - Mechanic ID
   * @returns {Promise<Object>} Upload result
   */
  async uploadMechanicPhoto(file, mechanicId) {
    return this.uploadFile(file, {
      folder: 'mecfinder/avatars/mechanics',
      public_id: `mechanic_${mechanicId}_${Date.now()}`,
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });
  }

  /**
   * Upload mechanic KYC document
   * @param {Buffer|String} file - File buffer or base64
   * @param {String} mechanicId - Mechanic ID
   * @param {String} documentType - Document type (AADHAAR, PAN, LICENSE, etc.)
   * @returns {Promise<Object>} Upload result
   */
  async uploadMechanicDocument(file, mechanicId, documentType) {
    return this.uploadFile(file, {
      folder: `mecfinder/documents/${mechanicId}`,
      public_id: `${documentType.toLowerCase()}_${Date.now()}`,
      resource_type: 'auto',
      access_mode: 'authenticated', // Restrict access
    });
  }

  /**
   * Upload service icon
   * @param {Buffer|String} file - File buffer or base64
   * @param {String} serviceName - Service name for naming
   * @returns {Promise<Object>} Upload result
   */
  async uploadServiceIcon(file, serviceName) {
    return this.uploadFile(file, {
      folder: 'mecfinder/services',
      public_id: `service_${serviceName.toLowerCase().replace(/\s+/g, '_')}`,
      transformation: [
        { width: 200, height: 200, crop: 'fill' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });
  }

  /**
   * Delete a file from Cloudinary
   * @param {String} publicId - Public ID of the file
   * @returns {Promise<Object>} Deletion result
   */
  async deleteFile(publicId) {
    try {
      const result = await cloudinary.uploader.destroy(publicId);
      return {
        success: result.result === 'ok',
        result: result.result,
      };
    } catch (error) {
      console.error('Cloudinary delete error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Generate a signed URL for private resources
   * @param {String} publicId - Public ID
   * @param {Object} options - Options including expiry
   * @returns {String} Signed URL
   */
  getSignedUrl(publicId, options = {}) {
    const defaultOptions = {
      type: 'authenticated',
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
      ...options,
    };
    return cloudinary.url(publicId, defaultOptions);
  }

  /**
   * Get optimized URL with transformations
   * @param {String} publicId - Public ID
   * @param {Object} transformations - Cloudinary transformations
   * @returns {String} Optimized URL
   */
  getOptimizedUrl(publicId, transformations = {}) {
    const defaultTransformations = {
      quality: 'auto',
      fetch_format: 'auto',
      ...transformations,
    };
    return cloudinary.url(publicId, defaultTransformations);
  }

  /**
   * Create upload signature for direct frontend uploads
   * @param {Object} params - Upload parameters
   * @returns {Object} Signature and timestamp
   */
  createUploadSignature(params = {}) {
    const timestamp = Math.round(new Date().getTime() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, ...params },
      process.env.CLOUDINARY_API_SECRET
    );
    return {
      timestamp,
      signature,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
    };
  }
}

module.exports = new CloudinaryService();
