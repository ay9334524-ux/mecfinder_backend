const FAQ = require('../models/FAQ');
const SupportQuery = require('../models/SupportQuery');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Get FAQs
 * GET /api/help/faq
 */
const getFAQs = asyncHandler(async (req, res) => {
  const { category, audience = 'USER' } = req.query;

  const filter = {
    status: 'ACTIVE',
    targetAudience: { $in: [audience, 'BOTH'] },
  };

  if (category) filter.category = category;

  const faqs = await FAQ.find(filter)
    .sort({ category: 1, order: 1 })
    .select('-__v');

  // Group by category
  const groupedFAQs = faqs.reduce((acc, faq) => {
    if (!acc[faq.category]) {
      acc[faq.category] = [];
    }
    acc[faq.category].push(faq);
    return acc;
  }, {});

  ApiResponse.success(res, { faqs: groupedFAQs });
});

/**
 * Search FAQs
 * GET /api/help/faq/search
 */
const searchFAQs = asyncHandler(async (req, res) => {
  const { q, audience = 'USER' } = req.query;

  if (!q || q.length < 2) {
    return ApiResponse.badRequest(res, 'Search query must be at least 2 characters');
  }

  const faqs = await FAQ.find({
    $text: { $search: q },
    status: 'ACTIVE',
    targetAudience: { $in: [audience, 'BOTH'] },
  })
    .sort({ score: { $meta: 'textScore' } })
    .limit(10);

  ApiResponse.success(res, { faqs });
});

/**
 * Mark FAQ as helpful
 * POST /api/help/faq/:id/helpful
 */
const markFAQHelpful = asyncHandler(async (req, res) => {
  const { helpful } = req.body; // true or false

  const update = helpful
    ? { $inc: { helpfulCount: 1, viewCount: 1 } }
    : { $inc: { notHelpfulCount: 1, viewCount: 1 } };

  const faq = await FAQ.findByIdAndUpdate(req.params.id, update, { new: true });

  if (!faq) {
    return ApiResponse.notFound(res, 'FAQ not found');
  }

  ApiResponse.success(res, null, 'Feedback recorded');
});

/**
 * Create support ticket
 * POST /api/help/ticket
 */
const createTicket = asyncHandler(async (req, res) => {
  const { subject, message, category, bookingId } = req.body;
  const userId = req.user?.id || req.mechanic?.id;
  const userModel = req.user ? 'User' : 'Mechanic';

  const ticket = await SupportQuery.create({
    userId,
    userModel,
    subject,
    message,
    category: category || 'OTHER',
    bookingId,
    priority: bookingId ? 'HIGH' : 'MEDIUM',
  });

  ApiResponse.created(res, { ticket }, 'Support ticket created. We will get back to you soon.');
});

/**
 * Get user's tickets
 * GET /api/help/tickets
 */
const getMyTickets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status } = req.query;
  const skip = (page - 1) * limit;
  const userId = req.user?.id || req.mechanic?.id;

  const filter = { userId };
  if (status) filter.status = status;

  const [tickets, total] = await Promise.all([
    SupportQuery.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('assignedTo', 'name'),
    SupportQuery.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, tickets, {
    page: parseInt(page),
    limit: parseInt(limit),
    total,
  });
});

/**
 * Get ticket details
 * GET /api/help/ticket/:id
 */
const getTicketDetails = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.mechanic?.id;

  const ticket = await SupportQuery.findOne({
    _id: req.params.id,
    userId,
  }).populate('assignedTo', 'name');

  if (!ticket) {
    return ApiResponse.notFound(res, 'Ticket not found');
  }

  ApiResponse.success(res, { ticket });
});

/**
 * Add reply to ticket (user)
 * POST /api/help/ticket/:id/reply
 */
const addTicketReply = asyncHandler(async (req, res) => {
  const { message } = req.body;
  const userId = req.user?.id || req.mechanic?.id;

  const ticket = await SupportQuery.findOne({
    _id: req.params.id,
    userId,
  });

  if (!ticket) {
    return ApiResponse.notFound(res, 'Ticket not found');
  }

  if (ticket.status === 'CLOSED') {
    return ApiResponse.badRequest(res, 'Cannot reply to a closed ticket');
  }

  // Add reply (if you have a replies array in the schema)
  // For now, we'll just update the message
  ticket.message += `\n\n--- User Reply (${new Date().toLocaleString()}) ---\n${message}`;
  ticket.status = 'OPEN'; // Reopen if it was resolved
  await ticket.save();

  ApiResponse.success(res, { ticket }, 'Reply added');
});

/**
 * Get contact info
 * GET /api/help/contact
 */
const getContactInfo = asyncHandler(async (req, res) => {
  // This can be moved to a config or database
  const contactInfo = {
    email: 'support@mecfinder.com',
    phone: '+91-9876543210',
    whatsapp: '+91-9876543210',
    hours: 'Mon-Sat: 9 AM - 8 PM',
    address: 'MecFinder Technologies Pvt Ltd, Lucknow, UP, India',
    socialMedia: {
      facebook: 'https://facebook.com/mecfinder',
      twitter: 'https://twitter.com/mecfinder',
      instagram: 'https://instagram.com/mecfinder',
    },
  };

  ApiResponse.success(res, { contact: contactInfo });
});

// Admin functions

/**
 * Create FAQ (admin)
 * POST /api/admin/faq
 */
const createFAQ = asyncHandler(async (req, res) => {
  const faq = await FAQ.create({
    ...req.body,
    createdBy: req.admin.id,
  });

  ApiResponse.created(res, { faq }, 'FAQ created');
});

/**
 * Update FAQ (admin)
 * PUT /api/admin/faq/:id
 */
const updateFAQ = asyncHandler(async (req, res) => {
  const faq = await FAQ.findByIdAndUpdate(
    req.params.id,
    { ...req.body, lastUpdatedBy: req.admin.id },
    { new: true }
  );

  if (!faq) {
    return ApiResponse.notFound(res, 'FAQ not found');
  }

  ApiResponse.success(res, { faq }, 'FAQ updated');
});

/**
 * Delete FAQ (admin)
 * DELETE /api/admin/faq/:id
 */
const deleteFAQ = asyncHandler(async (req, res) => {
  const faq = await FAQ.findByIdAndDelete(req.params.id);

  if (!faq) {
    return ApiResponse.notFound(res, 'FAQ not found');
  }

  ApiResponse.success(res, null, 'FAQ deleted');
});

module.exports = {
  getFAQs,
  searchFAQs,
  markFAQHelpful,
  createTicket,
  getMyTickets,
  getTicketDetails,
  addTicketReply,
  getContactInfo,
  // Admin
  createFAQ,
  updateFAQ,
  deleteFAQ,
};
