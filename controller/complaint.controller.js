const ServiceComplaint = require('../models/ServiceComplaint');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const notificationService = require('../services/notification.service');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Create a new complaint (user)
 * POST /api/complaints
 */
const createComplaint = asyncHandler(async (req, res) => {
  const { bookingId, title, description, category, severity, images } = req.body;

  // Verify booking exists and belongs to user
  const booking = await Booking.findOne({
    _id: bookingId,
    userId: req.user.id,
    status: 'COMPLETED',
  });

  if (!booking) {
    return ApiResponse.badRequest(res, 'Booking not found or not completed');
  }

  // Check if complaint already exists for this booking
  const existingComplaint = await ServiceComplaint.findOne({
    bookingId,
    status: { $ne: 'CLOSED' },
  });

  if (existingComplaint) {
    return ApiResponse.badRequest(res, 'A complaint already exists for this booking');
  }

  const complaint = await ServiceComplaint.create({
    bookingId,
    userId: req.user.id,
    mechanicId: booking.mechanicId,
    serviceId: booking.serviceId,
    title,
    description,
    category,
    severity: severity || 'MEDIUM',
    images: images || [],
  });

  // Fetch with populated data
  const populatedComplaint = await ServiceComplaint.findById(complaint._id);

  // Note: Admin notification would be sent here if needed
  // For now, admins can see complaints in the admin panel

  ApiResponse.success(res, { complaint: populatedComplaint }, 'Complaint created successfully', 201);
});

/**
 * Get user complaints
 * GET /api/complaints
 */
const getUserComplaints = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;

  const filter = { userId: req.user.id };
  if (status) filter.status = status;

  const complaints = await ServiceComplaint.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await ServiceComplaint.countDocuments(filter);

  ApiResponse.success(res, {
    complaints,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * Get complaint details
 * GET /api/complaints/:id
 */
const getComplaintDetails = asyncHandler(async (req, res) => {
  const complaint = await ServiceComplaint.findOne({
    _id: req.params.id,
    userId: req.user.id,
  });

  if (!complaint) {
    return ApiResponse.notFound(res, 'Complaint not found');
  }

  ApiResponse.success(res, { complaint });
});

/**
 * Admin: Get all complaints
 * GET /api/admin/complaints
 */
const getAllComplaints = asyncHandler(async (req, res) => {
  const { status, severity, mechanicId, page = 1, limit = 20, sortBy = 'createdAt' } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (severity) filter.severity = severity;
  if (mechanicId) filter.mechanicId = mechanicId;

  const validSortFields = ['createdAt', 'severity', 'updatedAt'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

  const complaints = await ServiceComplaint.find(filter)
    .sort({ [sortField]: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await ServiceComplaint.countDocuments(filter);

  // Get stats
  const stats = {
    total: await ServiceComplaint.countDocuments(),
    open: await ServiceComplaint.countDocuments({ status: 'OPEN' }),
    inReview: await ServiceComplaint.countDocuments({ status: 'IN_REVIEW' }),
    resolved: await ServiceComplaint.countDocuments({ status: 'RESOLVED' }),
    rejected: await ServiceComplaint.countDocuments({ status: 'REJECTED' }),
  };

  ApiResponse.success(res, {
    complaints,
    stats,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * Admin: Get complaint details with all info
 * GET /api/admin/complaints/:id
 */
const getComplaintDetailsAdmin = asyncHandler(async (req, res) => {
  const complaint = await ServiceComplaint.findById(req.params.id);

  if (!complaint) {
    return ApiResponse.notFound(res, 'Complaint not found');
  }

  ApiResponse.success(res, { complaint });
});

/**
 * Admin: Update complaint status
 * PUT /api/admin/complaints/:id
 */
const updateComplaintStatus = asyncHandler(async (req, res) => {
  const { status, adminNotes, resolution, refundAmount } = req.body;

  const complaint = await ServiceComplaint.findById(req.params.id);

  if (!complaint) {
    return ApiResponse.notFound(res, 'Complaint not found');
  }

  // Update status
  if (status) {
    complaint.status = status;
    
    if (status === 'RESOLVED') {
      complaint.resolvedAt = new Date();
      complaint.adminNotes = adminNotes;
      complaint.resolution = resolution;
      complaint.refundAmount = refundAmount || 0;
    }
    
    if (status === 'CLOSED') {
      complaint.closedAt = new Date();
    }
  }

  if (adminNotes) complaint.adminNotes = adminNotes;

  await complaint.save();

  // Notify user about status change
  if (status) {
    let message = '';
    switch (status) {
      case 'IN_REVIEW':
        message = 'Your complaint is being reviewed by our team';
        break;
      case 'RESOLVED':
        message = `Your complaint has been resolved. ${resolution || ''}${refundAmount ? ` Refund of ₹${refundAmount} has been processed.` : ''}`;
        break;
      case 'REJECTED':
        message = 'Your complaint has been reviewed and rejected';
        break;
      case 'CLOSED':
        message = 'Your complaint has been closed';
        break;
    }

    // Send notification to user about complaint status update
    if (message) {
      try {
        const notificationController = require('./notification.controller');
        await notificationController.sendBookingNotification(
          complaint.userId,
          'Complaint Update',
          message,
          complaint._id
        );
      } catch (err) {
        console.error('Error sending complaint notification:', err);
      }
    }
  }

  const updatedComplaint = await ServiceComplaint.findById(complaint._id);

  ApiResponse.success(res, { complaint: updatedComplaint }, 'Complaint updated successfully');
});

/**
 * Get complaints for a mechanic (mechanic view)
 * GET /api/mechanic/complaints
 */
const getMechanicComplaints = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;

  const filter = { mechanicId: req.mechanic.id };
  if (status) filter.status = status;

  const complaints = await ServiceComplaint.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await ServiceComplaint.countDocuments(filter);

  // Get stats
  const stats = {
    total: await ServiceComplaint.countDocuments({ mechanicId: req.mechanic.id }),
    open: await ServiceComplaint.countDocuments({ mechanicId: req.mechanic.id, status: 'OPEN' }),
  };

  ApiResponse.success(res, {
    complaints,
    stats,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

module.exports = {
  createComplaint,
  getUserComplaints,
  getComplaintDetails,
  getAllComplaints,
  getComplaintDetailsAdmin,
  updateComplaintStatus,
  getMechanicComplaints,
};
